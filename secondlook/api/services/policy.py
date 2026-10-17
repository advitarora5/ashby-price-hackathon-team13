"""Policy service: per-read second-reader recommendation and offline policy results."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException

from secondlook.api.schemas import PolicyOut
from secondlook.api.services.common import audit, case_row, read_row
from secondlook.api.store import Store, get_store
from secondlook.config import REGION_RISK_THRESHOLD
from secondlook.core.policy import recommend
from secondlook.store import db

router = APIRouter(tags=["policy"])


def _positive(decision: str | None) -> bool | None:
    return None if decision is None else decision != "benign"


@router.get("/reads/{read_id}/policy", response_model=PolicyOut)
def read_policy(read_id: str, store: Store = Depends(get_store)):
    con = store.con()
    try:
        read = read_row(con, read_id)
        case = case_row(con, read["case_id"])
        decision = read["final_decision"] or read["initial_decision"]
        if decision is None:
            raise HTTPException(409, "record an assessment before asking for a review recommendation")
        th = store.thresholds().get("ai_case_cutoff")
        cutoff = th["value"] if isinstance(th, dict) else th
        src = (th.get("source") if isinstance(th, dict) else "thresholds.json") if th is not None else None
        if cutoff is None:
            cutoff, src = REGION_RISK_THRESHOLD, "default_unvalidated"
        ai_pos = None if case["ai_max_risk"] is None else bool(case["ai_max_risk"] >= cutoff)
        models_agree = None if case.get("tier") in (None, "unavailable") else case["tier"] == "fast"
        humans = [_positive(d) for d in (read.get("second_decision"), read.get("third_decision")) if d]
        rec = recommend(_positive(decision), ai_pos, models_agree, read.get("last_light"), humans)
        audit(con, "policy_recommendation", read_id=read_id, case_id=read["case_id"],
              detail={"suggestion": rec.suggestion, "checks": rec.checks})
        con.commit()
        return PolicyOut(read_id=read_id, one_read_enough=rec.one_read_enough, suggestion=rec.suggestion,
                         reasons=rec.reasons, checks=rec.checks,
                         ai_flag_source=f"max smoothed tumour risk >= {cutoff:.2f} ({src})")
    finally:
        con.close()


@router.get("/policy/summary")
def policy_summary(policy: str | None = None, store: Store = Depends(get_store)):
    con = store.con()
    try:
        q = "SELECT * FROM policy_runs" + (" WHERE policy=?" if policy else "") + " ORDER BY reads_per_100"
        rows = db.all_(con, q, *([policy] if policy else []))
    finally:
        con.close()
    for r in rows:
        r["params"] = json.loads(r["params"]) if r["params"] else {}
    p = store.paths.eval_dir / "policy.json"
    meta = {}
    if p.exists():
        d = json.loads(p.read_text())
        meta = {k: d[k] for k in ("dataset", "n_patches", "n_slides", "bootstrap", "noninferiority_margin",
                                  "reference_policy", "ai_source", "note", "per_resident") if k in d}
    if not rows:
        return {"available": False, "reason": "policy evaluation has not been run (python -m secondlook.eval.policy_eval)",
                "runs": []}
    return {"available": True, "runs": rows, **meta}
