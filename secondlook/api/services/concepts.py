"""Concept explanations (optional): "why is this tumour?" in words, for a tile or a region.
See secondlook/pipeline/concepts.py for the method and eval/concepts_eval.py for the evidence.
SECONDLOOK_CONCEPTS=0 turns the feature off."""
from __future__ import annotations

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from secondlook.api.services.common import audit, case_row, evidence_gate, load_slide, read_row
from secondlook.api.store import Store, Unavailable, get_store
from secondlook.pipeline import concepts as cx
from secondlook.store import db

router = APIRouter(tags=["concepts"])
_explainer: dict[str, cx.Explainer | None] = {}


def explainer(store: Store) -> cx.Explainer | None:
    key = str(store.paths.root)
    if key not in _explainer:
        _explainer[key] = cx.load(store.paths)
    return _explainer[key]


def _region_rows(con, sd, region_id: str) -> np.ndarray:
    r = db.one(con, "SELECT x, y, w, h FROM regions WHERE region_id=? AND slide_id=?", region_id, sd.slide_id)
    if not r:
        raise HTTPException(404, f"region {region_id} not on this case")
    t = sd.tiles
    cx_, cy = t.x + t.w0 / 2, t.y + t.w0 / 2
    m = ((cx_ >= r["x"]) & (cx_ <= r["x"] + r["w"]) & (cy >= r["y"]) & (cy <= r["y"] + r["h"])
         & ~t.art_blank).to_numpy()
    rows = np.flatnonzero(m)
    if not len(rows):
        raise HTTPException(409, "no tissue tiles inside this region")
    return rows


@router.get("/cases/{case_id}/explain")
def explain(case_id: str, tile: str | None = None, region: str | None = None, read_id: str | None = None,
            store: Store = Depends(get_store)):
    if bool(tile) == bool(region):
        raise HTTPException(400, "give exactly one of tile or region")
    con = store.con()
    try:
        case = case_row(con, case_id)
        visible, why = evidence_gate(case, read_row(con, read_id) if read_id else None)
        if not visible:
            return {"hidden": True, "hidden_reason": why}
        e = explainer(store)
        if e is None:
            return {"hidden": False, "available": False,
                    "reason": "concept explanations not fitted (python -m secondlook.pipeline.concepts)"}
        sd = load_slide(store, case["slide_id"])
        if tile:
            hit = np.flatnonzero(sd.tiles.tile_id.to_numpy() == tile)
            if not len(hit):
                raise HTTPException(404, f"tile {tile} not on this case")
            rows = hit
        else:
            rows = _region_rows(con, sd, region)
        try:
            emb = store.embedding(sd, e.model)
        except Unavailable as err:
            return {"hidden": False, "available": False, "reason": err.reason}
        X = np.asarray(emb, np.float32)[rows]
        if region:
            # a region box also holds normal tissue; explain the tiles that drove the flag
            hot = (X @ e.v + e.b) > 0
            if hot.any():
                rows, X = rows[hot], X[hot]
        out = e.explain(X)
        audit(con, "concepts_shown", read_id=read_id, case_id=case_id, ai_visible=True,
              detail={"tile": tile, "region": region})
        con.commit()
        return {"hidden": False, "available": True, "target": {"tile": tile, "region": region, "n_tiles": int(len(rows))},
                "model": e.model, "method": e.meta.get("method"), **out}
    finally:
        con.close()
