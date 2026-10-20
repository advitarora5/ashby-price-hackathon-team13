"""Clef service (optional): check a reader's notes against the slide, and explain a flagged region.
See secondlook/clef.py for what Clef is used for and how to remove the feature."""
from __future__ import annotations

import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from secondlook import clef
from secondlook.api.services.common import audit, case_row, evidence_gate, load_slide, read_row
from secondlook.api.services.evidence import _jump_links, feature_ids, features
from secondlook.api.store import Store, get_store
from secondlook.store import db

router = APIRouter(tags=["clef"])

SCHEMA = """CREATE TABLE IF NOT EXISTS clef_calls (
    kind TEXT NOT NULL, subject TEXT NOT NULL, digest TEXT NOT NULL, model TEXT, created_at TEXT, result TEXT,
    PRIMARY KEY (kind, subject, digest))"""
_LABELS = {"present": "said present", "absent": "said absent", "not_mentioned": "not mentioned"}


def _client():
    try:
        return clef.get_client()
    except clef.ClefUnavailable as e:
        raise HTTPException(503, str(e))


def _cached(con, kind: str, subject: str, digest: str | None = None) -> dict | None:
    con.execute(SCHEMA)
    q = "SELECT result FROM clef_calls WHERE kind=? AND subject=?" + (" AND digest=?" if digest else "") + \
        " ORDER BY created_at DESC LIMIT 1"
    row = db.one(con, q, *([kind, subject] + ([digest] if digest else [])))
    return json.loads(row["result"]) if row else None


def _store(con, kind: str, subject: str, digest: str, model: str, result: dict) -> None:
    con.execute(SCHEMA)
    con.execute("INSERT OR REPLACE INTO clef_calls VALUES (?,?,?,?,?,?)",
                (kind, subject, digest, model, db.now(), clef.dumps(result)))


def _gated_read(con, read_id: str):
    read = read_row(con, read_id)
    case = case_row(con, read["case_id"])
    visible, why = evidence_gate(case, read)
    if not visible:
        raise HTTPException(403, why)
    return read, case


def _context_hint(store: Store, slide_id: str, feature: str) -> str | None:
    """Where the feature sits relative to others, from the spatial-context heatmap if it was built."""
    try:
        from secondlook.pipeline import context as ctx
    except ImportError:
        return None
    p = ctx.correlation_path(store.paths, slide_id)
    if not p.exists():
        return None
    c = json.loads(p.read_text())
    ids = [f["id"] for f in c["features"]]
    if feature not in ids:
        return None
    y = ids.index(feature)
    best = None
    for x, fx in enumerate(c["features"]):
        if x == y:
            continue
        for r in range(1, len(c["rings"])):
            ratio, q = c["ratio"][x][r][y], c["q"][x][r][y]
            if ratio is not None and q is not None and q < 0.05 and ratio > 1 and (best is None or ratio > best[0]):
                best = (ratio, fx["label"].lower(), c["rings"][r]["label"])
    return f"gathers {best[2]} from {best[1]} ({best[0]:.1f}x)" if best else None


@router.post("/reads/{read_id}/notes-check")
def notes_check(read_id: str, store: Store = Depends(get_store)):
    con = store.con()
    try:
        read, case = _gated_read(con, read_id)
        notes = (read.get("notes") or "").strip()
        if not notes:
            raise HTTPException(422, "save some notes first")
        digest = clef.text_digest(notes)
        hit = _cached(con, "notes", read_id, digest)
        if hit:
            return {**hit, "cached": True}
        version, findings = clef.load_findings()
        client = _client()
        try:
            found = clef.extract_findings(client, notes, findings, kind="notes")
        except clef.ClefUnavailable as e:
            raise HTTPException(503, str(e))
        sd = load_slide(store, case["slide_id"])
        if sd.scores is None:
            raise HTTPException(409, "this slide has no AI scores to check the notes against")
        prev = clef.feature_prevalence(sd.tiles, sd.scores, feature_ids(sd))
        rows = clef.compare(found, prev, findings)
        labels = {f.id: f.label for f in features()}
        for r in rows:
            r["label"] = labels.get(r["feature"], r["about"])
            r["said_text"] = _LABELS[r["said"]]
            if r["category"] in ("possibly_missed", "contradiction", "confirmed") and r["feature"]:
                vals = sd.col(f"feat_{r['feature']}_cal")
                r["where"] = _jump_links(sd, vals) if vals is not None else []
                r["context"] = _context_hint(store, sd.slide_id, r["feature"])
        result = {"read_id": read_id, "notes_digest": digest, "findings_version": version, "model": client.model,
                  "checked_at": db.now(), "rows": rows,
                  "method": f"Clef reads the notes; a feature counts as on the slide when >= {clef.PRESENT_SHARE:.0%} "
                            f"of clean tissue has calibrated probability >= {clef.PRESENT_P}"}
        _store(con, "notes", read_id, digest, client.model, result)
        audit(con, "notes_checked", read_id=read_id, case_id=read["case_id"], ai_visible=True,
              detail={"digest": digest, "categories": [r["category"] for r in rows]})
        con.commit()
        return {**result, "cached": False}
    finally:
        con.close()


