"""Coverage service: reads, viewport/gaze events, the seen map, decisions and the
sign-out check that ranks unseen tissue by precomputed tumour risk."""
from __future__ import annotations

import json
import threading
from dataclasses import replace

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from secondlook.api.schemas import (CoverageOut, DecisionIn, EventsIn, ReadCreate, ReadOut, SignoutIn, SignoutOut)
from secondlook.api.services.common import (audit, case_row, evidence_gate, exemplar_payload, load_slide, read_row,
                                            requires_blind)
from secondlook.api.store import SlideData, Store, get_store
from secondlook.config import DEFAULT_COVERAGE, CoverageParams
from secondlook.core import coverage as cov
from secondlook.core.signout import load_light_thresholds, unseen_check
from secondlook.ids import new_id, region_id
from secondlook.pipeline.export import write_regions
from secondlook.store import db

router = APIRouter(tags=["coverage"])
_cache: dict[str, tuple[int, cov.Coverage]] = {}
_cache_lock = threading.Lock()


def params_for(read: dict) -> CoverageParams:
    return replace(DEFAULT_COVERAGE, mode=read.get("coverage_mode") or "viewport")


def read_events(con, read_id: str) -> pd.DataFrame:
    return pd.read_sql_query("SELECT seq, t_ms, kind, x, y, w, h, zoom, duration_ms, eye_mm FROM view_events "
                             "WHERE read_id=? ORDER BY t_ms, seq", con, params=(read_id,))


def coverage_for(store: Store, con, read: dict, sd: SlideData) -> tuple[cov.Coverage, int]:
    n = db.one(con, "SELECT COUNT(*) n FROM view_events WHERE read_id=?", read["read_id"])["n"]
    with _cache_lock:
        hit = _cache.get(read["read_id"])
    if hit and hit[0] == n:
        return hit[1], n
    c = cov.compute(read_events(con, read["read_id"]), sd.grid, sd.rows, sd.cols, params_for(read))
    with _cache_lock:
        _cache[read["read_id"]] = (n, c)
    return c, n


def coverage_out(read: dict, sd: SlideData, c: cov.Coverage, n: int, revisited=()) -> CoverageOut:
    tissue = sd.tissue
    p = params_for(read)
    return CoverageOut(read_id=read["read_id"], mode=c.mode,
                       params={"radius_deg": p.radius_deg, "min_magnification": p.min_magnification,
                               "definition": "fixation within radius at >= min magnification" if c.mode == "gaze"
                               else "tile centre on screen at >= min magnification (does not prove it was looked at)"},
                       n_events=n, tissue_tiles=int(tissue.sum()), seen_tiles=int((c.seen & tissue).sum()),
                       seen_share=float((c.seen & tissue).sum() / max(tissue.sum(), 1)),
                       overlay_url=f"/api/reads/{read['read_id']}/coverage.png", revisited_alerts=list(revisited))


def read_out(con, read: dict) -> ReadOut:
    case = case_row(con, read["case_id"])
    visible, _ = evidence_gate(case, read)
    return ReadOut(read_id=read["read_id"], case_id=read["case_id"], review_mode=read["review_mode"] or "aided",
                   coverage_mode=read["coverage_mode"] or "viewport", tier=case.get("tier") or "unavailable",
                   initial_decision=read["initial_decision"], final_decision=read["final_decision"],
                   evidence_visible=visible, source=read["source"], replay_of=read.get("replay_of"))


@router.post("/reads", response_model=ReadOut)
def create_read(body: ReadCreate, store: Store = Depends(get_store)):
    con = store.con()
    try:
        case = case_row(con, body.case_id)
        if case["status"] != "ok":
            raise HTTPException(409, f"slide unavailable: {case['status_detail']}")
        mode = "blind" if requires_blind(case, body.blind_all) else "aided"
        rid = new_id("read")
        db.upsert(con, "readers", {"reader_id": body.reader_id, "dataset": "live", "experience_level": None})
        db.upsert(con, "reads", {"read_id": rid, "slide_id": case["slide_id"], "case_id": body.case_id,
                                 "reader_id": body.reader_id, "source": "live", "review_mode": mode,
                                 "coverage_mode": body.coverage_mode, "started_at": db.now()})
        con.execute("UPDATE cases SET review_status='in_review' WHERE case_id=? AND review_status='unread'", (body.case_id,))
        audit(con, "case_opened", read_id=rid, case_id=body.case_id, session_id=body.session_id,
              ai_visible=(mode == "aided"), review_order=mode,
              detail={"tier": case.get("tier"), "blind_all": body.blind_all})
        con.commit()
        return read_out(con, read_row(con, rid))
    finally:
        con.close()


@router.get("/reads/{read_id}", response_model=ReadOut)
def get_read(read_id: str, store: Store = Depends(get_store)):
    con = store.con()
    try:
        return read_out(con, read_row(con, read_id))
    finally:
        con.close()


