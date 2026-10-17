"""Test fixtures. The synthetic bundle here exists only for tests: it exercises the
API wiring and decision logic with known geometry, and is never shipped."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from secondlook.config import BundlePaths
from secondlook.geometry import TileGrid
from secondlook.ids import sequence_digest, tile_id
from secondlook.pipeline.export import register_artifact, write_regions
from secondlook.pipeline.regions import find_regions, smoothed, to_grid
from secondlook.store import db
from secondlook.store.arrays import write_matrix, write_parquet

SLIDE = "synthetic_001"
CASE = f"case_{SLIDE}"
SLOW_SLIDE = "synthetic_slow"


def _make_slide(paths: BundlePaths, con, slide_id: str, tier: str, hot_rc=(8, 15)):
    grid = TileGrid(width=10_000, height=6_000, mpp=0.25, tile_w0=448)  # 23 x 14 grid
    rows, cols = np.mgrid[0:grid.rows, 0:grid.cols]
    rows, cols = rows.ravel(), cols.ravel()
    keep = (cols >= 2) & (cols <= 20) & (rows >= 1) & (rows <= 12)   # tissue block
    rows, cols = rows[keep], cols[keep]
    n = len(rows)
    tids = [tile_id(slide_id, r, c) for r, c in zip(rows, cols)]
    tiles = pd.DataFrame({"tile_id": tids, "slide_id": slide_id, "row": rows, "col": cols,
                          "x": cols * grid.tile_w0, "y": rows * grid.tile_w0, "w0": grid.tile_w0,
                          "tissue_fraction": 1.0, "embedding_row": np.arange(n),
                          "art_blank": False, "art_blur": False, "art_ink": cols == 20, "art_fold": False,
                          "lap_var": 500.0, "ink_frac": 0.0, "blank_frac": 0.0})
    tiles["artifact"] = tiles["art_ink"]
    hr, hc = hot_rc
    p = np.exp(-(((rows - hr) ** 2 + (cols - hc) ** 2) / 3.0)) * 0.95
    sd = paths.slide_dir(slide_id)
    sd.mkdir(parents=True, exist_ok=True)
    scores = pd.DataFrame({"tile_id": tids, "tumor_prob": p})
    scores["tumor_prob_smooth"] = smoothed(tiles, p, grid.shape)
    scores["feat_metastasis_raw"] = p * 0.8 + 0.1
    scores["feat_metastasis_cal"] = p
    scores["feat_irregular_nuclei_raw"] = 0.5
    scores["disagreement"] = np.where(tiles["artifact"], np.nan, np.linspace(0, 1, n))
    write_parquet(tiles, paths.tiles(slide_id))
    write_parquet(scores, paths.scores(slide_id))
    rng = np.random.default_rng(0)
    emb = rng.normal(size=(n, 16)).astype(np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    write_matrix(emb, paths.embedding(slide_id, "quiltnet"), tids, model="quiltnet")
    db.upsert(con, "slides", {"slide_id": slide_id, "dataset": "test", "organ": "lymph_node", "width": grid.width,
                              "height": grid.height, "mpp": grid.mpp, "tile_w0": grid.tile_w0, "grid_rows": grid.rows,
                              "grid_cols": grid.cols, "split": "test", "slide_label": "tumor", "status": "ok"})
    register_artifact(con, slide_id, "tiles", paths.tiles(slide_id), paths.root, n_rows=n, row_digest=sequence_digest(tids))
    g = to_grid(tiles, scores["tumor_prob_smooth"].to_numpy(), grid.shape)
    write_regions(con, slide_id, "evidence", find_regions(g, np.isfinite(g), 0.5, grid), source="test")
    db.upsert(con, "cases", {"case_id": f"case_{slide_id}", "slide_id": slide_id, "disagreement_score": 0.9 if tier == "slow" else 0.3,
                             "tier": tier, "tier_rule": "test", "artifact_share": float(tiles.artifact.mean()),
                             "ai_max_risk": float(np.nanmax(scores.tumor_prob_smooth))})
    return grid, tiles


@pytest.fixture()
def bundle(tmp_path):
    paths = BundlePaths(tmp_path / "bundle")
    con = db.init_db(paths.db)
    grid, tiles = _make_slide(paths, con, SLIDE, "fast")
    _make_slide(paths, con, SLOW_SLIDE, "slow")
    con.commit()
    con.close()
    return paths, grid, tiles


@pytest.fixture()
def client(bundle):
    from fastapi.testclient import TestClient

    from secondlook.api import main
    from secondlook.api.services import coverage as cov_service
    from secondlook.api.store import Store, set_store

    paths, grid, tiles = bundle
    set_store(Store(paths))
    cov_service._cache.clear()
    return TestClient(main.app), grid, tiles
