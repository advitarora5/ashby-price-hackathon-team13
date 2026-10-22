"""Concept explanations: a tumour probe built along one text concept is explained by that concept,
benign tiles are not, and blind reads stay blind."""
import numpy as np

from secondlook.config import PRIMARY_MODEL
from secondlook.pipeline import concepts as cx
from secondlook.pipeline.probes import fit_probe
from tests.conftest import CASE, SLOW_SLIDE

D = 8


def _setup(paths, tiles):
    """Toy CONCH space: axis 0 = 'tumour cells' concept, axis 1 = 'fat', others noise.
    The first 30 tissue tiles are tumour (high on axis 0)."""
    from secondlook.store.arrays import write_matrix

    rng = np.random.default_rng(0)
    eye = np.eye(D, dtype=np.float32)
    d = paths.models_dir / "text_banks"
    d.mkdir(parents=True, exist_ok=True)
    protos = np.stack([np.stack([eye[0] + eye[2], eye[2]]), np.stack([eye[1] + eye[3], eye[3]])])
    np.savez(d / f"{PRIMARY_MODEL}.npz", logit_scale=np.float32(50), version=np.array("t"),
             ids=np.array(["metastasis", "fat"]), protos=protos)
    tissue = np.flatnonzero(~tiles.art_blank.to_numpy())
    tum = tissue[:30]
    e = rng.normal(0, 0.3, (len(tiles), D)).astype(np.float32)
    e[:, 1] += 1.0
    e[tum, 0] += 3.0
    e[tum, 1] -= 1.0
    write_matrix(e, paths.embedding(tiles.slide_id.iloc[0], PRIMARY_MODEL), tiles.tile_id, model=PRIMARY_MODEL)
    y = np.zeros(len(tiles), int)
    y[tum] = 1
    probe, _ = fit_probe(e, y, np.arange(len(y)) % 3, task="tumor", model=PRIMARY_MODEL, classes=["benign", "tumor"], n_splits=3)
    probe.save(paths.models_dir)
    return e, tum, tissue


def test_explainer_recovers_the_planted_concept(bundle):
    paths, _, tiles = bundle
    e, tum, tissue = _setup(paths, tiles)
    ex = cx.fit(e[tissue], paths)
    assert ex.weight[ex.ids.index("metastasis")] > 0 > ex.weight[ex.ids.index("fat")]
    out = ex.explain(e[tum])
    assert out["for"][0]["id"] == "metastasis" and out["tumour_logit"] > out["benign_logit"]
    cx.save(ex, paths)
    again = cx.load(paths)
    assert again is not None and np.allclose(again.weight, ex.weight)


def test_explain_route_is_gated_and_names_the_concept(client, bundle):
    c, _, tiles = client
    paths = bundle[0]
    e, tum, tissue = _setup(paths, tiles)
    cx.save(cx.fit(e[tissue], paths), paths)
    from secondlook.api.services import concepts as svc

    svc._explainer.clear()
    r = c.get(f"/api/cases/{CASE}/explain", params={"tile": tiles.tile_id.iloc[tum[0]]}).json()
    assert r["available"] and r["for"][0]["id"] == "metastasis"
    assert c.get(f"/api/cases/case_{SLOW_SLIDE}/explain", params={"tile": "x"}).json()["hidden"]
    assert c.get(f"/api/cases/{CASE}/explain").status_code == 400
