"""Tissue search: built-in phrases rank tiles from the exported text bank, blind reads stay
blind, and a free phrase without a text encoder fails with a clear 503."""
import numpy as np

from secondlook.api.services import search
from tests.conftest import CASE, SLOW_SLIDE


def _bank_and_embeddings(paths, tiles, monkeypatch):
    """A 4-d toy space: axis 0 = 'tumour', axis 1 = contrast. The first 5 tiles point at tumour."""
    from secondlook.store.arrays import write_matrix

    d = paths.models_dir / "text_banks"
    d.mkdir(parents=True, exist_ok=True)
    pos, neg = np.eye(4, dtype=np.float32)[0], np.eye(4, dtype=np.float32)[1]
    np.savez(d / f"{search.PRIMARY_MODEL}.npz", logit_scale=np.float32(50), version=np.array("t"),
             ids=np.array(["metastasis"]), protos=np.stack([np.stack([pos, neg])]))
    e = np.tile(neg, (len(tiles), 1))
    hit = np.flatnonzero(~tiles.art_blank.to_numpy() & ~tiles.artifact.to_numpy())[:5]
    e[hit] = pos
    write_matrix(e, paths.embedding(tiles.slide_id.iloc[0], search.PRIMARY_MODEL), tiles.tile_id, model=search.PRIMARY_MODEL)
    for cache in (search._bank, search._vectors, search._cohort):
        cache.clear()
    return set(tiles.tile_id.iloc[hit])


def test_builtin_phrase_ranks_matching_tiles_first(client, bundle, monkeypatch):
    c, _, tiles = client
    paths = bundle[0]
    want = _bank_and_embeddings(paths, tiles, monkeypatch)
    r = c.get(f"/api/cases/{CASE}/search", params={"q": "Metastatic carcinoma", "k": 5}).json()
    assert r["source"] == "built-in phrase" and {s["tile_id"] for s in r["spots"]} == want
    assert c.get(f"/api/cases/{CASE}/search/overlay.png", params={"q": "metastatic carcinoma"}).status_code == 200
    log = [e["action"] for e in c.get("/api/audit", params={"case_id": CASE}).json()]
    assert "tissue_search" in log


def test_blind_reads_stay_blind_and_free_text_needs_the_encoder(client, monkeypatch):
    c, _, _ = client
    assert c.get(f"/api/cases/case_{SLOW_SLIDE}/search", params={"q": "fat"}).json()["hidden"]
    assert c.get(f"/api/cases/case_{SLOW_SLIDE}/search/overlay.png", params={"q": "fat"}).status_code == 403

    def no_encoder(name):
        raise ImportError("No module named 'torch'")

    import secondlook.pipeline.embed as embed
    monkeypatch.setattr(embed, "get_encoder", no_encoder)
    search._encoder.clear(); search._vectors.clear()
    r = c.get(f"/api/cases/{CASE}/search", params={"q": "signet ring cells"})
    assert r.status_code == 503 and "isn't set up" in r.json()["detail"]


def test_vocabulary_terms_are_searchable_without_a_model(client, bundle, monkeypatch):
    """Terms from the saved lymph-node vocabulary use their concept direction directly."""
    c, _, tiles = client
    paths = bundle[0]
    want = _bank_and_embeddings(paths, tiles, monkeypatch)
    from secondlook.pipeline.concepts import vocab_path

    np.savez(vocab_path(paths, search.PRIMARY_MODEL), version=np.array("t"), ids=np.array(["nests"]),
             labels=np.array(["tumour cell nests"]), groups=np.array(["tumour"]),
             directions=np.eye(4, dtype=np.float32)[:1])
    search._vocab.clear()
    assert {"label": "tumour cell nests", "group": "tumour"} in c.get("/api/search/suggestions").json()["terms"]
    r = c.get(f"/api/cases/{CASE}/search", params={"q": "Tumour cell nests", "k": 5}).json()
    assert r["source"] == "lymph-node term" and {s["tile_id"] for s in r["spots"]} == want