def ingest_events(con, read_id: str, events) -> int:
    before = con.total_changes
    con.executemany("""INSERT OR IGNORE INTO view_events (read_id, seq, t_ms, kind, x, y, w, h, zoom, duration_ms, eye_mm)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    [(read_id, e.seq, e.t_ms, e.kind, e.x, e.y, e.w, e.h, e.zoom, e.duration_ms, e.eye_mm) for e in events])
    return con.total_changes - before


def mark_revisits(con, read_id: str, sd: SlideData, c: cov.Coverage) -> list[str]:
    """An alert counts as revisited once >= 50% of its region's tissue tiles are seen."""
    out = []
    for a in db.all_(con, """SELECT a.alert_id, g.x, g.y, g.w, g.h FROM alerts a JOIN regions g USING(region_id)
                             WHERE a.read_id=? AND a.status='shown'""", read_id):
        r0, r1, c0, c1 = sd.grid.rect_to_rc_range(a["x"], a["y"], a["w"], a["h"])
        idx = sd.lut()[r0:r1, c0:c1].ravel()
        idx = idx[idx >= 0]
        idx = idx[sd.tissue[idx]]
        if len(idx) and c.seen[idx].mean() >= 0.5:
            con.execute("UPDATE alerts SET status='revisited', revisited_at=? WHERE alert_id=?", (db.now(), a["alert_id"]))
            audit(con, "alert_revisited", read_id=read_id, detail={"alert_id": a["alert_id"]})
            out.append(a["alert_id"])
    return out


@router.post("/reads/{read_id}/events", response_model=CoverageOut)
def post_events(read_id: str, body: EventsIn, store: Store = Depends(get_store)):
    con = store.con()
    try:
        read = read_row(con, read_id)
        if read["coverage_mode"] == "viewport" and any(e.kind != "viewport" for e in body.events):
            raise HTTPException(422, "this read uses viewport coverage; fixation events are not accepted")
        ingest_events(con, read_id, body.events)
        con.commit()
        sd = load_slide(store, read["slide_id"])
        c, n = coverage_for(store, con, read, sd)
        rev = mark_revisits(con, read_id, sd, c)
        con.commit()
        return coverage_out(read, sd, c, n, rev)
    finally:
        con.close()


@router.get("/reads/{read_id}/coverage", response_model=CoverageOut)
def get_coverage(read_id: str, store: Store = Depends(get_store)):
    con = store.con()
    try:
        read = read_row(con, read_id)
        sd = load_slide(store, read["slide_id"])
        c, n = coverage_for(store, con, read, sd)
        return coverage_out(read, sd, c, n)
    finally:
        con.close()


@router.get("/reads/{read_id}/coverage.png")
def coverage_png(read_id: str, store: Store = Depends(get_store)):
    from secondlook.api.services.evidence import _png

    con = store.con()
    try:
        read = read_row(con, read_id)
        sd = load_slide(store, read["slide_id"])
        c, _ = coverage_for(store, con, read, sd)
    finally:
        con.close()
    img = np.zeros((sd.grid.rows, sd.grid.cols, 4), np.uint8)
    tissue = sd.tissue
    seen = c.seen & tissue
    unseen = tissue & ~c.seen
    img[sd.rows[seen], sd.cols[seen]] = (40, 150, 255, 80)
    img[sd.rows[unseen], sd.cols[unseen]] = (255, 170, 0, 95)
    return Response(_png(img), media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/reads/{read_id}/decision", response_model=ReadOut)
def post_decision(read_id: str, body: DecisionIn, store: Store = Depends(get_store)):
    con = store.con()
    try:
        read = read_row(con, read_id)
        case = case_row(con, read["case_id"])
        ai_visible, _ = evidence_gate(case, read)
        if body.stage == "initial":
            con.execute("UPDATE reads SET initial_decision=? WHERE read_id=?", (body.decision, read_id))
            action = "blind_assessment" if not ai_visible else "initial_assessment"
            audit(con, action, read_id=read_id, case_id=read["case_id"], session_id=body.session_id,
                  ai_visible=ai_visible, review_order=read["review_mode"], decision_after=body.decision)
            if not ai_visible:
                audit(con, "evidence_unlocked", read_id=read_id, case_id=read["case_id"], ai_visible=True,
                      review_order=read["review_mode"])
        elif body.stage == "final":
            before = read["initial_decision"]
            override = before is not None and before != body.decision
            con.execute("UPDATE reads SET final_decision=? WHERE read_id=?", (body.decision, read_id))
            audit(con, "final_assessment", read_id=read_id, case_id=read["case_id"], session_id=body.session_id,
                  ai_visible=ai_visible, review_order=read["review_mode"], decision_before=before,
                  decision_after=body.decision, override=override)
        else:
            col = "second_decision" if body.stage == "second_reader" else "third_decision"
            con.execute(f"UPDATE reads SET {col}=? WHERE read_id=?", (body.decision, read_id))
            audit(con, body.stage, read_id=read_id, case_id=read["case_id"], decision_after=body.decision)
        con.commit()
        return read_out(con, read_row(con, read_id))
    finally:
        con.close()


def eval_hit(store: Store, slide_id: str, sd: SlideData, regions) -> list[int | None]:
    """Evaluation-only: does an alert region touch expert-annotated tumour? Stored on the
    alert row, never returned by review endpoints."""
    p = store.paths.eval_dir / "labels" / f"{slide_id}.parquet"
    if not p.exists():
        return [None] * len(regions)
    lab = pd.read_parquet(p)
    if len(lab) != len(sd.tiles) or not (lab["tile_id"].to_numpy() == sd.tiles["tile_id"].to_numpy()).all():
        return [None] * len(regions)
    g = np.zeros(sd.grid.shape, np.float32)
    g[sd.rows, sd.cols] = lab["tumor_overlap"].to_numpy()
    return [int((g[r.rows, r.cols] > 0).any()) for r in regions]


def run_signout(store: Store, con, read: dict, decision: str, max_regions: int = 2, session_id=None) -> SignoutOut:
    sd = load_slide(store, read["slide_id"])
    c, n = coverage_for(store, con, read, sd)
    store.paths.coverage_dir.mkdir(parents=True, exist_ok=True)
    np.save(store.paths.coverage(read["read_id"]), c.as_array())
    attempt = int(read.get("signout_attempts") or 0) + 1
    con.execute("UPDATE reads SET signout_attempts=?, final_decision=COALESCE(final_decision, initial_decision, ?), "
                "signed_out_at=? WHERE read_id=?", (attempt, decision, db.now(), read["read_id"]))
    if not read["initial_decision"]:
        con.execute("UPDATE reads SET initial_decision=? WHERE read_id=?", (decision, read["read_id"]))
    if read["source"] == "live":  # replays never change a real case's review status
        con.execute("UPDATE cases SET review_status='signed_out' WHERE case_id=?", (read["case_id"],))
    if decision != "benign":
        con.execute("UPDATE reads SET last_light='not_required' WHERE read_id=?", (read["read_id"],))
        audit(con, "signout_check", read_id=read["read_id"], case_id=read["case_id"], session_id=session_id,
              detail={"light": "not_required", "decision": decision})
        con.commit()
        return SignoutOut(read_id=read["read_id"], light="not_required", unseen_risk=None, unseen_tissue_share=None,
                          thresholds={}, reason="coverage check runs on benign sign-outs only",
                          coverage_mode=c.mode)
    th = load_light_thresholds(store.paths.thresholds)
    res = unseen_check(sd.grid, sd.rows, sd.cols, sd.tissue, sd.col("tumor_prob_smooth"), c.seen, th, max_regions)
    regions_out = []
    if res.regions:
        tag = f"{read['read_id']}#{attempt}"
        ids = write_regions(con, sd.slide_id, "unseen", res.regions, source="unseen_check",
                            read_id=read["read_id"], id_tag=tag)
        hits = eval_hit(store, sd.slide_id, sd, res.regions)
        for reg, rid, hit in zip(res.regions, ids, hits):
            aid = new_id("alert")
            con.execute("INSERT INTO alerts (alert_id, read_id, region_id, shown_rank, status, light, created_at, hit_tumor) "
                        "VALUES (?,?,?,?,?,?,?,?)", (aid, read["read_id"], rid, reg.rank, "shown", res.light, db.now(), hit))
            peak = int(sd.lut()[reg.peak_row, reg.peak_col])
            x, y, w, h = reg.bbox
            regions_out.append({"region_id": rid, "kind": "unseen", "rank": reg.rank, "risk": reg.risk,
                                "disagreement": None, "n_tiles": reg.n_tiles,
                                "peak_tile_id": sd.tiles.tile_id.iat[peak], "source": "unseen_check",
                                "x": x, "y": y, "w": w, "h": h, "alert_id": aid, "alert_status": "shown",
                                "exemplars": exemplar_payload(store.similar(sd, peak))})
    con.execute("UPDATE reads SET last_light=? WHERE read_id=?", (res.light, read["read_id"]))
    audit(con, "signout_check", read_id=read["read_id"], case_id=read["case_id"], session_id=session_id,
          detail={"light": res.light, "unseen_risk": res.unseen_risk, "attempt": attempt,
                  "alerts": [r["alert_id"] for r in regions_out], "thresholds_source": th.get("source")})
    if regions_out:
        audit(con, "alerts_shown", read_id=read["read_id"], case_id=read["case_id"],
              detail={"alerts": [r["alert_id"] for r in regions_out]})
    con.commit()
    return SignoutOut(read_id=read["read_id"], light=res.light, unseen_risk=res.unseen_risk,
                      unseen_tissue_share=res.unseen_tissue_share, thresholds=th, regions=regions_out,
                      reason=res.reason, coverage_mode=c.mode)


@router.post("/reads/{read_id}/signout", response_model=SignoutOut)
def signout(read_id: str, body: SignoutIn, store: Store = Depends(get_store)):
    con = store.con()
    try:
        return run_signout(store, con, read_row(con, read_id), body.decision, body.max_regions, body.session_id)
    finally:
        con.close()
