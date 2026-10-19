"""Shared helpers for the service routers."""
from __future__ import annotations

import json

from fastapi import HTTPException

from secondlook.api.store import Store, Unavailable
from secondlook.store import db


def case_row(con, case_id: str) -> dict:
    row = db.one(con, """SELECT c.*, s.organ, s.dataset, s.width, s.height, s.mpp, s.tile_w0, s.grid_rows,
                                s.grid_cols, s.status, s.status_detail
                         FROM cases c JOIN slides s USING(slide_id) WHERE c.case_id=?""", case_id)
    if row is None:
        raise HTTPException(404, f"case {case_id} not found")
    return row


def read_row(con, read_id: str) -> dict:
    row = db.one(con, "SELECT * FROM reads WHERE read_id=?", read_id)
    if row is None:
        raise HTTPException(404, f"read {read_id} not found")
    return row


def requires_blind(case: dict, blind_all: bool = False) -> bool:
    return blind_all or case.get("tier") == "slow"


def evidence_gate(case: dict, read: dict | None) -> tuple[bool, str | None]:
    """Disagreement service rule: in blind mode, AI evidence stays hidden until the
    reader has saved their own notes and recorded an initial assessment."""
    if read is None:
        if case.get("tier") == "slow":
            return False, "slow-path case: start a read and record your own notes and assessment first"
        return True, None
    if read.get("review_mode") == "blind":
        missing = [w for w, ok in (("save your notes", read.get("notes_saved_at")),
                                   ("record your assessment", read.get("initial_decision"))) if not ok]
        if missing:
            return False, f"blind review: {' and '.join(missing)} to reveal AI evidence"
    return True, None


def audit(con, action: str, *, read_id=None, case_id=None, session_id=None, ai_visible=None, review_order=None,
          decision_before=None, decision_after=None, override=None, detail=None) -> None:
    con.execute("""INSERT INTO audit_events (ts, session_id, read_id, case_id, action, ai_visible, review_order,
                   decision_before, decision_after, override, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (db.now(), session_id, read_id, case_id, action, None if ai_visible is None else int(ai_visible),
                 review_order, decision_before, decision_after, None if override is None else int(override),
                 json.dumps(detail) if detail is not None else None))


def exemplar_payload(hits: dict) -> dict:
    out = {"available": hits.get("available", False), "reason": hits.get("reason"), "tumor": [], "benign": []}
    for lab in ("tumor", "benign"):
        for h in hits.get(lab, []):
            out[lab].append({**{k: h[k] for k in ("exemplar_id", "slide_id", "label", "similarity")},
                             "image_url": f"/api/exemplars/{h['image']}"})
    return out


def unavailable(e: Unavailable, status: int = 409):
    return HTTPException(status, {"available": False, "what": e.what, "reason": e.reason})


def load_slide(store: Store, slide_id: str):
    try:
        return store.slide(slide_id)
    except Unavailable as e:
        raise unavailable(e)
