"""Tissue search (optional): "Ctrl+F for tissue".

A phrase becomes a text vector of the primary model (CONCH) and is compared with every tile's
stored image embedding, against a contrast phrase ("normal lymph node tissue"). The reader gets
the best-matching spots on this slide, a heatmap of the top 1-2% of tissue, and the cases where the
phrase matches most strongly.

It ranks; it never says present or absent. On the 40 CAMELYON16 test slides the top 20 matches
for "metastatic carcinoma" were 90-100% inside the expert tumour outline, but no text-only rule
told tumour slides from normal ones reliably (best slide-level AUROC ~0.81), so "nothing here" is
left to the reader.

Phrases that name a feature in config/features.yaml use the exported text bank, and the 61
lymph-node terms in config/concepts_lymph_node.yaml use their saved concept directions (the same ones
the "In words" explanation uses; scripts/build_concept_vocab.py); neither needs a model at run time.
Any other phrase needs the primary model's text encoder (torch + weights) on this machine; without
it the route answers 503 with the reason. SECONDLOOK_SEARCH=0 turns the feature off.
"""
from __future__ import annotations

import logging
import threading

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from secondlook.api.services.common import audit, case_row, evidence_gate, load_slide, read_row
from secondlook.api.services.evidence import _grid_rgba, _png, _rect, features
from secondlook.api.store import SlideData, Store, get_store
from secondlook.config import PRIMARY_MODEL
from secondlook.store import db
from secondlook.store.arrays import AlignmentError, read_matrix

router = APIRouter(tags=["search"])
log = logging.getLogger(__name__)

TOP_SHARE = 0.01            # heatmap: the best 1% of tissue tiles (strong), next 1% (light)
CONTRAST = ["normal lymph node tissue", "benign tissue"]
MAX_QUERY = 120
_lock = threading.Lock()
_bank: dict[str, dict] = {}
_vocab: dict[str, dict | None] = {}
_encoder: dict[str, object] = {}
_vectors: dict[tuple[str, str], tuple[np.ndarray, np.ndarray, float, str, str]] = {}
_cohort: dict[tuple[str, str], list[dict]] = {}


class SearchUnavailable(Exception):
    pass


def _norm(q: str) -> str:
    return " ".join(q.lower().split())


def suggestions() -> list[dict]:
    return [{"phrase": f.positive[0], "label": f.label, "id": f.id} for f in features()]


def vocabulary(store: Store) -> dict | None:
    """{normalised label or id: (direction [D], label, group)} from the saved lymph-node vocabulary."""
    key = str(store.paths.root)
    if key not in _vocab:
        from secondlook.pipeline.concepts import vocab_path

        p = vocab_path(store.paths, PRIMARY_MODEL)
        if not p.exists():
            _vocab[key] = None
        else:
            d = np.load(p)
            terms = {}
            for i, l, g, v in zip(d["ids"], d["labels"], d["groups"], d["directions"]):
                entry = (np.asarray(v, np.float32), str(l), str(g))
                terms[_norm(str(l))] = terms[_norm(str(i).replace("_", " "))] = entry
            _vocab[key] = terms
    return _vocab[key]


def _text_bank(store: Store) -> dict | None:
    key = str(store.paths.root)
    if key not in _bank:
        from secondlook.pipeline.run_camelyon import load_text_bank

        _bank[key] = load_text_bank(store.paths, PRIMARY_MODEL)
    return _bank[key]


def _builtin(q: str) -> str | None:
    """Feature id whose id, label or one of its prompts is the query."""
    for f in features():
        names = {f.id.replace("_", " "), f.label, *f.positive}
        if q in {_norm(n) for n in names}:
            return f.id
    return None


