"""Disagreement service: case queue sorted by model disagreement, fast/slow tiers,
and the rule for which AI evidence is visible during blind review."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from secondlook.api.schemas import CaseDetail, CaseRow
from secondlook.api.services.common import case_row, load_slide, requires_blind
from secondlook.api.store import Store, get_store
from secondlook.store import db

router = APIRouter(tags=["disagreement"])


@router.get("/cases", response_model=list[CaseRow])
def list_cases(store: Store = Depends(get_store)):
    con = store.con()
    try:
        rows = db.all_(con, """
            SELECT c.case_id, c.slide_id, s.organ, s.dataset, c.disagreement_score, c.disagreement_source,
                   c.uncertainty_score, COALESCE(c.routing_signal, 'disagreement') AS routing_signal,
                   COALESCE(c.tier,'unavailable') AS tier, c.tier_rule, c.artifact_share, c.tissue_artifact_share, c.tier_reasons, c.review_status,
                   (SELECT COUNT(*) FROM reads r WHERE r.case_id=c.case_id AND r.source='pathogaze') AS recorded_reads
            FROM cases c JOIN slides s USING(slide_id)
            WHERE s.status='ok'
            ORDER BY CASE WHEN c.routing_signal='entropy' THEN c.uncertainty_score ELSE c.disagreement_score END IS NULL,
                     CASE WHEN c.routing_signal='entropy' THEN c.uncertainty_score ELSE c.disagreement_score END DESC,
                     c.case_id""")
    finally:
        con.close()
    for r in rows:
        r["tier_reasons"] = _reasons(r["tier_reasons"])
    return rows


def _reasons(s: str | None) -> list[str]:
    return s.split(",") if s else []


@router.get("/cases/{case_id}", response_model=CaseDetail)
def get_case(case_id: str, store: Store = Depends(get_store)):
    con = store.con()
    try:
        c = case_row(con, case_id)
        c["recorded_reads"] = db.one(con, "SELECT COUNT(*) n FROM reads WHERE case_id=? AND source='pathogaze'", case_id)["n"]
    finally:
        con.close()
    sd = load_slide(store, c["slide_id"])
    layers = ["tissue", "artifact"]
    if sd.col("tumor_prob_smooth") is not None:
        layers.append("risk")
    if sd.col("disagreement") is not None:
        layers.append("disagreement")
    try:
        store.deepzoom(c["slide_id"])
        dzi = f"/api/slides/{c['slide_id']}/slide.dzi"
    except Exception:
        dzi = None
    c["tier"] = c.get("tier") or "unavailable"
    c["routing_signal"] = c.get("routing_signal") or "disagreement"
    c["tier_reasons"] = _reasons(c.get("tier_reasons"))
    return CaseDetail(**{k: c[k] for k in CaseRow.model_fields if k in c},
                      width=c["width"], height=c["height"], mpp=c["mpp"], tile_w0=c["tile_w0"],
                      grid_rows=c["grid_rows"], grid_cols=c["grid_cols"], dzi_url=dzi,
                      thumbnail_url=f"/api/slides/{c['slide_id']}/thumbnail.jpg", layers=layers,
                      problems=sd.problems, requires_blind=requires_blind(c))
