"""Clef integration: request/response handling, notes-vs-slide comparison, gating and caching.
Clef itself is replaced by a stand-in; its accuracy is measured by eval/report_mining.py."""
import pytest

from secondlook import clef
from secondlook.eval.report_mining import keyword_answer
from tests.conftest import CASE, SLOW_SLIDE


class StubClef:
    model = "stub"

    def __init__(self, said: dict[str, str]):
        self.said, self.calls = said, []

    def ask(self, state, questions, images=None):
        self.calls.append((state, questions, images))
        out = {}
        for qid, q in questions.items():
            if q["type"] == "noul":
                out[qid] = {"type": "noul", "noul": 0.7}
                continue
            pick = self.said.get(qid, "not_mentioned")
            if pick not in q["criteria"]:
                pick = "not_mentioned" if "not_mentioned" in q["criteria"] else list(q["criteria"])[0]
            probs = {k: (0.8 if k == pick else 0.2 / (len(q["criteria"]) - 1)) for k in q["criteria"]}
            out[qid] = {"type": "choice", "choice": pick, "probabilities": probs, "confidence": 0.8}
        return out


def _f(fid, feature):
    return clef.Finding(fid, feature, fid)


def _said(answer):
    return {"answer": answer, "p": {answer: 0.9}, "confidence": 0.9}


def test_compare_sorts_findings_into_categories():
    findings = [_f("a", "fa"), _f("b", "fb"), _f("c", "fc"), _f("d", "fd"), _f("e", None), _f("g", "fg")]
    prev = {"fa": {"measurable": True, "present": True, "share": 0.3},
            "fb": {"measurable": True, "present": True, "share": 0.1},
            "fc": {"measurable": True, "present": False, "share": 0.0},
            "fd": {"measurable": True, "present": True, "share": 0.05},
            "fg": {"measurable": False, "reason": "unvalidated"}}
    found = {"a": _said("present"), "b": _said("absent"), "c": _said("present"), "d": _said("not_mentioned"),
             "e": _said("present"), "g": _said("not_mentioned")}
    cats = {r["finding"]: r["category"] for r in clef.compare(found, prev, findings)}
    assert cats == {"a": "confirmed", "b": "contradiction", "c": "not_found", "d": "possibly_missed", "e": "cannot_check"}
    order = [r["category"] for r in clef.compare(found, prev, findings)]
    assert order[0] == "contradiction" and order[-1] == "cannot_check"


def test_keyword_baseline_handles_simple_negation():
    f = clef.Finding("necrosis_debris", "necrosis_debris", "necrosis", ("necros",))
    assert keyword_answer("Extensive tumour necrosis is present.", f) == "present"
    assert keyword_answer("No necrosis is identified.", f) == "absent"
    assert keyword_answer("Margins are clear.", f) == "not_mentioned"


def test_client_unwraps_the_cloudflare_response(monkeypatch):
    sent = {}

    class R:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"success": True, "result": {"model": "clef", "answers": {"q": {"type": "noul", "noul": 0.9}},
                                                "usage": {"input_tokens": 5, "output_tokens": 0}}}

    import requests

    monkeypatch.setattr(requests, "post", lambda url, json, timeout, headers: sent.update(url=url, body=json, h=headers) or R())
    a = clef.ClefClient("acct", "tok").ask("text", {"q": {"type": "noul", "instructions": "?"}}, [clef.image_part(b"x")])
    assert a == {"q": {"type": "noul", "noul": 0.9}}
    assert sent["url"].endswith("/accounts/acct/ai/run/@cf/cloudflare/clef") and sent["h"]["Authorization"] == "Bearer tok"
    assert sent["body"]["images"][0]["content_type"] == "image/jpeg"


def _reveal(c, case):
    r = c.post("/api/reads", json={"case_id": case}).json()
    c.put(f"/api/reads/{r['read_id']}/notes", json={"notes": "Sheets of atypical cells; lymphovascular invasion present."})
    c.post(f"/api/reads/{r['read_id']}/decision", json={"stage": "initial", "decision": "malignant"})
    return r["read_id"]


def test_notes_check_is_gated_needs_setup_then_flags_and_caches(client, monkeypatch):
    c, _, _ = client
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    slow = c.post("/api/reads", json={"case_id": f"case_{SLOW_SLIDE}"}).json()
    assert c.post(f"/api/reads/{slow['read_id']}/notes-check").status_code == 403      # blind read: AI still hidden
    rid = _reveal(c, CASE)
    r = c.post(f"/api/reads/{rid}/notes-check")
    assert r.status_code == 503 and "CLOUDFLARE" in r.json()["detail"]
    stub = StubClef({"irregular_nuclei": "present", "lymphovascular_invasion": "present"})
    monkeypatch.setattr(clef, "get_client", lambda: stub)
    out = c.post(f"/api/reads/{rid}/notes-check").json()
    cats = {row["finding"]: row["category"] for row in out["rows"]}
    assert cats["metastasis"] == "possibly_missed"           # the AI sees tumour, the notes do not name it
    assert cats["irregular_nuclei"] == "cannot_check"        # that bar is a text prior only
    assert cats["lymphovascular_invasion"] == "cannot_check"
    assert out["rows"][0]["where"]                            # jump links for flagged findings
    again = c.post(f"/api/reads/{rid}/notes-check").json()
    assert again["cached"] and len(stub.calls) == 1
    assert not c.get(f"/api/reads/{rid}/notes-check").json()["stale"]
    c.put(f"/api/reads/{rid}/notes", json={"notes": "Edited notes."})
    assert c.get(f"/api/reads/{rid}/notes-check").json()["stale"]
    log = [e["action"] for e in c.get("/api/audit", params={"read_id": rid}).json()]
    assert "notes_checked" in log


def test_region_referee_sends_measurements_and_returns_probabilities(client, monkeypatch):
    c, _, _ = client
    stub = StubClef({"explanation": "real_tumour"})
    monkeypatch.setattr(clef, "get_client", lambda: stub)
    reg = c.get(f"/api/cases/{CASE}/regions").json()["regions"][0]
    out = c.post(f"/api/cases/{CASE}/regions/{reg['region_id']}/explain").json()
    assert out["explanation"] == "real_tumour" and out["needs_expert"] == pytest.approx(0.7)
    state = stub.calls[0][0]
    assert state["tumour_probability"]["max"] > 0.5 and "slide_label" not in str(state)
    assert c.post(f"/api/cases/{CASE}/regions/{reg['region_id']}/explain").json()["cached"]
    slow_reg = f"case_{SLOW_SLIDE}"
    assert c.post(f"/api/cases/{slow_reg}/regions/{reg['region_id']}/explain").status_code == 403
