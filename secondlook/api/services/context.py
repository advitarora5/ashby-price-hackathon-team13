"""Spatial context service (optional): feature attraction heatmap, the tiles behind one
heatmap cell, and "find similar arrangements". Reads only <bundle>/context/, written by
`python -m secondlook.pipeline.context`; see that module for how to remove the feature."""
from __future__ import annotations

import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query

from secondlook.api.services.common import audit, case_row, evidence_gate, load_slide, read_row
from secondlook.api.services.evidence import _rect
from secondlook.api.store import Store, get_store
from secondlook.pipeline import context as ctx
from secondlook.store import db
from secondlook.store.arrays import AlignmentError, read_matrix

router = APIRouter(tags=["context"])
_INDEX: dict[str, ctx.ContextIndex] = {}


def _gate(con, case_id: str, read_id: str | None) -> tuple[dict, str | None]:
    case = case_row(con, case_id)
    visible, why = evidence_gate(case, read_row(con, read_id) if read_id else None)
    return case, None if visible else why


def _descriptors(store: Store, sd) -> np.ndarray | None:
    p = ctx.descriptor_path(store.paths, sd.slide_id)
    if not p.exists():
        return None
    try:
        flat = read_matrix(p, sd.tiles["tile_id"])
    except AlignmentError:
        return None
    return np.asarray(flat, dtype=np.float32).reshape(len(flat), len(ctx.RINGS), -1)


def _index(store: Store) -> ctx.ContextIndex | None:
    key = str(store.paths.root)
    if key not in _INDEX:
        idx = ctx.ContextIndex(store.paths)
        if not idx.available():
            return None
        _INDEX[key] = idx.load()
    return _INDEX[key]


@router.get("/cases/{case_id}/context/correlation")
def correlation(case_id: str, read_id: str | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case, hidden = _gate(con, case_id, read_id)
        if hidden:
            return {"hidden": True, "hidden_reason": hidden}
        p = ctx.correlation_path(store.paths, case["slide_id"])
        if not p.exists():
            return {"hidden": False, "available": False,
                    "reason": "spatial context not built for this slide (python -m secondlook.pipeline.context)"}
        audit(con, "context_shown", read_id=read_id, case_id=case_id, ai_visible=True)
        con.commit()
        return {"hidden": False, "available": True, **json.loads(p.read_text())}
    finally:
        con.close()


@router.get("/cases/{case_id}/context/pair")
def pair_tiles(case_id: str, x: str, y: str, ring: int = Query(1, ge=0, lt=len(ctx.RINGS)),
               read_id: str | None = None, limit: int = Query(120, ge=1, le=400), store: Store = Depends(get_store)):
    """Tiles high in feature x (same rule as the heatmap) whose ring `ring` is high in feature y (top 20%)."""
    con = store.con()
    try:
        case, hidden = _gate(con, case_id, read_id)
        if hidden:
            raise HTTPException(403, hidden)
        sd = load_slide(store, case["slide_id"])
        d = _descriptors(store, sd)
        feats = descriptor_features(store, sd.slide_id)
        if d is None or x not in feats or y not in feats:
            raise HTTPException(404, "no spatial context for that feature pair")
        xi, yi = feats.index(x), feats.index(y)
        ok = np.isfinite(d[:, 0, 0])
        own, around = d[:, 0, xi], d[:, ring, yi]
        cut = json.loads(ctx.correlation_path(store.paths, sd.slide_id).read_text())["high_at"][xi]
        if cut is None:
            return {"n_tiles": 0, "tiles": []}
        hit = ok & (own >= cut) & (around >= np.quantile(around[ok], ctx.HIGH_QUANTILE))
        idx = np.nonzero(hit)[0]
        idx = idx[np.argsort(-(own[idx] + around[idx]))][:limit]
        audit(con, "context_pair_shown", read_id=read_id, case_id=case_id, ai_visible=True,
              detail={"x": x, "y": y, "ring": ring, "n": int(hit.sum())})
        con.commit()
        return {"n_tiles": int(hit.sum()), "tiles": [{"tile_id": sd.tiles.tile_id.iat[i], **_rect(sd, i)} for i in idx]}
    finally:
        con.close()


def descriptor_features(store: Store, slide_id: str) -> list[str]:
    p = ctx.descriptor_path(store.paths, slide_id).with_suffix(".meta.json")
    return json.loads(p.read_text()).get("features", []) if p.exists() else []


@router.get("/cases/{case_id}/context/similar")
def similar(case_id: str, tile: str, read_id: str | None = None, k: int = Query(5, ge=1, le=20),
            store: Store = Depends(get_store)):
    con = store.con()
    try:
        case, hidden = _gate(con, case_id, read_id)
        if hidden:
            raise HTTPException(403, hidden)
        sd = load_slide(store, case["slide_id"])
        idx, d = _index(store), _descriptors(store, sd)
        if idx is None or d is None:
            return {"available": False, "reason": "spatial context not built (python -m secondlook.pipeline.context)"}
        if descriptor_features(store, sd.slide_id) != idx.info["features"]:
            return {"available": False, "reason": "this slide was scored with a different feature set"}
        i = sd.index_of(tile)
        if i is None:
            raise HTTPException(404, f"tile {tile} is not on this slide")
        if not np.isfinite(d[i]).all():
            return {"available": False, "reason": "that spot is glass or damaged tissue; pick a clean tissue spot"}
        hits = idx.search(d[i], exclude_slide=sd.slide_id, k=k)
        cases = {r["slide_id"]: r["case_id"] for r in db.all_(con, "SELECT case_id, slide_id FROM cases")}
        out = []
        for h in hits:
            other = load_slide(store, h["slide_id"])
            out.append({**{k2: h[k2] for k2 in ("slide_id", "tile_id", "shape_similarity", "distance", "summary")},
                        "case_id": cases.get(h["slide_id"]), "rect": _rect(other, h["tile_index"])})
        audit(con, "context_similar_shown", read_id=read_id, case_id=case_id, ai_visible=True,
              detail={"tile_id": tile, "n": len(out)})
        con.commit()
        return {"available": True, "query": {"tile_id": tile, "summary": ctx.summarize(d[i], idx.baseline, idx.info["labels"])},
                "matches": out}
    finally:
        con.close()