def query_vectors(store: Store, raw: str) -> tuple[np.ndarray, np.ndarray, float, str, str]:
    """(positive [D], contrast [D], logit scale, source, label) for a phrase."""
    q = _norm(raw)
    if not q:
        raise HTTPException(400, "empty search")
    if len(q) > MAX_QUERY:
        raise HTTPException(400, f"search phrase longer than {MAX_QUERY} characters")
    key = (str(store.paths.root), q)
    if key in _vectors:
        return _vectors[key]
    tb = _text_bank(store)
    fid = _builtin(q)
    term = (vocabulary(store) or {}).get(q)
    if fid and tb and fid in tb["bank"]:
        pos, neg = tb["bank"][fid]
        label = next(f.label for f in features() if f.id == fid)
        out = (pos, neg, tb["logit_scale"], "built-in phrase", label)
    elif term is not None:
        # a concept direction is already text(phrase) - text(neutral): use it as phrase-minus-contrast
        direction, label, _ = term
        out = (direction, np.zeros_like(direction), tb["logit_scale"] if tb else 100.0, "lymph-node term", label)
    else:
        with _lock:
            enc = _encoder.get(PRIMARY_MODEL)
            if enc is None:
                try:
                    from secondlook.pipeline.embed import get_encoder

                    enc = _encoder[PRIMARY_MODEL] = get_encoder(PRIMARY_MODEL)
                except Exception as e:  # ImportError (no torch) or ModelUnavailable (no weights/access)
                    log.warning("tissue search: %s text encoder unavailable: %s", PRIMARY_MODEL, e)
                    raise SearchUnavailable(
                        "Searching your own words isn't set up on this computer yet (it needs the "
                        f"{PRIMARY_MODEL.upper()} text model). Pick one of these phrases instead:") from e
        v = np.asarray(enc.encode_text([raw.strip()] + CONTRAST), dtype=np.float32)
        neg = v[1:].mean(axis=0)
        out = (v[0], neg / max(np.linalg.norm(neg), 1e-6), float(enc.logit_scale), "your phrase", raw.strip())
    _vectors[key] = out
    return out


def _match(emb: np.ndarray, pos: np.ndarray, neg: np.ndarray, scale: float) -> np.ndarray:
    """P(phrase rather than the contrast) per tile."""
    e = np.asarray(emb, dtype=np.float32)
    return 1.0 / (1.0 + np.exp(-scale * (e @ pos - e @ neg)))


def _searchable(tiles: pd.DataFrame) -> np.ndarray:
    """Tissue tiles without artifacts: ink or blur would otherwise match odd phrases."""
    m = ~tiles["art_blank"].to_numpy(bool)
    if "artifact" in tiles:
        m &= ~tiles["artifact"].to_numpy(bool)
    return m


def slide_scores(store: Store, sd: SlideData, vec) -> np.ndarray:
    pos, neg, scale, _, _ = vec
    p = _match(store.embedding(sd), pos, neg, scale)
    return np.where(_searchable(sd.tiles), p, np.nan)


def _gate(con, case_id: str, read_id: str | None):
    case = case_row(con, case_id)
    visible, why = evidence_gate(case, read_row(con, read_id) if read_id else None)
    return case, None if visible else why


def _vec_or_503(store: Store, q: str):
    try:
        return query_vectors(store, q)
    except SearchUnavailable as e:
        raise HTTPException(503, str(e))


@router.get("/search/suggestions")
def get_suggestions(store: Store = Depends(get_store)):
    terms, seen = [], set()
    for _, label, group in (vocabulary(store) or {}).values():
        if label not in seen:
            seen.add(label)
            terms.append({"label": label, "group": group})
    return {"phrases": suggestions(), "terms": terms, "contrast": CONTRAST[0], "model": PRIMARY_MODEL}


@router.get("/cases/{case_id}/search")
def search(case_id: str, q: str = Query(...), read_id: str | None = None, k: int = Query(10, ge=1, le=50),
           store: Store = Depends(get_store)):
    con = store.con()
    try:
        case, hidden = _gate(con, case_id, read_id)
        if hidden:
            return {"hidden": True, "hidden_reason": hidden}
        vec = _vec_or_503(store, q)
        sd = load_slide(store, case["slide_id"])
        p = slide_scores(store, sd, vec)
        ok = np.flatnonzero(np.isfinite(p))
        order = ok[np.argsort(-p[ok], kind="stable")]
        n_top = max(1, int(round(TOP_SHARE * len(ok))))
        spots = [{"tile_id": str(sd.tiles.tile_id.iloc[i]), "rect": _rect(sd, int(i)), "score": round(float(p[i]), 4),
                  "rank": r + 1} for r, i in enumerate(order[:k])]
        audit(con, "tissue_search", read_id=read_id, case_id=case_id, ai_visible=True,
              detail={"q": vec[4], "source": vec[3], "n_spots": len(spots)})
        con.commit()
        return {"hidden": False, "query": vec[4], "source": vec[3], "model": PRIMARY_MODEL, "contrast": CONTRAST[0],
                "n_tissue": int(len(ok)), "n_highlighted": n_top, "spots": spots,
                "method": f"{PRIMARY_MODEL} text vs '{CONTRAST[0]}', ranked on this slide; best matches, not a yes/no"}
    finally:
        con.close()


