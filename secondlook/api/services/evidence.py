"""Evidence service: feature bars, jump links, exemplars, artifact chips, regions,
overlay images and slide pixels (Deep Zoom) for the viewer."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response

from secondlook.api.schemas import Evidence, Regions
from secondlook.api.services.common import (audit, case_row, evidence_gate, exemplar_payload, load_slide, read_row)
from secondlook.api.store import SlideData, Store, Unavailable, get_store
from secondlook.pipeline.artifacts import FLAGS
from secondlook.pipeline.features import Calibrators, load_features
from secondlook.store import db

router = APIRouter(tags=["evidence"])
_FEATS = None


def features():
    global _FEATS
    if _FEATS is None:
        _FEATS = load_features()[1]
    return _FEATS


def feature_ids(sd: SlideData) -> list[str]:
    """Features that have a bar on this slide (the ones the reader is asked to review)."""
    return [f.id for f in features() if sd.col(f"feat_{f.id}_raw") is not None]


def _rect(sd: SlideData, i: int) -> dict:
    t = sd.tiles.iloc[i]
    return {"x": int(t.x), "y": int(t.y), "w": int(t.w0), "h": int(t.w0)}


def _jump_links(sd: SlideData, values: np.ndarray, k: int = 3) -> list[dict]:
    ok = sd.tissue & ~sd.tiles["artifact"].to_numpy() & np.isfinite(values)
    idx = np.nonzero(ok)[0]
    if not len(idx):
        return []
    top = idx[np.argsort(-values[idx])[:k]]
    return [{"tile_id": sd.tiles.tile_id.iat[i], "value": round(float(values[i]), 4), **_rect(sd, i)} for i in top]


def _default_tile(sd: SlideData, con) -> int | None:
    """Without an explicit tile, show the peak tile of the top evidence region, else the
    highest-risk tissue tile, else the first tissue tile."""
    reg = db.one(con, "SELECT peak_tile_id FROM regions WHERE slide_id=? AND kind='evidence' AND read_id IS NULL "
                      "ORDER BY rank LIMIT 1", sd.slide_id)
    if reg and reg["peak_tile_id"]:
        i = sd.index_of(reg["peak_tile_id"])
        if i is not None:
            return i
    risk = sd.col("tumor_prob_smooth")
    if risk is not None:
        return int(np.nanargmax(np.where(sd.tissue, risk, -1)))
    idx = np.nonzero(sd.tissue)[0]
    return int(idx[0]) if len(idx) else None


@router.get("/cases/{case_id}/evidence", response_model=Evidence)
def get_evidence(case_id: str, tile: str | None = None, read_id: str | None = None, x: float | None = None,
                 y: float | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case = case_row(con, case_id)
        read = read_row(con, read_id) if read_id else None
        visible, why = evidence_gate(case, read)
        if not visible:
            audit(con, "evidence_withheld", read_id=read_id, case_id=case_id, ai_visible=False, detail={"reason": why})
            con.commit()
            return Evidence(hidden=True, hidden_reason=why, case_id=case_id)
        sd = load_slide(store, case["slide_id"])
        if tile:
            i = sd.index_of(tile)
            if i is None:
                raise HTTPException(404, f"tile {tile} is not a tissue tile of this slide")
        elif x is not None and y is not None:
            r, c = sd.grid.point_to_rc(x, y)
            i = int(sd.lut()[r, c]) if sd.grid.in_bounds(r, c) else -1
            if i < 0:
                return Evidence(case_id=case_id, notes=["no tissue tile at that point"])
        else:
            i = _default_tile(sd, con)
        notes = list(sd.problems)
        if i is None:
            return Evidence(case_id=case_id, notes=notes + ["slide has no tissue tiles"])
        t = sd.tiles.iloc[i]
        cal = Calibrators(store.paths.models_dir)
        bars = []
        for f in features():
            raw_col = sd.col(f"feat_{f.id}_raw")
            cal_col = sd.col(f"feat_{f.id}_cal")
            if raw_col is None:
                continue
            meta = None
            if cal_col is not None:
                from secondlook.config import PRIMARY_MODEL

                meta = cal.meta(PRIMARY_MODEL, f.id)
            badge = None
            if f.calib_source is None:
                badge = "text only, unvalidated"
            elif cal_col is None:
                badge = "calibrator not fit yet (text prior only)"
            elif f.calib_source.startswith("nct:") and sd.row["organ"] != "colon":
                badge = "calibrated on colon tiles (cross-organ)"
            values = cal_col if cal_col is not None else raw_col
            bars.append({
                "id": f.id, "label": f.label,
                "value": None if cal_col is None else round(float(cal_col[i]), 4),
                "raw": round(float(raw_col[i]), 4), "calibrated": cal_col is not None, "badge": badge,
                "calibration_source": (meta or {}).get("source"), "jump_links": _jump_links(sd, values)})
        if not bars:
            notes.append("feature bars unavailable: no text-capable encoder output for this slide")
        flags = [k for k in FLAGS if bool(t[f"art_{k}"])]
        tp = sd.col("tumor_prob_smooth")
        dis = sd.col("disagreement")
        ex = exemplar_payload(store.similar(sd, i)) if sd.tissue[i] else None
        prov = db.one(con, "SELECT model_version FROM artifact_manifests WHERE slide_id=? AND artifact_type='scores'",
                      sd.slide_id)
        audit(con, "evidence_shown", read_id=read_id, case_id=case_id, ai_visible=True,
              review_order=(read or {}).get("review_mode"), detail={"tile_id": t.tile_id})
        con.commit()
        return Evidence(case_id=case_id, tile_id=t.tile_id, tile_rect=_rect(sd, i),
                        tumor_prob=None if tp is None else round(float(tp[i]), 4),
                        tumor_prob_source=(prov or {}).get("model_version"),
                        disagreement=None if dis is None or not np.isfinite(dis[i]) else round(float(dis[i]), 4),
                        artifacts=flags, features=bars, exemplars=ex, notes=notes)
    finally:
        con.close()


@router.get("/cases/{case_id}/regions", response_model=Regions)
def get_regions(case_id: str, kind: str = Query("evidence", pattern="^(evidence|disputed|unseen)$"),
                read_id: str | None = None, limit: int = 10, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case = case_row(con, case_id)
        read = read_row(con, read_id) if read_id else None
        if kind in ("evidence", "disputed"):
            visible, why = evidence_gate(case, read)
            if not visible:
                return Regions(hidden=True, hidden_reason=why, kind=kind)
            rows = db.all_(con, "SELECT * FROM regions WHERE slide_id=? AND kind=? AND read_id IS NULL "
                                "ORDER BY rank LIMIT ?", case["slide_id"], kind, limit)
        else:
            if not read_id:
                raise HTTPException(400, "unseen regions belong to a read; pass read_id")
            rows = db.all_(con, """SELECT g.*, a.alert_id, a.status AS alert_status FROM regions g
                                   JOIN alerts a ON a.region_id=g.region_id
                                   WHERE g.read_id=? ORDER BY a.created_at DESC, g.rank LIMIT ?""", read_id, limit)
        return Regions(kind=kind, regions=[{k: v for k, v in r.items() if k not in ("slide_id", "read_id")} for r in rows])
    finally:
        con.close()


# ----------------------------------------------------------------------------- overlays

def _png(rgba: np.ndarray) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _grid_rgba(sd: SlideData) -> np.ndarray:
    return np.zeros((sd.grid.rows, sd.grid.cols, 4), np.uint8)


def overlay_rgba(sd: SlideData, layer: str) -> np.ndarray:
    img = _grid_rgba(sd)
    r, c = sd.rows, sd.cols
    if layer == "tissue":
        img[r, c] = (60, 130, 220, 70)
    elif layer == "artifact":
        colors = {"ink": (30, 90, 255, 170), "blur": (130, 130, 130, 170), "fold": (255, 140, 0, 170),
                  "blank": (0, 0, 0, 0)}
        for k, col in colors.items():
            m = sd.tiles[f"art_{k}"].to_numpy()
            img[r[m], c[m]] = col
    elif layer == "risk":
        v = sd.col("tumor_prob_smooth")
        if v is None:
            raise Unavailable("risk layer", "no tumour-risk scores")
        v = np.nan_to_num(v, nan=0.0)
        m = v >= 0.2
        t = np.clip((v[m] - 0.2) / 0.8, 0, 1)
        img[r[m], c[m]] = np.stack([np.full_like(t, 255), (220 * (1 - t)).astype(float),
                                    np.zeros_like(t), 60 + 170 * t], axis=1).astype(np.uint8)
    elif layer == "disagreement":
        v = sd.col("disagreement")
        if v is None:
            raise Unavailable("disagreement layer", "fewer than two models scored this slide")
        m = np.isfinite(v) & (v >= 0.75)
        t = np.clip((v[m] - 0.75) / 0.25, 0, 1)
        img[r[m], c[m]] = np.stack([150 + 70 * t, 40 + 0 * t, 200 + 40 * t, 70 + 150 * t], axis=1).astype(np.uint8)
    else:
        raise HTTPException(404, f"unknown layer {layer}")
    return img


@router.get("/cases/{case_id}/overlay/{layer}.png")
def get_overlay(case_id: str, layer: str, read_id: str | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case = case_row(con, case_id)
        read = read_row(con, read_id) if read_id else None
        if layer in ("risk", "disagreement"):
            visible, why = evidence_gate(case, read)
            if not visible:
                raise HTTPException(403, why)
    finally:
        con.close()
    sd = load_slide(store, case["slide_id"])
    try:
        return Response(_png(overlay_rgba(sd, layer)), media_type="image/png",
                        headers={"Cache-Control": "no-store"})
    except Unavailable as e:
        raise HTTPException(409, e.reason)


# ----------------------------------------------------------------------------- pixels

@router.get("/slides/{slide_id}/thumbnail.jpg")
def thumbnail(slide_id: str, store: Store = Depends(get_store)):
    p = store.paths.thumbnail(slide_id)
    if not p.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(p, media_type="image/jpeg")


@router.get("/slides/{slide_id}/slide.dzi")
def dzi(slide_id: str, store: Store = Depends(get_store)):
    try:
        dz, _ = store.deepzoom(slide_id)
    except Unavailable as e:
        raise HTTPException(404, e.reason)
    return Response(dz.get_dzi("jpeg"), media_type="application/xml")


@router.get("/slides/{slide_id}/slide_files/{level}/{tile}")
def dzi_tile(slide_id: str, level: int, tile: str, store: Store = Depends(get_store)):
    try:
        dz, lock = store.deepzoom(slide_id)
    except Unavailable as e:
        raise HTTPException(404, e.reason)
    try:
        col, row = (int(v) for v in tile.rsplit(".", 1)[0].split("_"))
        img = dz.get_tile(level, (col, row))
    except (ValueError, Exception) as e:
        raise HTTPException(404, f"bad tile: {e}")
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=82)
    return Response(buf.getvalue(), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/exemplars/{path:path}")
def exemplar_image(path: str, store: Store = Depends(get_store)):
    root = store.paths.exemplar_dir.resolve()
    p = (root / path).resolve()
    if root not in p.parents or not p.exists():
        raise HTTPException(404, "exemplar image not found")
    return FileResponse(p, media_type="image/jpeg")
