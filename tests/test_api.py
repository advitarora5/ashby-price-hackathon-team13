"""End-to-end API flow on the synthetic test bundle (see conftest)."""
from tests.conftest import CASE, SLOW_SLIDE


def test_queue_never_leaks_ground_truth(client):
    c, _, _ = client
    rows = c.get("/api/cases").json()
    assert [r["case_id"] for r in rows][0] == f"case_{SLOW_SLIDE}"  # sorted by disagreement
    assert all("slide_label" not in r for r in rows)
    d = c.get(f"/api/cases/{CASE}").json()
    assert d["dzi_url"] is None and "risk" in d["layers"] and "slide_label" not in d


def test_blind_gate_on_slow_path(client):
    c, _, _ = client
    case = f"case_{SLOW_SLIDE}"
    r = c.post("/api/reads", json={"case_id": case}).json()
    assert r["review_mode"] == "blind" and not r["evidence_visible"]
    ev = c.get(f"/api/cases/{case}/evidence", params={"read_id": r["read_id"]}).json()
    assert ev["hidden"] and ev["features"] == []
    assert c.get(f"/api/cases/{case}/overlay/risk.png", params={"read_id": r["read_id"]}).status_code == 403
    assert c.get(f"/api/cases/{case}/regions", params={"read_id": r["read_id"]}).json()["hidden"]
    c.post(f"/api/reads/{r['read_id']}/decision", json={"stage": "initial", "decision": "benign"})
    ev = c.get(f"/api/cases/{case}/evidence", params={"read_id": r["read_id"]}).json()
    assert not ev["hidden"] and ev["features"]
    log = [e["action"] for e in c.get("/api/audit", params={"read_id": r["read_id"]}).json()]
    assert log.index("blind_assessment") < log.index("evidence_shown")
    assert "evidence_withheld" in log


def test_full_review_flow(client):
    c, grid, tiles = client
    r = c.post("/api/reads", json={"case_id": CASE}).json()
    rid = r["read_id"]
    assert r["review_mode"] == "aided"
    ev = c.get(f"/api/cases/{CASE}/evidence", params={"read_id": rid}).json()
    bars = {b["id"]: b for b in ev["features"]}
    assert bars["metastasis"]["calibrated"] and bars["metastasis"]["jump_links"]
    assert bars["irregular_nuclei"]["badge"] == "text only, unvalidated"
    assert ev["exemplars"]["available"] is False  # no exemplar index in the test bundle -> explicit state
    # look only at the top-left corner at 10x+
    events = [{"seq": 0, "t_ms": 0, "x": 900, "y": 450, "w": 1800, "h": 1000, "zoom": 0.3},
              {"seq": 1, "t_ms": 4000, "x": 0, "y": 0, "w": 10000, "h": 6000, "zoom": 0.02}]
    cov = c.post(f"/api/reads/{rid}/events", json={"events": events}).json()
    assert 0 < cov["seen_share"] < 0.2
    # duplicate events are ignored
    cov2 = c.post(f"/api/reads/{rid}/events", json={"events": events}).json()
    assert cov2["n_events"] == 2
    assert c.get(f"/api/reads/{rid}/coverage.png").headers["content-type"] == "image/png"
    c.post(f"/api/reads/{rid}/decision", json={"stage": "initial", "decision": "benign"})
    so = c.post(f"/api/reads/{rid}/signout", json={"decision": "benign"}).json()
    assert so["light"] in ("amber", "red") and so["thresholds"]["source"] == "default_unvalidated"
    assert len(so["regions"]) >= 1 and so["regions"][0]["alert_id"]
    hot = so["regions"][0]
    assert hot["x"] <= 15 * grid.tile_w0 <= hot["x"] + hot["w"]  # centred on the synthetic hotspot
    pol = c.get(f"/api/reads/{rid}/policy").json()
    assert pol["suggestion"] == "second_read" and pol["checks"]["light_green"] is False
    # revisit the alerted region -> alert marked revisited
    rev = c.post(f"/api/reads/{rid}/events", json={"events": [
        {"seq": 2, "t_ms": 6000, "x": hot["x"], "y": hot["y"], "w": hot["w"], "h": hot["h"], "zoom": 0.4}]}).json()
    assert rev["revisited_alerts"] == [hot["alert_id"]]
    so2 = c.post(f"/api/reads/{rid}/signout", json={"decision": "benign"}).json()
    assert so2["unseen_risk"] < so["unseen_risk"]
    c.post(f"/api/reads/{rid}/decision", json={"stage": "final", "decision": "suspicious"})
    final = [e for e in c.get("/api/audit", params={"read_id": rid}).json() if e["action"] == "final_assessment"][0]
    assert final["override"] == 1 and final["decision_before"] == "benign"
    pol = c.get(f"/api/reads/{rid}/policy").json()
    assert pol["checks"]["reader_ai_agree"] is True


def test_missing_things_are_reported_not_invented(client):
    c, _, _ = client
    assert c.get("/api/cases/nope").status_code == 404
    rid = c.post("/api/reads", json={"case_id": CASE}).json()["read_id"]
    assert c.get(f"/api/reads/{rid}/policy").status_code == 409  # no assessment yet
    assert c.get("/api/policy/summary").json()["available"] is False
    bad = c.post(f"/api/reads/{rid}/events", json={"events": [{"seq": 0, "t_ms": 0, "kind": "fixation", "x": 1,
                                                               "y": 1, "zoom": 1}]})
    assert bad.status_code == 422  # viewport read refuses gaze events


def test_routing_signal_follows_evaluation(bundle):
    import json

    from secondlook.pipeline.export import assign_tiers
    from secondlook.store import db

    paths, _, _ = bundle
    con = db.init_db(paths.db)
    con.execute("UPDATE cases SET uncertainty_score = CASE WHEN case_id LIKE '%slow' THEN 0.1 ELSE 0.9 END")
    paths.thresholds.write_text(json.dumps({"routing_signal": {"signal": "entropy", "source": "test"}}))
    out = assign_tiers(con, paths)
    tiers = {r["case_id"]: r["tier"] for r in db.all_(con, "SELECT case_id, tier FROM cases")}
    assert out["signal"] == "entropy"
    assert tiers[CASE] == "slow" and tiers[f"case_{SLOW_SLIDE}"] == "fast"  # now ranked by uncertainty
    con.close()


def test_replay_style_signout_does_not_touch_case_status(client):
    c, _, _ = client
    from secondlook.api.store import get_store
    from secondlook.store import db

    store = get_store()
    con = store.con()
    db.upsert(con, "reads", {"read_id": "rp1", "slide_id": "synthetic_001", "case_id": CASE, "source": "replay",
                             "coverage_mode": "viewport", "initial_decision": "benign"})
    con.commit()
    con.close()
    assert c.post("/api/reads/rp1/signout", json={"decision": "benign"}).status_code == 200
    assert {r["case_id"]: r["review_status"] for r in c.get("/api/cases").json()}[CASE] == "unread"