@router.get("/cases/{case_id}/search/overlay.png")
def search_overlay(case_id: str, q: str = Query(...), read_id: str | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case, hidden = _gate(con, case_id, read_id)
    finally:
        con.close()
    if hidden:
        raise HTTPException(403, hidden)
    vec = _vec_or_503(store, q)
    sd = load_slide(store, case["slide_id"])
    p = slide_scores(store, sd, vec)
    ok = np.flatnonzero(np.isfinite(p))
    order = ok[np.argsort(-p[ok], kind="stable")]
    n = max(1, int(round(TOP_SHARE * len(ok))))
    img = _grid_rgba(sd)
    r, c = sd.rows, sd.cols
    light, strong = order[n:2 * n], order[:n]
    # blue, so search hits never read as the orange tumour heatmap
    img[r[light], c[light]] = (90, 170, 235, 90)
    img[r[strong], c[strong]] = (20, 110, 210, 170)
    return Response(_png(img), media_type="image/png", headers={"Cache-Control": "no-store"})


def _cohort_scores(store: Store, vec) -> list[dict]:
    """Per case: mean margin (scaled phrase-minus-contrast similarity; unlike the probability it
    does not saturate) of the 10 best tiles, where the best tile is, and a strong/medium/weak level
    by thirds of the cohort. Cached per phrase."""
    key = (str(store.paths.root), _norm(vec[4]) + "|" + vec[3])
    if key in _cohort:
        return _cohort[key]
    pos, neg, scale, _, _ = vec
    con = store.con()
    try:
        cases = db.all_(con, "SELECT case_id, slide_id, tier FROM cases")
    finally:
        con.close()
    out = []
    for c in cases:
        tp, ep = store.paths.tiles(c["slide_id"]), store.paths.embedding(c["slide_id"], PRIMARY_MODEL)
        if not tp.exists() or not ep.exists():
            continue
        tiles = pd.read_parquet(tp)
        try:
            emb = read_matrix(ep, tiles["tile_id"])
        except AlignmentError:
            continue
        m = _searchable(tiles)
        if not m.any():
            continue
        e = np.asarray(emb, dtype=np.float32)
        p = np.where(m, scale * (e @ pos - e @ neg), -np.inf)
        best = int(np.argmax(p))
        t = tiles.iloc[best]
        out.append({"case_id": c["case_id"], "slide_id": c["slide_id"], "tier": c["tier"],
                    "strength": round(float(np.sort(p[m])[::-1][:10].mean()), 4), "tile_id": str(t.tile_id),
                    "rect": {"x": int(t.x), "y": int(t.y), "w": int(t.w0), "h": int(t.w0)}})
    out.sort(key=lambda d: -d["strength"])
    for i, d in enumerate(out):
        d["level"] = "strong" if i < len(out) / 3 else "medium" if i < 2 * len(out) / 3 else "weak"
    _cohort[key] = out
    return out


@router.get("/cases/{case_id}/search/cases")
def search_cases(case_id: str, q: str = Query(...), read_id: str | None = None, k: int = Query(5, ge=1, le=20),
                 store: Store = Depends(get_store)):
    """Other cases where the phrase matches most strongly. Cases whose own AI evidence would be
    hidden (slow path, no read) are left out rather than leaking their scores."""
    con = store.con()
    try:
        _, hidden = _gate(con, case_id, read_id)
        if hidden:
            return {"hidden": True, "hidden_reason": hidden}
        vec = _vec_or_503(store, q)
        rows = _cohort_scores(store, vec)
        here = next((i for i, r in enumerate(rows) if r["case_id"] == case_id), None)
        shown, n_hidden = [], 0
        for r in rows:
            if r["case_id"] == case_id:
                continue
            if not evidence_gate(case_row(con, r["case_id"]), None)[0]:
                n_hidden += 1
                continue
            if len(shown) < k:
                shown.append({kk: r[kk] for kk in ("case_id", "slide_id", "strength", "level", "tile_id", "rect")})
        return {"hidden": False, "query": vec[4], "matches": shown, "n_cases": len(rows), "n_hidden": n_hidden,
                "this_rank": None if here is None else here + 1,
                "this_level": None if here is None else rows[here]["level"]}
    finally:
        con.close()