@router.get("/reads/{read_id}/notes-check")
def last_notes_check(read_id: str, store: Store = Depends(get_store)):
    con = store.con()
    try:
        read, _ = _gated_read(con, read_id)
        hit = _cached(con, "notes", read_id)
        if not hit:
            raise HTTPException(404, "no notes check yet")
        return {**hit, "cached": True, "stale": hit["notes_digest"] != clef.text_digest(read.get("notes") or "")}
    finally:
        con.close()


def referee_inputs(store: Store, sd, region: dict) -> tuple[dict, list]:
    """(state, images) for one region: measurements, then the region crop and the two nearest
    labelled example tiles, so Clef can compare what the region looks like with known cases."""
    labels = {f.id: f.label for f in features()}
    rect = {k: int(region[k]) for k in ("x", "y", "w", "h")}
    peak = sd.index_of(region["peak_tile_id"]) if region.get("peak_tile_id") else None
    ex = store.similar(sd, peak, k=1) if peak is not None and sd.tissue[peak] else None
    context = None
    try:
        from secondlook.api.services.context import _descriptors, _index
        from secondlook.pipeline.context import summarize

        d, idx = _descriptors(store, sd), _index(store)
        if d is not None and idx is not None and peak is not None and np.isfinite(d[peak]).all():
            context = summarize(d[peak], idx.baseline, idx.info["labels"])
    except ImportError:
        pass
    state = clef.region_state(sd.tiles, sd.scores, rect, region, float(sd.row["mpp"]), labels, ex, context)
    images, legend = [], []
    path = store.image_path(sd.slide_id)
    crop = clef.region_crop(str(path) if path else None, store.paths.thumbnail(sd.slide_id), int(sd.row["width"]), rect)
    if crop:
        images.append(clef.image_part(crop))
        legend.append("image 1: the flagged region with its surroundings")
    for lab in ("tumor", "benign"):
        for h in (ex or {}).get(lab, [])[:1]:
            p = store.paths.exemplar_dir / h["image"]
            if p.exists():
                images.append(clef.image_part(p.read_bytes(), "image/png" if p.suffix == ".png" else "image/jpeg"))
                legend.append(f"image {len(images)}: nearest labelled {'tumour' if lab == 'tumor' else 'benign'} example tile")
    if legend:
        state["images"] = legend
    return state, images


@router.post("/cases/{case_id}/regions/{region_id}/explain")
def explain_region(case_id: str, region_id: str, read_id: str | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case = case_row(con, case_id)
        visible, why = evidence_gate(case, read_row(con, read_id) if read_id else None)
        if not visible:
            raise HTTPException(403, why)
        region = db.one(con, "SELECT * FROM regions WHERE region_id=? AND slide_id=?", region_id, case["slide_id"])
        if region is None:
            raise HTTPException(404, f"region {region_id} not on this case")
        client = _client()
        hit = _cached(con, "referee", region_id, client.model)
        if hit:
            return {**hit, "cached": True}
        sd = load_slide(store, case["slide_id"])
        state, images = referee_inputs(store, sd, region)
        try:
            ans = client.ask(state, clef.REFEREE_QUESTIONS, images)
        except clef.ClefUnavailable as e:
            raise HTTPException(503, str(e))
        e = ans.get("explanation", {})
        result = {"region_id": region_id, "model": client.model, "explanation": e.get("choice"),
                  "probabilities": e.get("probabilities", {}), "confidence": e.get("confidence"),
                  "needs_expert": (ans.get("needs_expert") or {}).get("noul"), "evidence": state,
                  "n_images": len(images)}
        _store(con, "referee", region_id, client.model, client.model, result)
        audit(con, "region_explained", read_id=read_id, case_id=case_id, ai_visible=True,
              detail={"region_id": region_id, "explanation": result["explanation"]})
        con.commit()
        return {**result, "cached": False}
    finally:
        con.close()
