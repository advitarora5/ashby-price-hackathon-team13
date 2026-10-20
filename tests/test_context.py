"""Spatial context: ring descriptors, attraction statistics and arrangement search."""
import numpy as np
import pandas as pd

from secondlook.ids import tile_id
from secondlook.pipeline import context as ctx
from tests.conftest import CASE, SLIDE, SLOW_SLIDE

H = W = 42


def _tiles(rows, cols):
    return pd.DataFrame({"row": rows, "col": cols, "art_blank": False, "artifact": False})


def _planted(seed=1):
    """Tumour spots (radius 1.5 tiles) each wrapped in a one-tile ring of lymphocytes; a third feature is noise."""
    rng = np.random.default_rng(seed)
    R, C = np.mgrid[0:H, 0:W]
    R, C = R.ravel(), C.ravel()
    tum = 0.1 + 0.05 * rng.random(len(R))
    lym = 0.1 + 0.05 * rng.random(len(R))
    for cr, cc in rng.integers(3, H - 3, size=(30, 2)):
        d = np.hypot(R - cr, C - cc)
        tum[d <= 1.5] = 0.9
        lym[(d > 1.5) & (d <= 2.5)] = 0.9
    noise = rng.random(len(R))
    return _tiles(R, C), np.stack([tum, lym, noise], axis=1)


def _attraction(tiles, values):
    valid = ctx.valid_tiles(tiles, values)
    desc = ctx.ring_descriptors(tiles, values, valid, (H, W))
    return desc, ctx.attraction(tiles, desc, valid, (H, W))


def test_planted_immune_ring_is_found_and_noise_is_not():
    tiles, values = _planted()
    _, a = _attraction(tiles, values)
    assert a["ratio"][0, 1, 1] > 1.5 and a["q"][0, 1, 1] < 0.05     # lymphocytes touch tumour
    assert a["q"][0, 1, 2] > 0.05                                     # noise does not
    assert np.isnan(a["ratio"][0, 0, 0])                              # a feature with itself, same tile: undefined


def test_shuffled_layout_has_no_attraction():
    tiles, values = _planted()
    values[:, 0] = np.random.default_rng(3).permutation(values[:, 0])
    _, a = _attraction(tiles, values)
    assert 0.8 < a["ratio"][0, 1, 1] < 1.2


def test_descriptor_does_not_depend_on_slide_orientation():
    tiles, values = _planted()
    valid = ctx.valid_tiles(tiles, values)
    d = ctx.ring_descriptors(tiles, values, valid, (H, W))
    turned = _tiles(tiles["col"].to_numpy(), H - 1 - tiles["row"].to_numpy())   # rotate 90 degrees
    d2 = ctx.ring_descriptors(turned, values, valid, (W, H))
    assert np.allclose(d, d2, atol=1e-5)


def test_context_api_respects_blind_gate_and_searches_other_slides(client, bundle, monkeypatch):
    c, _, _ = client
    paths, _, _ = bundle
    monkeypatch.setattr(ctx, "MIN_HIGH", 3)   # the test slide has only 5 probable-tumour tiles
    assert not c.get(f"/api/cases/{CASE}/context/correlation").json()["available"]   # not built yet
    out = ctx.build(paths)
    assert set(out["slides"]) == {SLIDE, SLOW_SLIDE}
    corr = c.get(f"/api/cases/{CASE}/context/correlation").json()
    assert corr["available"] and [f["id"] for f in corr["features"]] == ["metastasis", "irregular_nuclei"]
    assert c.get(f"/api/cases/case_{SLOW_SLIDE}/context/correlation").json()["hidden"]
    hot = tile_id(SLIDE, 8, 15)
    s = c.get(f"/api/cases/{CASE}/context/similar", params={"tile": hot}).json()
    assert s["available"] and s["matches"]
    assert all(m["slide_id"] == SLOW_SLIDE and m["case_id"] == f"case_{SLOW_SLIDE}" for m in s["matches"])
    ink = tile_id(SLIDE, 5, 20)   # damaged tile: not searchable
    assert not c.get(f"/api/cases/{CASE}/context/similar", params={"tile": ink}).json()["available"]
    p = c.get(f"/api/cases/{CASE}/context/pair", params={"x": "metastasis", "y": "metastasis", "ring": 1}).json()
    assert p["n_tiles"] > 0 and p["tiles"][0]["w"] == 448


def test_calibrated_feature_absent_from_slide_is_skipped():
    tiles, values = _planted()
    values[:, 0] = 0.02                              # no tile is probably tumour
    values[0, 0] = 0.03
    valid = ctx.valid_tiles(tiles, values)
    desc = ctx.ring_descriptors(tiles, values, valid, (H, W))
    a = ctx.attraction(tiles, desc, valid, (H, W), calibrated=[True, False, False])
    assert a["n_high"][0] == 0 and np.isnan(a["ratio"][0]).all()
    assert a["n_high"][1] > 0                        # uncalibrated features still use their top 20%
