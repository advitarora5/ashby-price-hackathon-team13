"""Replay: push a recorded PathoGaze read through the *same* coverage and sign-out
code used for live reads. Nothing is scripted: each step inserts the next real
events into view_events and recomputes coverage; the final step runs the real
sign-out check with the pathologist's recorded decision."""
from __future__ import annotations

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException

from secondlook.api.schemas import ReplayStart, ReplayStep, ViewEvent
from secondlook.api.services.common import audit, read_row
from secondlook.api.services.coverage import coverage_for, coverage_out, ingest_events, mark_revisits, run_signout
from secondlook.api.services.common import load_slide
from secondlook.api.store import Store, get_store
from secondlook.ids import new_id
from secondlook.pipeline.datasets.pathogaze import is_benign_call
from secondlook.store import db

router = APIRouter(tags=["replay"])
_events: pd.DataFrame | None = None


def recorded_events(store: Store) -> pd.DataFrame:
    global _events
    if _events is None:
        p = store.paths.events("pathogaze")
        if not p.exists():
            raise HTTPException(409, "PathoGaze events not ingested (python -m secondlook.pipeline.ingest pathogaze)")
        _events = pd.read_parquet(p)
    return _events


def _map_decision(d: str) -> str:
    return "benign" if is_benign_call(d) else "malignant" if str(d).lower() == "malignant" else "suspicious"


@router.get("/replay/reads")
def list_recorded(case_id: str | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        q = """SELECT r.read_id, r.case_id, r.slide_id, r.reader_id, r.initial_decision AS decision, r.seconds,
                      rd.experience_level FROM reads r LEFT JOIN readers rd USING(reader_id)
               WHERE r.source='pathogaze'""" + (" AND r.case_id=?" if case_id else "") + " ORDER BY r.read_id"
        return db.all_(con, q, *([case_id] if case_id else []))
    finally:
        con.close()


@router.post("/replay/start")
def start(body: ReplayStart, store: Store = Depends(get_store)):
    con = store.con()
    try:
        src = read_row(con, body.source_read_id)
        if src["source"] != "pathogaze":
            raise HTTPException(400, "only recorded PathoGaze reads can be replayed")
        ev = recorded_events(store)
        kind = "fixation" if body.coverage_mode == "gaze" else "viewport"
        n = int(((ev.read_id == src["read_id"]) & (ev.kind == kind)).sum())
        if n == 0:
            raise HTTPException(409, f"no {kind} events recorded for {src['read_id']}")
        rid = new_id("replay")
        db.upsert(con, "reads", {"read_id": rid, "slide_id": src["slide_id"], "case_id": src["case_id"],
                                 "reader_id": src["reader_id"], "source": "replay", "review_mode": "unaided",
                                 "coverage_mode": body.coverage_mode, "replay_of": src["read_id"],
                                 "started_at": db.now()})
        db.upsert(con, "replay_state", {"replay_read_id": rid, "source_read_id": src["read_id"], "cursor": 0,
                                        "n_events": n, "done": 0})
        audit(con, "replay_started", read_id=rid, case_id=src["case_id"],
              detail={"source_read_id": src["read_id"], "mode": body.coverage_mode, "n_events": n})
        con.commit()
        return {"replay_read_id": rid, "n_events": n, "source_read_id": src["read_id"],
                "recorded_decision": _map_decision(src["initial_decision"])}
    finally:
        con.close()


@router.post("/replay/{read_id}/step", response_model=ReplayStep)
def step(read_id: str, n: int = 25, store: Store = Depends(get_store)):
    con = store.con()
    try:
        st = db.one(con, "SELECT * FROM replay_state WHERE replay_read_id=?", read_id)
        if st is None:
            raise HTTPException(404, "unknown replay; POST /replay/start first")
        read = read_row(con, read_id)
        src = read_row(con, st["source_read_id"])
        kind = "fixation" if read["coverage_mode"] == "gaze" else "viewport"
        ev = recorded_events(store)
        ev = ev[(ev.read_id == st["source_read_id"]) & (ev.kind == kind)].sort_values(["t_ms", "seq"])
        chunk = ev.iloc[st["cursor"]: st["cursor"] + max(1, n)]
        events = [ViewEvent(seq=int(r.seq), t_ms=float(r.t_ms), kind=kind, x=float(r.x), y=float(r.y),
                            w=None if pd.isna(r.w) else float(r.w), h=None if pd.isna(r.h) else float(r.h),
                            zoom=float(r.zoom), duration_ms=None if pd.isna(r.duration_ms) else float(r.duration_ms),
                            eye_mm=None if pd.isna(r.eye_mm) else float(r.eye_mm)) for r in chunk.itertuples()]
        ingest_events(con, read_id, events)
        cursor = st["cursor"] + len(chunk)
        done = cursor >= st["n_events"]
        con.execute("UPDATE replay_state SET cursor=?, done=? WHERE replay_read_id=?", (cursor, int(done), read_id))
        con.commit()
        sd = load_slide(store, read["slide_id"])
        c, cnt = coverage_for(store, con, read, sd)
        mark_revisits(con, read_id, sd, c)
        decision = _map_decision(src["initial_decision"])
        signout = None
        if done and not st["done"]:
            con.execute("UPDATE reads SET initial_decision=? WHERE read_id=?", (decision, read_id))
            con.commit()
            signout = run_signout(store, con, read_row(con, read_id), decision)
        con.commit()
        last = chunk.iloc[-1] if len(chunk) else None
        # the viewport the reader had at this moment (for the viewer to follow)
        vp = None
        if last is not None:
            full = recorded_events(store)
            vrows = full[(full.read_id == st["source_read_id"]) & (full.kind == "viewport") & (full.t_ms <= last.t_ms)]
            if len(vrows):
                v = vrows.iloc[-1]
                vp = {"x": float(v.x), "y": float(v.y), "w": float(v.w), "h": float(v.h), "zoom": float(v.zoom)}
        fx = None if last is None or kind != "fixation" else {"x": float(last.x), "y": float(last.y),
                                                              "zoom": float(last.zoom)}
        return ReplayStep(replay_read_id=read_id, cursor=cursor, n_events=st["n_events"], done=done,
                          t_ms=None if last is None else float(last.t_ms), viewport=vp, last_fixation=fx,
                          coverage=coverage_out(read, sd, c, cnt), signout=signout, recorded_decision=decision)
    finally:
        con.close()


@router.get("/replay/tally")
def tally(store: Store = Depends(get_store)):
    """Evaluation view over finished replays (uses expert masks; not part of the review UI)."""
    con = store.con()
    try:
        rows = db.all_(con, """
            SELECT r.read_id, r.replay_of, r.slide_id, r.last_light, s.slide_label,
                   (SELECT COUNT(*) FROM alerts a WHERE a.read_id=r.read_id) AS n_alerts,
                   (SELECT MAX(hit_tumor) FROM alerts a WHERE a.read_id=r.read_id) AS any_hit
            FROM reads r JOIN slides s USING(slide_id)
            WHERE r.source='replay' AND r.signed_out_at IS NOT NULL AND r.initial_decision='benign'""")
        miss = [r for r in rows if r["slide_label"] == "tumor"]
        return {"benign_replays": len(rows), "benign_on_tumor_slides": len(miss),
                "caught": sum(1 for r in miss if r["any_hit"]),
                "alerts_on_benign_slides": sum(r["n_alerts"] for r in rows if r["slide_label"] != "tumor"),
                "rows": rows, "note": "replays only; the offline evaluation (eval/unseen.json) is the reported result"}
    finally:
        con.close()
