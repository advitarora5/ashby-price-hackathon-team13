"""Clef (Cloudflare's multimodal decision model) as the bridge between words and the slide.

Clef answers typed questions about a state (text, data, up to 4 images) with a
probability per option. Claripath uses it where language is involved and leaves
looking at tissue to the pathology encoders:

  findings      a reader's notes or a pathology report -> present / absent / not
                mentioned for each finding in config/clef.yaml
  compare       those findings vs what the AI sees on the slide (feature prevalence)
  referee       why two models disagree on a region (api/services/clef.py)

Credentials come from the environment (.env, never committed):
    CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, optional SECONDLOOK_CLEF_MODEL (clef | clef-flash)

To remove the feature: delete this module, config/clef.yaml, api/services/clef.py and
its router line in api/main.py, eval/report_mining.py, eval/referee_eval.py and
frontend/src/components/NotesCheck.tsx with its mount in App.tsx.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from secondlook.config import REPO_ROOT

CLEF_YAML = REPO_ROOT / "config" / "clef.yaml"
ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}"
ANSWERS = ("present", "absent", "not_mentioned")
PRESENT_P = 0.5          # calibrated probability at which a tile counts as showing a feature
PRESENT_SHARE = 0.02     # ... and the share of clean tissue at which the slide counts as showing it
MIN_TILES = 5


class ClefUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Finding:
    id: str
    feature: str | None
    about: str
    keywords: tuple[str, ...] = ()


def load_findings(path: Path = CLEF_YAML) -> tuple[str, list[Finding]]:
    d = yaml.safe_load(Path(path).read_text())
    return d["version"], [Finding(f["id"], None if f["feature"] == "none" else f["feature"], f["about"],
                                  tuple(f.get("keywords", ()))) for f in d["findings"]]


def finding_questions(findings: list[Finding], kind: str = "notes") -> dict:
    """One three-way question per finding. `kind` names the text in the instructions."""
    who = "the pathologist's notes" if kind == "notes" else "this pathology report"
    return {f.id: {"type": "choice",
                   "instructions": f"What do {who} say about {f.about}?",
                   "criteria": {"present": "The text states or clearly implies it is present.",
                                "absent": "The text explicitly says it is absent, negative or not seen.",
                                "not_mentioned": "The text does not address it."}}
            for f in findings}


def image_part(data: bytes, content_type: str = "image/jpeg") -> dict:
    return {"content_type": content_type, "base64": base64.b64encode(data).decode()}


class ClefClient:
    def __init__(self, account: str, token: str, model: str = "clef", timeout: float = 120.0, retries: int = 4):
        self.account, self.token, self.model = account, token, model
        self.timeout, self.retries = timeout, retries

    def ask(self, state, questions: dict, images: list | None = None) -> dict:
        """Answers keyed by question id (schema: developers.cloudflare.com/workers-ai/models/clef)."""
        import requests

        body = {"model": self.model, "state": state, "questions": questions}
        if images:
            body["images"] = images[:4]
        url = ENDPOINT.format(account=self.account, model=self.model)
        for attempt in range(self.retries + 1):
            r = requests.post(url, json=body, timeout=self.timeout, headers={"Authorization": f"Bearer {self.token}"})
            if r.status_code in (429, 500, 502, 503, 504) and attempt < self.retries:
                time.sleep(2 ** attempt)
                continue
            if r.status_code in (401, 403):
                raise ClefUnavailable("Cloudflare rejected the API token (needs Workers AI permission)")
            r.raise_for_status()
            out = r.json()
            out = out.get("result", out)    # the REST API wraps the model output in {"result": ...}
            return out["answers"]
        raise ClefUnavailable("Cloudflare kept returning errors")


def get_client() -> ClefClient:
    account, token = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        raise ClefUnavailable("Clef is not set up: add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to .env")
    return ClefClient(account, token, os.environ.get("SECONDLOOK_CLEF_MODEL", "clef"))


def extract_findings(client: ClefClient, text: str, findings: list[Finding], kind: str = "notes") -> dict[str, dict]:
    """{finding_id: {answer, p: {present, absent, not_mentioned}, confidence}}."""
    answers = client.ask(text, finding_questions(findings, kind))
    out = {}
    for f in findings:
        a = answers.get(f.id) or {}
        p = {k: float((a.get("probabilities") or {}).get(k, 0.0)) for k in ANSWERS}
        out[f.id] = {"answer": a.get("choice") if a.get("choice") in ANSWERS else max(p, key=p.get),
                     "p": p, "confidence": float(a.get("confidence", max(p.values())))}
    return out


def text_digest(text: str) -> str:
    return hashlib.sha256(text.strip().encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- slide side
def feature_prevalence(tiles: pd.DataFrame, scores: pd.DataFrame, feature_ids: list[str]) -> dict[str, dict]:
    """Per feature: share of clean tissue tiles that show it. Only calibrated features can be
    measured this way; text-prior features are reported as unvalidated."""
    clean = ~tiles["art_blank"].to_numpy() & ~tiles["artifact"].to_numpy()
    n = int(clean.sum())
    out = {}
    for f in feature_ids:
        col = f"feat_{f}_cal"
        if col not in scores:
            out[f] = {"measurable": False, "reason": "AI bar is unvalidated (text prior only)"}
            continue
        v = scores[col].to_numpy()[clean]
        k = int(np.sum(v >= PRESENT_P))
        share = k / n if n else 0.0
        out[f] = {"measurable": True, "share": round(share, 4), "n_tiles": k,
                  "present": bool(share >= PRESENT_SHARE and k >= MIN_TILES)}
    return out


CATEGORY_ORDER = ("contradiction", "possibly_missed", "not_found", "confirmed", "agrees_absent", "cannot_check")


def compare(found: dict[str, dict], prevalence: dict[str, dict], findings: list[Finding]) -> list[dict]:
    """Text findings vs slide prevalence. Findings nobody mentions and the AI does not see are dropped."""
    rows = []
    for f in findings:
        said = found.get(f.id, {"answer": "not_mentioned", "p": {}, "confidence": 0.0})
        ans = said["answer"]
        slide = prevalence.get(f.feature) if f.feature else None
        if f.feature is None or not slide or not slide.get("measurable"):
            if ans == "not_mentioned":
                continue
            cat = "cannot_check"
            why = "the AI cannot check this on the slide" if f.feature is None else slide.get("reason", "") if slide else ""
        else:
            seen = slide["present"]
            cat = {("present", True): "confirmed", ("present", False): "not_found",
                   ("absent", True): "contradiction", ("absent", False): "agrees_absent",
                   ("not_mentioned", True): "possibly_missed"}.get((ans, seen))
            if cat is None:
                continue
            why = ""
        rows.append({"finding": f.id, "feature": f.feature, "about": f.about, "category": cat, "said": ans,
                     "said_p": round(said["p"].get(ans, 0.0), 3) if said["p"] else None,
                     "confidence": round(said["confidence"], 3),
                     "slide_share": slide.get("share") if slide else None, "reason": why})
    rows.sort(key=lambda r: (CATEGORY_ORDER.index(r["category"]), -(r["slide_share"] or 0)))
    return rows


def dumps(obj) -> str:
    return json.dumps(obj, default=lambda o: o.item() if hasattr(o, "item") else str(o))


# --------------------------------------------------------------------------- referee
REFEREE_QUESTIONS = {
    "explanation": {
        "type": "choice",
        "instructions": ("An AI system flagged this region of a lymph-node slide (H&E). Using the measurements in the "
                         "state and the images, what is the most likely explanation of the region?"),
        "criteria": {
            "real_tumour": "Metastatic tumour: the tumour models and the tissue features point the same way.",
            "benign_mimic": "Benign tissue that resembles tumour (e.g. germinal centres, histiocytes, vessels).",
            "artifact": "A scanning or preparation artifact (blur, ink, fold, debris) is driving the scores.",
            "ambiguous": "The evidence conflicts; an expert needs to look closely.",
        },
    },
    "needs_expert": {"type": "noul", "instructions": "Should an expert re-examine this region at high magnification?"},
}


def region_state(tiles: pd.DataFrame, scores: pd.DataFrame | None, rect: dict, region: dict, mpp: float,
                 feature_labels: dict[str, str], exemplars: dict | None = None, context: list | None = None) -> dict:
    """Plain measurements about one region, for the referee. No images, no labels."""
    x, y, w, h = rect["x"], rect["y"], rect["w"], rect["h"]
    inside = ((tiles["x"] + tiles["w0"] / 2 >= x) & (tiles["x"] + tiles["w0"] / 2 <= x + w)
              & (tiles["y"] + tiles["w0"] / 2 >= y) & (tiles["y"] + tiles["w0"] / 2 <= y + h)
              & ~tiles["art_blank"]).to_numpy()
    t = tiles[inside]
    state = {"region": {"kind": region.get("kind"), "width_mm": round(w * mpp / 1000, 2),
                        "height_mm": round(h * mpp / 1000, 2), "tissue_tiles": int(inside.sum())},
             "artifacts_share_of_region": {k: round(float(t[f"art_{k}"].mean()), 3) if len(t) else None
                                           for k in ("blur", "ink", "fold")}}
    if scores is not None and len(t):
        s = scores[inside]

        def stat(col):
            v = s[col].to_numpy(dtype=float) if col in s else np.array([])
            v = v[np.isfinite(v)]
            return {"mean": round(float(v.mean()), 3), "max": round(float(v.max()), 3)} if len(v) else None

        state["tumour_probability"] = stat("tumor_prob")
        state["model_disagreement_percentile"] = stat("disagreement")
        state["uncertainty"] = stat("uncertainty")
        feats = {}
        for fid, label in feature_labels.items():
            col = f"feat_{fid}_cal"
            if col in s:
                feats[label] = round(float(np.nanmean(s[col].to_numpy(dtype=float))), 3)
        state["tissue_features_mean_probability"] = dict(sorted(feats.items(), key=lambda kv: -kv[1])[:6])
    if exemplars and exemplars.get("available"):
        state["most_similar_labelled_tiles"] = {
            lab: [round(float(h["similarity"]), 3) for h in exemplars.get(lab, [])] for lab in ("tumor", "benign")}
    if context:
        state["surroundings_of_peak_tile"] = context
    return state


def region_crop(slide_path: str | None, thumb_path: Path | None, slide_width: int, rect: dict,
                pad: float = 1.0, max_px: int = 768) -> bytes | None:
    """JPEG of the region with `pad` x its size around it: from the whole-slide file when present,
    else from the thumbnail."""
    import io

    from PIL import Image

    x0, y0 = rect["x"] - pad * rect["w"], rect["y"] - pad * rect["h"]
    w0, h0 = rect["w"] * (1 + 2 * pad), rect["h"] * (1 + 2 * pad)
    img = None
    if slide_path and Path(slide_path).exists():
        try:
            import openslide

            sl = openslide.OpenSlide(slide_path)
            want = max(w0, h0) / max_px
            level = sl.get_best_level_for_downsample(want)
            ds = sl.level_downsamples[level]
            img = sl.read_region((int(max(x0, 0)), int(max(y0, 0))), level,
                                 (max(1, int(w0 / ds)), max(1, int(h0 / ds)))).convert("RGB")
        except Exception:  # unreadable file: fall back to the thumbnail
            img = None
    if img is None and thumb_path and Path(thumb_path).exists():
        th = Image.open(thumb_path).convert("RGB")
        s = th.width / slide_width
        img = th.crop((int(max(x0, 0) * s), int(max(y0, 0) * s), int((x0 + w0) * s), int((y0 + h0) * s)))
    if img is None or img.width < 2 or img.height < 2:
        return None
    img.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()
