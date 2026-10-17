"""Stage 5: plain-English feature bars.

raw score  = two-way softmax between the mean positive-prompt embedding and the
             mean negative-prompt embedding (CLIP logit scale). It is a *text
             prior*, not a probability, and is never shown as one.
calibrated = isotonic regression mapping the raw score to P(tile has the
             matching label), fit on labelled training tiles only.
Features with `calibrate_on: none` have no calibrated value and carry a
"text only, unvalidated" badge in the API.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import yaml

from secondlook.config import REPO_ROOT

FEATURES_YAML = REPO_ROOT / "config" / "features.yaml"


@dataclass(frozen=True)
class Feature:
    id: str
    label: str
    positive: tuple[str, ...]
    negative: tuple[str, ...]
    calibrate_on: str

    @property
    def calib_source(self) -> str | None:
        return None if self.calibrate_on == "none" else self.calibrate_on


def load_features(path: Path = FEATURES_YAML) -> tuple[str, list[Feature]]:
    d = yaml.safe_load(Path(path).read_text())
    feats = [Feature(f["id"], f["label"], tuple(f["positive"]), tuple(f["negative"]), f.get("calibrate_on", "none"))
             for f in d["features"]]
    return d.get("version", "features"), feats


def _mean_unit(v: np.ndarray) -> np.ndarray:
    m = v.mean(axis=0)
    return m / max(np.linalg.norm(m), 1e-6)


def text_bank(encoder, feats: list[Feature]) -> dict[str, np.ndarray]:
    """{feature_id: [2, D]} positive and negative prototypes for one encoder."""
    out = {}
    for f in feats:
        pos = _mean_unit(encoder.encode_text(list(f.positive)))
        neg = _mean_unit(encoder.encode_text(list(f.negative)))
        out[f.id] = np.stack([pos, neg]).astype(np.float32)
    return out


def raw_scores(emb: np.ndarray, bank: dict[str, np.ndarray], logit_scale: float) -> dict[str, np.ndarray]:
    """Two-way softmax per feature. emb: [N, D] unit vectors."""
    emb = np.asarray(emb, dtype=np.float32)
    out = {}
    for fid, proto in bank.items():
        logits = logit_scale * emb @ proto.T  # [N, 2]
        logits -= logits.max(axis=1, keepdims=True)
        e = np.exp(logits)
        out[fid] = (e[:, 0] / e.sum(axis=1)).astype(np.float32)
    return out


class Calibrators:
    """Isotonic calibrators per (model, feature) with provenance."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._cache: dict[tuple[str, str], object] = {}

    def path(self, model: str, fid: str) -> Path:
        return self.root / "calibrators" / f"{model}__{fid}.joblib"

    def fit(self, model: str, fid: str, raw: np.ndarray, y: np.ndarray, source: str) -> dict:
        from sklearn.isotonic import IsotonicRegression

        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(raw, y.astype(float))
        p = self.path(model, fid)
        p.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(iso, p)
        meta = {"model": model, "feature": fid, "source": source, "n": int(len(y)), "n_pos": int(y.sum())}
        p.with_suffix(".json").write_text(json.dumps(meta))
        self._cache[(model, fid)] = iso
        return meta

    def available(self, model: str, fid: str) -> bool:
        return self.path(model, fid).exists()

    def meta(self, model: str, fid: str) -> dict | None:
        p = self.path(model, fid).with_suffix(".json")
        return json.loads(p.read_text()) if p.exists() else None

    def apply(self, model: str, fid: str, raw: np.ndarray) -> np.ndarray | None:
        key = (model, fid)
        if key not in self._cache:
            if not self.available(model, fid):
                return None
            self._cache[key] = joblib.load(self.path(model, fid))
        return self._cache[key].predict(raw).astype(np.float32)
