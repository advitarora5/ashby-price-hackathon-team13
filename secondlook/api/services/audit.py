"""Audit service: ordered review events (blind vs aided, overrides, agreement)."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends

from secondlook.api.schemas import AuditIn
from secondlook.api.services.common import audit
from secondlook.api.store import Store, get_store
from secondlook.store import db

router = APIRouter(tags=["audit"])

CLIENT_ACTIONS = {"slide_navigation", "alert_clicked", "region_clicked", "jump_link_clicked", "layer_toggled",
                  "evidence_panel_opened", "second_read_requested", "note"}


@router.post("/audit")
def post_audit(body: AuditIn, store: Store = Depends(get_store)):
    con = store.con()
    try:
        action = body.action if body.action in CLIENT_ACTIONS else f"client:{body.action}"
        audit(con, action, read_id=body.read_id, case_id=body.case_id, session_id=body.session_id,
              ai_visible=body.ai_visible, detail=body.detail)
        con.commit()
        return {"ok": True, "action": action}
    finally:
        con.close()


@router.get("/audit")
def get_audit(read_id: str | None = None, case_id: str | None = None, limit: int = 200,
              store: Store = Depends(get_store)):
    con = store.con()
    try:
        where, args = [], []
        if read_id:
            where.append("read_id=?"), args.append(read_id)
        if case_id:
            where.append("case_id=?"), args.append(case_id)
        q = "SELECT * FROM audit_events" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY event_id LIMIT ?"
        rows = db.all_(con, q, *args, limit)
        for r in rows:
            r["detail"] = json.loads(r["detail"]) if r["detail"] else None
        return rows
    finally:
        con.close()


@router.get("/audit/summary")
def audit_summary(store: Store = Depends(get_store)):
    """Agreement monitor: overrides and blind-vs-aided counts over live reads."""
    con = store.con()
    try:
        fin = db.all_(con, "SELECT review_order, override FROM audit_events WHERE action='final_assessment'")
        reads = db.all_(con, "SELECT review_mode, initial_decision, final_decision FROM reads WHERE source='live' "
                             "AND final_decision IS NOT NULL")
        n = len(fin)
        return {"final_assessments": n, "overrides": sum(1 for r in fin if r["override"]),
                "override_rate": (sum(1 for r in fin if r["override"]) / n) if n else None,
                "by_order": {m: sum(1 for r in reads if r["review_mode"] == m) for m in ("blind", "aided")}}
    finally:
        con.close()
