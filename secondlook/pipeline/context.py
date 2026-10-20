"""Spatial context ("Scan Context for tissue"). Optional and self-contained.

Each tissue tile is described by the mean of every feature score in rings of
neighbouring tiles (ring 0 is the tile itself), like a LiDAR Scan Context
descriptor describes a place by what surrounds it. From those descriptors:

  attraction  for features X, Y and ring r: mean of Y in ring r around tiles
              high in X, divided by the mean of Y in
              ring r around all tissue tiles. >1 = Y gathers around X, <1 = Y
              avoids X. Null: random toroidal shifts of the high-X mask, which
              keep each feature's own clumping; Benjamini-Hochberg q-values.
              "High in X": calibrated probability >= 0.5 when X has a calibrator
              (skipped if fewer than MIN_HIGH tiles reach it: X is essentially
              absent), else the top 20% of X's text-prior score.
  search      "find similar arrangements": FAISS over ring keys (each ring of the
              descriptor centred on the bundle-wide mean and L2-normalised), then
              re-ranked by distance on the full descriptor.

Writes only under <bundle>/context/. To remove the feature: delete that folder,
this module, api/services/context.py and its router line in api/main.py, and
frontend/src/components/ContextPanel.tsx with its mount in App.tsx.

    python -m secondlook.pipeline.context        # build for every slide in the bundle
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.config import RNG_SEED, BundlePaths
from secondlook.pipeline.regions import to_grid
from secondlook.store.arrays import read_matrix, read_parquet, write_matrix, write_parquet

RINGS = ((-0.5, 0.5), (0.5, 1.5), (1.5, 3.5), (3.5, 6.5))  # (inner, outer] distance in tiles
RING_LABELS = ("this spot", "touching it", "2-3 tiles away", "4-6 tiles away")
HIGH_QUANTILE = 0.80
HIGH_PROBABILITY = 0.5
MIN_HIGH = 8
N_SHIFTS = 199
INDEX_PER_SLIDE = 3000
RECIPE = "context_v1"


def context_dir(paths: BundlePaths) -> Path:
    return paths.root / "context"


def descriptor_path(paths: BundlePaths, slide_id: str) -> Path:
    return context_dir(paths) / f"{slide_id}.npy"


def correlation_path(paths: BundlePaths, slide_id: str) -> Path:
    return context_dir(paths) / f"{slide_id}_corr.json"


def feature_values(scores: pd.DataFrame, feature_ids: list[str]) -> tuple[list[str], np.ndarray, list[bool]]:
    """[n, F] per-tile values: calibrated where a calibrator exists, else the raw text prior."""
    ids, cols, calibrated = [], [], []
    for f in feature_ids:
        c = f"feat_{f}_cal" if f"feat_{f}_cal" in scores else f"feat_{f}_raw"
        if c in scores:
            ids.append(f)
            cols.append(scores[c].to_numpy(dtype=np.float64))
            calibrated.append(c.endswith("_cal"))
    return ids, np.stack(cols, axis=1) if cols else np.zeros((len(scores), 0)), calibrated


def high_cutoffs(own: np.ndarray, calibrated: list[bool] | None = None) -> np.ndarray:
    """Per feature, the value at or above which a tile counts as high in it (see module docstring)."""
    out = np.full(own.shape[1], np.nan)
    for f in range(own.shape[1]):
        v = own[:, f]
        if len(v) == 0 or np.nanstd(v) < 1e-6:
            continue
        if calibrated and calibrated[f]:
            if (v >= HIGH_PROBABILITY).sum() >= MIN_HIGH:   # else: essentially absent on this slide
                out[f] = HIGH_PROBABILITY
        else:
            out[f] = np.quantile(v, HIGH_QUANTILE)
    return out


def valid_tiles(tiles: pd.DataFrame, values: np.ndarray) -> np.ndarray:
    return (~tiles["art_blank"].to_numpy() & ~tiles["artifact"].to_numpy()
            & np.isfinite(values).all(axis=1))


def ring_kernel(lo: float, hi: float) -> np.ndarray:
    r = int(np.floor(hi))
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    d = np.hypot(y, x)
    return ((d > lo) & (d <= hi)).astype(np.float64)


def ring_descriptors(tiles: pd.DataFrame, values: np.ndarray, valid: np.ndarray, shape) -> np.ndarray:
    """[n, R, F]: mean of each feature over the valid tiles in each ring around every tile.
    A ring with no valid tissue (slide edge, glass) reads as 0."""
    from scipy.ndimage import convolve

    w = to_grid(tiles, valid.astype(np.float64), shape, fill=0.0)
    rows, cols = tiles["row"].to_numpy(), tiles["col"].to_numpy()
    out = np.zeros((len(tiles), len(RINGS), values.shape[1]), np.float32)
    for ri, (lo, hi) in enumerate(RINGS):
        k = ring_kernel(lo, hi)
        den = convolve(w, k, mode="constant")[rows, cols]
        for fi in range(values.shape[1]):
            v = to_grid(tiles, np.where(valid, values[:, fi], 0.0), shape, fill=0.0)
            num = convolve(v, k, mode="constant")[rows, cols]
            out[:, ri, fi] = np.where(den > 0, num / np.maximum(den, 1e-9), 0.0)
    return out


def _bh(p: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg q-values over the finite entries of p."""
    q = np.full(p.shape, np.nan)
    ok = np.isfinite(p)
    flat = p[ok]
    if not flat.size:
        return q
    order = np.argsort(flat)
    ranked = flat[order] * flat.size / np.arange(1, flat.size + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    vals = np.empty_like(flat)
    vals[order] = np.minimum(ranked, 1.0)
    q[ok] = vals
    return q


def _shifts(shape, n: int, min_shift: int, rng) -> list[tuple[int, int]]:
    """Random toroidal offsets at least `min_shift` tiles away (wrap-aware) in some direction."""
    h, w = shape
    out, tries = [], 0
    while len(out) < n and tries < n * 50:
        tries += 1
        dr, dc = int(rng.integers(0, h)), int(rng.integers(0, w))
        if max(min(dr, h - dr), min(dc, w - dc)) >= min_shift:
            out.append((dr, dc))
    return out


def attraction(tiles: pd.DataFrame, desc: np.ndarray, valid: np.ndarray, shape, calibrated: list[bool] | None = None,
               n_shifts: int = N_SHIFTS, seed: int = RNG_SEED) -> dict:
    """ratio[X][r][Y] and q[X][r][Y] (see module docstring)."""
    n, R, F = desc.shape
    idx = np.nonzero(valid)[0]
    ratio = np.full((F, R, F), np.nan)
    p = np.full((F, R, F), np.nan)
    n_high = np.zeros(F, int)
    if len(idx) < 20:
        return {"ratio": ratio, "q": p, "n_high": n_high, "high_at": np.full(F, np.nan), "n_shifts": 0}
    base = desc[idx].mean(axis=0)                                  # [R, F]
    base = np.where(base > 1e-9, base, np.nan)
    lut = np.full(shape, -1, np.int64)
    lut[tiles["row"].to_numpy()[idx], tiles["col"].to_numpy()[idx]] = idx
    shifts = _shifts(shape, n_shifts, int(np.ceil(RINGS[-1][1])) + 1, np.random.default_rng(seed))
    own = desc[:, 0, :]
    cut = high_cutoffs(own[idx], calibrated)
    for x in range(F):
        if not np.isfinite(cut[x]):
            continue
        high = idx[own[idx, x] >= cut[x]]
        n_high[x] = len(high)
        obs = desc[high].mean(axis=0) / base                       # [R, F]
        ratio[x] = obs
        mask = np.zeros(shape, bool)
        mask[tiles["row"].to_numpy()[high], tiles["col"].to_numpy()[high]] = True
        null = []
        for dr, dc in shifts:
            hit = lut[np.roll(mask, (dr, dc), axis=(0, 1))]
            hit = hit[hit >= 0]
            if len(hit) >= max(5, len(high) // 4):
                null.append(desc[hit].mean(axis=0) / base)
        if len(null) < 19:
            continue
        ln = np.log(np.stack(null))                                # [S, R, F]
        centre = np.nanmedian(ln, axis=0)
        dev_obs = np.abs(np.log(obs) - centre)
        dev_null = np.abs(ln - centre)
        p[x] = (1 + (dev_null >= dev_obs).sum(axis=0)) / (1 + len(null))
    for x in range(F):           # same-tile pairs of a feature with itself carry no information
        p[x, 0, x] = np.nan
        ratio[x, 0, x] = np.nan
    return {"ratio": ratio, "q": _bh(p), "n_high": n_high, "high_at": cut, "n_shifts": len(shifts)}


def ring_keys(desc: np.ndarray, baseline: np.ndarray) -> np.ndarray:
    """Scan Context's compact key: each ring centred on the bundle mean, L2-normalised. [n, R*F] unit rows."""
    c = desc.astype(np.float32) - baseline.astype(np.float32)
    c /= np.maximum(np.linalg.norm(c, axis=2, keepdims=True), 1e-6)
    return np.ascontiguousarray(c.reshape(len(c), -1) / np.sqrt(desc.shape[1]), dtype=np.float32)


def summarize(d: np.ndarray, baseline: np.ndarray, labels: list[str], top: int = 2) -> list[dict]:
    """Plain-English reading of one [R, F] descriptor: per ring, the features clearly above the bundle mean."""
    out = []
    for ri in range(d.shape[0]):
        lift = d[ri] - baseline[ri]
        rel = d[ri] / np.maximum(baseline[ri], 1e-6)
        keep = [i for i in np.argsort(-lift) if lift[i] >= 0.08 and rel[i] >= 1.3][:top]
        out.append({"ring": RING_LABELS[ri], "features": [labels[i] for i in keep]})
    return out


# --------------------------------------------------------------------------- build
def build_slide(paths: BundlePaths, slide: dict, feature_ids: list[str], labels: dict[str, str]):
    sid = slide["slide_id"]
    tiles = read_parquet(paths.tiles(sid))
    scores = read_parquet(paths.scores(sid))
    if len(scores) != len(tiles) or not (scores["tile_id"].to_numpy() == tiles["tile_id"].to_numpy()).all():
        raise ValueError(f"{sid}: scores not aligned with tiles")
    ids, values, calibrated = feature_values(scores, feature_ids)
    shape = (int(slide["grid_rows"]), int(slide["grid_cols"]))
    valid = valid_tiles(tiles, values)
    desc = ring_descriptors(tiles, values, valid, shape)
    desc[~valid] = np.nan
    write_matrix(desc.reshape(len(desc), -1), descriptor_path(paths, sid), tiles["tile_id"], model=RECIPE,
                 dtype=np.float32, extra={"features": ids, "rings": len(RINGS)})
    a = attraction(tiles, np.nan_to_num(desc), valid, shape, calibrated)
    um = float(slide["tile_w0"]) * float(slide["mpp"])
    corr = {"recipe": RECIPE, "features": [{"id": f, "label": labels.get(f, f)} for f in ids],
            "rings": [{"label": RING_LABELS[i], "um": [max(0.0, lo) * um, hi * um]} for i, (lo, hi) in enumerate(RINGS)],
            "n_shifts": a["n_shifts"], "n_high": a["n_high"].tolist(), "high_at": np.round(a["high_at"], 4).tolist(),
            "calibrated": calibrated,
            "ratio": np.round(a["ratio"], 4).tolist(), "q": np.round(a["q"], 4).tolist()}
    correlation_path(paths, sid).write_text(json.dumps(corr).replace("NaN", "null"))
    return ids, tiles, desc, valid


def build(paths: BundlePaths, seed: int = RNG_SEED) -> dict:
    from secondlook.pipeline.features import load_features
    from secondlook.store import db

    feats = load_features()[1]
    labels = {f.id: f.label for f in feats}
    con = db.connect(paths.db)
    try:
        slides = db.all_(con, "SELECT * FROM slides WHERE status='ok' ORDER BY slide_id")
    finally:
        con.close()
    rng = np.random.default_rng(seed)
    metas, rows, ids_ref, done, skipped = [], [], None, [], []
    for s in slides:
        if not paths.scores(s["slide_id"]).exists():
            skipped.append(s["slide_id"])
            continue
        ids, tiles, desc, valid = build_slide(paths, s, [f.id for f in feats], labels)
        if ids_ref is None:
            ids_ref = ids
        if ids != ids_ref:
            skipped.append(s["slide_id"])   # different feature set: kept for its heatmap, not searchable
            continue
        keep = np.nonzero(valid)[0]
        if len(keep) > INDEX_PER_SLIDE:
            keep = np.sort(rng.choice(keep, INDEX_PER_SLIDE, replace=False))
        metas.append(pd.DataFrame({"slide_id": s["slide_id"], "tile_id": tiles["tile_id"].to_numpy()[keep],
                                   "tile_index": keep}))
        rows.append(desc[keep].reshape(len(keep), -1))
        done.append(s["slide_id"])
    if rows:
        meta = pd.concat(metas, ignore_index=True)
        mat = np.concatenate(rows).astype(np.float32)
        baseline = mat.reshape(len(mat), len(RINGS), -1).mean(axis=0)
        write_parquet(meta, context_dir(paths) / "index.parquet")
        write_matrix(mat, context_dir(paths) / "index.npy", meta["slide_id"] + "/" + meta["tile_id"],
                     model=RECIPE, dtype=np.float32)
        (context_dir(paths) / "index.json").write_text(json.dumps(
            {"recipe": RECIPE, "features": ids_ref, "labels": [labels[f] for f in ids_ref],
             "rings": list(RING_LABELS), "baseline": np.round(baseline, 6).tolist()}))
    return {"slides": done, "skipped": skipped}


class ContextIndex:
    """FAISS over ring keys of the indexed tiles, with exact re-ranking on the full descriptor."""

    def __init__(self, paths: BundlePaths):
        self.dir = context_dir(paths)
        self.meta = self.mat = self.index = None
        self.info: dict = {}

    def available(self) -> bool:
        return (self.dir / "index.json").exists() and (self.dir / "index.npy").exists()

    def load(self) -> "ContextIndex":
        import faiss

        self.info = json.loads((self.dir / "index.json").read_text())
        self.meta = read_parquet(self.dir / "index.parquet")
        flat = np.asarray(read_matrix(self.dir / "index.npy", self.meta["slide_id"] + "/" + self.meta["tile_id"],
                                      mmap=False), dtype=np.float32)
        self.mat = flat.reshape(len(flat), len(RINGS), -1)
        self.baseline = np.asarray(self.info["baseline"], dtype=np.float32)
        keys = ring_keys(self.mat, self.baseline)
        self.index = faiss.IndexFlatIP(keys.shape[1])
        self.index.add(keys)
        return self

    def search(self, d: np.ndarray, exclude_slide: str, k: int = 5, per_slide: int = 2, overfetch: int = 400) -> list[dict]:
        q = ring_keys(d[None], self.baseline)
        sims, ids = self.index.search(q, min(overfetch, self.index.ntotal))
        cand = [(int(i), float(s)) for i, s in zip(ids[0], sims[0])
                if i >= 0 and self.meta.slide_id.iat[int(i)] != exclude_slide]
        if not cand:
            return []
        rows = np.array([c[0] for c in cand])
        dist = np.linalg.norm((self.mat[rows] - d[None]).reshape(len(rows), -1), axis=1)
        out, per = [], {}
        for j in np.argsort(dist):
            i, s = cand[j]
            sid = self.meta.slide_id.iat[i]
            if per.get(sid, 0) >= per_slide:
                continue
            per[sid] = per.get(sid, 0) + 1
            out.append({"slide_id": sid, "tile_id": self.meta.tile_id.iat[i], "tile_index": int(self.meta.tile_index.iat[i]),
                        "shape_similarity": round(max(s, 0.0), 4), "distance": round(float(dist[j]), 4),
                        "summary": summarize(self.mat[i], self.baseline, self.info["labels"])})
            if len(out) == k:
                break
        return out


if __name__ == "__main__":
    from secondlook.config import bundle_paths

    print(build(bundle_paths()))
