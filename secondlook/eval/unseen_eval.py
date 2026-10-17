"""Measure #4: when a pathologist calls a tumour slide benign without ever fixating the
tumour (search miss), does an unseen-tissue alert land on that never-inspected tumour?

Data: PathoGaze experiment I reads on CAMELYON16 test slides that have tumour-probe
scores and expert masks. Coverage rules are fixed in config before looking at misses.

Operating points: alerts = top-2 unseen regions with smoothed risk >= tau. tau is
chosen so the mean number of alerts per benign read is <= budget (0.5, 1.0, 2.0),
by nested slide-grouped CV (tau fit on other folds' slides, applied to held-out slides).

Baselines at the same per-read alert counts: random unseen tissue, densest unseen
area, the same AI ignoring the gaze log, a colour-histogram control model, and a
colleague's read (another pathologist's call on the same slide).
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np
import pandas as pd

from secondlook.config import DEFAULT_COVERAGE, RAW_DIR, bundle_paths
from secondlook.core.coverage import compute
from secondlook.eval.stats import ci, group_bootstrap, write_eval
from secondlook.geometry import TileGrid
from secondlook.ids import stable_fold
from secondlook.pipeline.datasets.pathogaze import is_benign_call, load as load_pathogaze
from secondlook.pipeline.regions import find_regions, smoothed
from secondlook.store import db

TAUS = np.round(np.arange(0.20, 1.0001, 0.025), 3)
BUDGETS = (0.5, 1.0, 2.0)
MAX_ALERTS = 2
VARIANTS = {
    "gaze_r5_m10": dict(mode="gaze", radius_deg=5.0, min_magnification=10.0),   # primary, fixed in advance
    "gaze_r3_m10": dict(mode="gaze", radius_deg=3.0, min_magnification=10.0),
    "gaze_r8_m10": dict(mode="gaze", radius_deg=8.0, min_magnification=10.0),
    "gaze_r5_m5": dict(mode="gaze", radius_deg=5.0, min_magnification=5.0),
    "gaze_r5_m20": dict(mode="gaze", radius_deg=5.0, min_magnification=20.0),
    "viewport_m10": dict(mode="viewport", min_magnification=10.0),
}


class SlideCtx:
    def __init__(self, paths, row):
        sid = row["slide_id"]
        self.sid = sid
        self.grid = TileGrid(row["width"], row["height"], row["mpp"], row["tile_w0"])
        self.tiles = pd.read_parquet(paths.tiles(sid))
        sc = pd.read_parquet(paths.scores(sid))
        lab = pd.read_parquet(paths.eval_dir / "labels" / f"{sid}.parquet")
        assert (sc.tile_id.to_numpy() == self.tiles.tile_id.to_numpy()).all()
        assert (lab.tile_id.to_numpy() == self.tiles.tile_id.to_numpy()).all()
        self.rows, self.cols = self.tiles.row.to_numpy(), self.tiles.col.to_numpy()
        self.tissue = ~self.tiles.art_blank.to_numpy()
        self.tumor = (lab.tumor_overlap.to_numpy() > 0) & self.tissue
        self.risk = np.nan_to_num(sc.tumor_prob_smooth.to_numpy(), nan=0.0)
        self.control = None
        if "tumor_prob_colorhist" in sc:
            self.control = np.nan_to_num(smoothed(self.tiles, np.where(self.tissue, sc.tumor_prob_colorhist.to_numpy(), np.nan),
                                                  self.grid.shape), nan=0.0)
        self.lut = np.full(self.grid.shape, -1, np.int64)
        self.lut[self.rows, self.cols] = np.arange(len(self.tiles))
        self.label = row["slide_label"]

    def grid_of(self, v, mask):
        g = np.full(self.grid.shape, np.nan)
        g[self.rows, self.cols] = np.where(mask, v, np.nan)
        return g

    def hits(self, regions, target):
        return [bool(target[self.lut[r.rows, r.cols]].any()) for r in regions]


def alert_curve(ctx: SlideCtx, risk: np.ndarray, seen: np.ndarray, target: np.ndarray, ignore_log=False):
    """For each tau: (number of alerts, hit) with alerts = top-2 regions at seed tau."""
    mask = ctx.tissue if ignore_log else (ctx.tissue & ~seen)
    g = ctx.grid_of(risk, mask)
    fin = np.isfinite(g)
    n, h = [], []
    for tau in TAUS:
        regs = find_regions(g, fin, tau, ctx.grid, max_regions=MAX_ALERTS)
        n.append(len(regs))
        h.append(any(ctx.hits(regs, target)))
    return np.array(n), np.array(h)


def random_unseen_hit(ctx, seen, target, k, rng, draws=20):
    if k == 0:
        return 0.0
    cand = np.nonzero(ctx.tissue & ~seen)[0]
    if not len(cand):
        return 0.0
    hit = 0
    for _ in range(draws):
        pick = rng.choice(cand, min(k, len(cand)), replace=False)
        hit += any(_window_hit(ctx, i, target) for i in pick)
    return hit / draws


def _window_hit(ctx, i, target, half=1):
    r, c = ctx.rows[i], ctx.cols[i]
    idx = ctx.lut[max(0, r - half): r + half + 1, max(0, c - half): c + half + 1].ravel()
    idx = idx[idx >= 0]
    return bool(target[idx].any())


def densest_unseen_hit(ctx, seen, target, k):
    """'Largest unseen area' baseline: the k tiles whose 5x5 neighbourhood holds the most
    unseen tissue (non-overlapping), each alerted as a 3x3 window."""
    if k == 0:
        return False
    from scipy.ndimage import uniform_filter

    u = np.zeros(ctx.grid.shape)
    m = ctx.tissue & ~seen
    u[ctx.rows[m], ctx.cols[m]] = 1
    dens = uniform_filter(u, size=5, mode="constant")
    dens[u == 0] = -1
    hits = False
    for _ in range(k):
        r, c = np.unravel_index(np.argmax(dens), dens.shape)
        if dens[r, c] <= 0:
            break
        i = ctx.lut[r, c]
        hits |= _window_hit(ctx, i, target)
        dens[max(0, r - 2): r + 3, max(0, c - 2): c + 3] = -1
    return hits


def run(variants=None, folds: int = 5, reps: int = 500) -> dict:
    paths = bundle_paths()
    con = db.connect(paths.db)
    slides = db.all_(con, "SELECT * FROM slides WHERE dataset='camelyon16' AND split='test' AND status='ok'")
    con.close()
    slides = [s for s in slides if paths.scores(s["slide_id"]).exists()
              and (paths.eval_dir / "labels" / f"{s['slide_id']}.parquet").exists()]
    if not slides:
        return write_eval(paths.eval_dir / "unseen.json", {"title": "Unseen-tissue alerts", "measure": "#4 attention",
                          "headline": [], "caveats": ["no scored PathoGaze slides with labels yet"]})
    ctxs = {s["slide_id"]: SlideCtx(paths, s) for s in slides}
    reads, events, _ = load_pathogaze(RAW_DIR / "pathogaze")
    reads = reads[reads.slide_id.isin(ctxs)]
    ev_by_read = {k: v for k, v in events[events.read_id.isin(set(reads.read_id))].groupby("read_id")}
    variants = variants or list(VARIANTS)
    rng = np.random.default_rng(0)
    out_variants = {}
    for vname in variants:
        params = replace(DEFAULT_COVERAGE, **VARIANTS[vname])
        recs = []
        for r in reads.itertuples():
            ctx = ctxs[r.slide_id]
            ev = ev_by_read.get(r.read_id)
            cov = compute(ev if ev is not None else pd.DataFrame(), ctx.grid, ctx.rows, ctx.cols, params)
            seen = cov.seen
            benign = is_benign_call(r.decision)
            tumor_slide = ctx.label == "tumor"
            unseen_tumor = ctx.tumor & ~seen
            rec = {"read_id": r.read_id, "slide_id": r.slide_id, "reader": r.participant, "benign_call": benign,
                   "tumor_slide": tumor_slide, "tumor_size": r.tumor_size,
                   "seen_share": float((seen & ctx.tissue).sum() / max(ctx.tissue.sum(), 1))}
            if tumor_slide:
                dwell = float(cov.dwell_ms[ctx.tumor].sum())
                looked = bool(seen[ctx.tumor].any())
                rec["miss_type"] = None if not benign else (
                    "search" if not looked else "recognition" if dwell < params.recognition_ms else "decision")
            if benign:
                n_ai, h_ai = alert_curve(ctx, ctx.risk, seen, unseen_tumor)
                n_ig, h_ig = alert_curve(ctx, ctx.risk, seen, unseen_tumor, ignore_log=True)
                rec.update(n_ai=n_ai, h_ai=h_ai, n_ig=n_ig, h_ig=h_ig)
                if ctx.control is not None:
                    n_c, h_c = alert_curve(ctx, ctx.control, seen, unseen_tumor)
                    rec.update(n_ctrl=n_c, h_ctrl=h_c)
                rec["_seen"] = seen
            recs.append(rec)
        df = pd.DataFrame(recs)
        out_variants[vname] = evaluate_variant(df, ctxs, reads, folds, reps, rng)
        print(f"[unseen] {vname}: {out_variants[vname]['summary']}", flush=True)
    primary = out_variants.get("gaze_r5_m10") or next(iter(out_variants.values()))
    light = fit_light_thresholds(primary)  # before build_doc drops the fit matrix
    doc = build_doc(primary, out_variants, len(ctxs), slides)
    doc["deployed_light_thresholds"] = light
    write_eval(paths.eval_dir / "unseen.json", doc)
    return doc


def _tau_for_budget(n_matrix: np.ndarray, budget: float) -> float:
    """Smallest tau whose mean alerts per benign read <= budget (n_matrix: reads x taus)."""
    if len(n_matrix) == 0:
        return float(TAUS[-1])
    mean = n_matrix.mean(axis=0)
    ok = np.nonzero(mean <= budget)[0]
    return float(TAUS[ok[0]]) if len(ok) else float(TAUS[-1])


def evaluate_variant(df, ctxs, reads, folds, reps, rng) -> dict:
    ben = df[df.benign_call].reset_index(drop=True)
    tum_benign = df[df.tumor_slide & df.benign_call]
    miss = ben[ben.miss_type == "search"].index.to_numpy() if "miss_type" in ben else np.array([], int)
    typology = tum_benign.miss_type.value_counts().to_dict() if len(tum_benign) else {}
    fold_of = {s: stable_fold(s, folds) for s in ctxs}
    ben_fold = ben.slide_id.map(fold_of).to_numpy()
    N = np.stack(ben.n_ai.to_numpy()) if len(ben) else np.zeros((0, len(TAUS)))
    H = np.stack(ben.h_ai.to_numpy()) if len(ben) else np.zeros((0, len(TAUS)), bool)
    result = {"n_reads": int(len(df)), "n_benign_reads": int(len(ben)), "n_tumor_benign_reads": int(len(tum_benign)),
              "n_search_miss": int(len(miss)), "miss_typology": typology,
              "search_miss_share": float(len(miss) / len(tum_benign)) if len(tum_benign) else None,
              "mean_seen_share": float(df.seen_share.mean()), "budgets": {}}
    for b in BUDGETS:
        tau_idx = np.zeros(len(ben), int)
        taus = {}
        for f in range(folds):
            test = ben_fold == f
            if not test.any():
                continue
            tau = _tau_for_budget(N[~test], b)                 # fit on other folds' slides only
            taus[f] = tau
            tau_idx[test] = int(np.argmin(np.abs(TAUS - tau)))
        rows = np.arange(len(ben))
        n_alerts = N[rows, tau_idx]
        hit_ai = H[rows, tau_idx].astype(float)
        hit_ig = np.stack(ben.h_ig.to_numpy())[rows, tau_idx].astype(float) if len(ben) else hit_ai
        base = {"ai_unseen": hit_ai}
        # ignoring the log: same AI, regions over all tissue, matched counts via the same tau
        base["ai_ignoring_log"] = hit_ig
        if "h_ctrl" in ben:
            Hc = np.stack(ben.h_ctrl.to_numpy())
            base["colorhist_control"] = Hc[rows, tau_idx].astype(float)
        rnd, dense = np.zeros(len(ben)), np.zeros(len(ben))
        for i in miss:
            ctx = ctxs[ben.slide_id.iat[i]]
            seen = ben._seen.iat[i]
            target = ctx.tumor & ~seen
            k = int(n_alerts[i])
            rnd[i] = random_unseen_hit(ctx, seen, target, k, rng)
            dense[i] = float(densest_unseen_hit(ctx, seen, target, k))
        base["random_unseen"] = rnd
        base["densest_unseen"] = dense
        # colleague: another pathologist reading the same slide calls it non-benign
        coll = np.zeros(len(ben))
        for i in miss:
            others = reads[(reads.slide_id == ben.slide_id.iat[i]) & (reads.participant != ben.reader.iat[i])]
            coll[i] = float((~others.decision.map(is_benign_call)).mean()) if len(others) else np.nan
        base["colleague_read"] = coll
        entry = {"taus_by_fold": taus, "alerts_per_benign_read": float(n_alerts.mean()),
                 "alerts_per_benign_read_on_benign_slides": float(n_alerts[~ben.tumor_slide.to_numpy()].mean())
                 if (~ben.tumor_slide).any() else None, "catch": {}}
        if len(miss):
            g_slide = ben.slide_id.to_numpy()[miss]
            g_reader = ben.reader.to_numpy()[miss]
            for name, v in base.items():
                vm = v[miss]
                ok = np.isfinite(vm)
                entry["catch"][name] = {
                    "rate": float(np.nanmean(vm)),
                    "ci_by_slide": ci(group_bootstrap(lambda i: np.nanmean(vm[i]), g_slide, len(vm), reps=reps)),
                    "ci_by_reader": ci(group_bootstrap(lambda i: np.nanmean(vm[i]), g_reader, len(vm), reps=reps)),
                    "n": int(ok.sum()),
                    "cost": "one extra full human read" if name == "colleague_read" else "alerts as above"}
        result["budgets"][str(b)] = entry
    b1 = result["budgets"]["1.0"]["catch"].get("ai_unseen", {})
    result["summary"] = {"search_misses": result["n_search_miss"], "catch_at_1": b1.get("rate"),
                         "alerts_per_read": result["budgets"]["1.0"]["alerts_per_benign_read"]}
    result["_fit_matrix"] = N  # used to fit deployed light thresholds (not serialised)
    return result


def fit_light_thresholds(primary: dict) -> dict | None:
    import json

    N = primary.pop("_fit_matrix", None)
    if N is None or len(N) == 0:
        return None
    paths = bundle_paths()
    th = json.loads(paths.thresholds.read_text()) if paths.thresholds.exists() else {}
    lo, hi = _tau_for_budget(N, 1.0), _tau_for_budget(N, 0.5)
    th["light"] = {"lo": lo, "hi": max(hi, lo), "source": f"pathogaze_fit:{len(N)}_benign_reads:budgets_1.0_and_0.5",
                   "note": "amber = <=1.0 alert per benign read, red = <=0.5; reported catch rates use nested CV"}
    paths.thresholds.write_text(json.dumps(th, indent=1))
    return th["light"]


def build_doc(primary, variants, n_slides, slides) -> dict:
    for v in variants.values():
        v.pop("_fit_matrix", None)
    head, caveats = [], []
    n_tumor_slides = sum(1 for s in slides if s["slide_label"] == "tumor")
    head.append({"label": "Benign calls on tumour slides that were search misses (never fixated tumour)",
                 "value": f"{primary['n_search_miss']}/{primary['n_tumor_benign_reads']}"
                          + (f" ({primary['search_miss_share']:.0%})" if primary["search_miss_share"] is not None else ""),
                 "note": f"miss types: {primary['miss_typology']}; the abstract reported 67.5%"})
    for b in BUDGETS:
        e = primary["budgets"][str(b)]
        ai = e["catch"].get("ai_unseen")
        if not ai:
            continue
        others = {k: v["rate"] for k, v in e["catch"].items() if k != "ai_unseen"}
        head.append({"label": f"Search misses caught at <= {b} alert regions per benign read",
                     "value": f"{ai['rate']:.0%}", "ci": f"by slide {ai['ci_by_slide'][0]:.0%}-{ai['ci_by_slide'][1]:.0%}",
                     "status": "info",
                     "note": f"realised {e['alerts_per_benign_read']:.2f} alerts/read; baselines: " +
                             ", ".join(f"{k} {v:.0%}" for k, v in others.items() if v == v)})
    caveats += [f"Effective sample: {n_slides} slides ({n_tumor_slides} with tumour), {primary['n_search_miss']} search-miss reads.",
                "Isolated tumour cells are mostly invisible at tile level; expect alerts to work for micro/macro metastases.",
                "Viewport-only coverage is a weaker definition of 'seen' and is reported separately."]
    if n_slides < 30:
        caveats.insert(0, f"Development scale: only {n_slides} of the 60 PathoGaze slides are processed so far; wide CIs.")
    sens = {k: v["summary"] for k, v in variants.items()}
    return {"title": "Unseen-tissue alerts catch search misses", "measure": "#4 attention",
            "dataset": "PathoGaze experiment I (10 pathologists) on CAMELYON16 test slides",
            "headline": head, "caveats": caveats, "primary_variant": "gaze_r5_m10",
            "sensitivity_variants": sens, "primary": primary,
            "variants": {k: {kk: vv for kk, vv in v.items() if kk != "summary"} for k, v in variants.items()}}


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", nargs="*", default=None)
    a = ap.parse_args()
    print(json.dumps(run(a.variants)["headline"], indent=1))
