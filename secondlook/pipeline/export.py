"""Stage 8: write results into the bundle (SQLite + manifests) the laptop app reads."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from secondlook.config import ARTIFACT_SLOW_SHARE, SLOW_PATH_SHARE, BundlePaths
from secondlook.store import db
from secondlook.store.arrays import read_meta


def register_slide(con, *, slide_id, dataset, organ, info=None, image_path=None, split=None, fold=None,
                   slide_label=None, status="ok", status_detail=None) -> None:
    row = {"slide_id": slide_id, "dataset": dataset, "organ": organ, "image_path": str(image_path) if image_path else None,
           "split": split, "fold": fold, "slide_label": slide_label, "status": status, "status_detail": status_detail}
    if info is not None:
        row.update(width=info.width, height=info.height, mpp=info.mpp, tile_w0=info.grid.tile_w0,
                   grid_rows=info.grid.rows, grid_cols=info.grid.cols)
    db.upsert(con, "slides", row)


def register_artifact(con, slide_id: str, artifact_type: str, path: Path, bundle_root: Path, *,
                      model_version=None, preprocessing_version=None, provenance="real", n_rows=None, row_digest=None) -> None:
    path = Path(path)
    if path.suffix == ".npy" and (n_rows is None or row_digest is None):
        meta = read_meta(path)
        n_rows, row_digest = meta["n_rows"], meta["row_digest"]
    try:
        rel = str(path.relative_to(bundle_root)).replace("\\", "/")
    except ValueError:
        rel = str(path)
    db.upsert(con, "artifact_manifests", {
        "slide_id": slide_id, "artifact_type": artifact_type, "file_path": rel, "n_rows": n_rows,
        "row_digest": row_digest, "model_version": model_version, "preprocessing_version": preprocessing_version,
        "provenance": provenance, "created": db.now()})


def write_regions(con, slide_id: str, kind: str, regions, *, source: str, disagreement_grid=None,
                  tile_id_fn=None, read_id=None, id_tag=None) -> list[str]:
    from secondlook.ids import region_id, tile_id

    tile_id_fn = tile_id_fn or (lambda r, c: tile_id(slide_id, r, c))
    if read_id is None:
        con.execute("DELETE FROM regions WHERE slide_id=? AND kind=? AND read_id IS NULL", (slide_id, kind))
    ids = []
    for reg in regions:
        rid = region_id(slide_id, kind, reg.rank, id_tag or read_id)
        dis = None
        if disagreement_grid is not None:
            v = disagreement_grid[reg.rows, reg.cols]
            v = v[np.isfinite(v)]
            dis = float(v.mean()) if len(v) else None
        x, y, w, h = reg.bbox
        db.upsert(con, "regions", {"region_id": rid, "slide_id": slide_id, "kind": kind, "x": x, "y": y, "w": w, "h": h,
                                   "n_tiles": reg.n_tiles, "risk": reg.risk, "disagreement": dis, "rank": reg.rank,
                                   "peak_tile_id": tile_id_fn(reg.peak_row, reg.peak_col), "read_id": read_id,
                                   "source": source})
        ids.append(rid)
    return ids


def tissue_artifact_share(paths: BundlePaths, slide_id: str) -> float | None:
    """Share of tissue tiles flagged blur/ink/fold. Blank glass is not tissue, so it is excluded
    from both sides; None when the slide's tiles are not in the bundle."""
    p = paths.tiles(slide_id)
    if not p.exists():
        return None
    import pandas as pd

    t = pd.read_parquet(p, columns=["art_blank", "art_blur", "art_ink", "art_fold"])
    tissue = ~t["art_blank"].to_numpy(bool)
    if not tissue.any():
        return None
    bad = (t["art_blur"] | t["art_ink"] | t["art_fold"]).to_numpy(bool)
    return float(bad[tissue].mean())


def assign_tiers(con, paths: BundlePaths) -> dict:
    """Fast/slow tier per case. Uses the validation-derived cutoff when present; otherwise
    falls back to rank-based top-15% and records that the cutoff is not validated.
    A case whose tissue is heavily damaged (blur/ink/fold on >= ARTIFACT_SLOW_SHARE of tissue
    tiles) also goes to the slow path: the models are least trustworthy there."""
    cutoff, signal = None, "disagreement"
    if paths.thresholds.exists():
        th = json.loads(paths.thresholds.read_text())
        cutoff = th.get("tier_cutoff")
        signal = (th.get("routing_signal") or {}).get("signal", "disagreement")
    col = "uncertainty_score" if signal == "entropy" else "disagreement_score"
    cases = [{"case_id": c["case_id"], "disagreement_score": c[col],
              "artifacts": tissue_artifact_share(paths, c["slide_id"])}
             for c in db.all_(con, f"SELECT case_id, slide_id, {col} FROM cases")]
    con.execute("UPDATE cases SET routing_signal=?", (signal,))
    scored = [c for c in cases if c["disagreement_score"] is not None]
    if cutoff is None and scored:
        vals = np.array([c["disagreement_score"] for c in scored])
        n_slow = max(1, int(round(SLOW_PATH_SHARE * len(vals))))
        order = np.argsort(-vals, kind="stable")
        slow = {scored[i]["case_id"] for i in order[:n_slow]}
        rule = "rank_top15"
    else:
        slow = {c["case_id"] for c in scored if c["disagreement_score"] >= cutoff}
        rule = "validation_cutoff"
    n_artifact = 0
    for c in cases:
        reasons = [signal] if c["case_id"] in slow else []
        if c["artifacts"] is not None and c["artifacts"] >= ARTIFACT_SLOW_SHARE:
            reasons.append("artifacts")
            n_artifact += 1
        if reasons:
            tier = "slow"
        elif c["disagreement_score"] is None:
            tier = "unavailable"
        else:
            tier = "fast"
        con.execute("UPDATE cases SET tier=?, tier_rule=?, tier_reasons=?, tissue_artifact_share=? WHERE case_id=?",
                    (tier, "unavailable" if tier == "unavailable" else rule, ",".join(reasons) or None, c["artifacts"],
                     c["case_id"]))
    con.commit()
    n_slow = sum(1 for c in db.all_(con, "SELECT tier FROM cases") if c["tier"] == "slow")
    return {"rule": rule, "signal": signal, "cutoff": cutoff, "n_slow": n_slow, "n_slow_artifacts": n_artifact,
            "artifact_share_cutoff": ARTIFACT_SLOW_SHARE, "n_cases": len(cases)}


def write_manifest(paths: BundlePaths, update: dict) -> dict:
    m = json.loads(paths.manifest.read_text()) if paths.manifest.exists() else {}
    for k, v in update.items():
        if isinstance(v, dict) and isinstance(m.get(k), dict):
            m[k].update(v)
        else:
            m[k] = v
    m["updated"] = db.now()
    paths.manifest.parent.mkdir(parents=True, exist_ok=True)
    paths.manifest.write_text(json.dumps(m, indent=1, default=str))
    return m


if __name__ == "__main__":
    # Re-apply the tier rules to an existing bundle without re-running the pipeline:
    #   python -m secondlook.pipeline.export retier
    import sys

    from secondlook.config import bundle_paths

    if sys.argv[1:] != ["retier"]:
        sys.exit("usage: python -m secondlook.pipeline.export retier")
    _paths = bundle_paths()
    _con = db.init_db(_paths.db)
    print(assign_tiers(_con, _paths))
    _con.close()
