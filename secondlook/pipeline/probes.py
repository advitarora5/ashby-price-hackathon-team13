"""Stage 4: lightweight probes on frozen embeddings.

Every probe is a (multinomial) logistic regression on standardised embeddings,
with C chosen by slide-grouped cross-validation. Each saved probe carries its
classes, encoder, training-set digest, CV metrics and an optional temperature.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import joblib
import numpy as np


@dataclass
class ProbeMeta:
    task: str                      # tumor | tissue | prostate
    model: str                     # encoder name
    classes: list[str]
    n_train: int
    n_groups: int
    C: float
    temperature: float = 1.0
    calibration: str = "none"      # none | temperature
    cv: dict = field(default_factory=dict)
    train_digest: str = ""
    version: str = "probe_v1"
    notes: str = ""


class Probe:
    def __init__(self, scaler, clf, meta: ProbeMeta):
        self.scaler, self.clf, self.meta = scaler, clf, meta

    def logits(self, X: np.ndarray) -> np.ndarray:
        Z = self.clf.decision_function(self.scaler.transform(np.asarray(X, dtype=np.float32)))
        if Z.ndim == 1:  # binary -> two-column logits
            Z = np.stack([np.zeros_like(Z), Z], axis=1)
        return Z

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        Z = self.logits(X) / self.meta.temperature
        Z = Z - Z.max(axis=1, keepdims=True)
        e = np.exp(Z)
        return (e / e.sum(axis=1, keepdims=True)).astype(np.float32)

    def save(self, root: Path) -> Path:
        p = probe_path(root, self.meta.task, self.meta.model)
        p.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({"scaler": self.scaler, "clf": self.clf}, p)
        p.with_suffix(".json").write_text(json.dumps(asdict(self.meta), indent=1))
        return p

    @classmethod
    def load(cls, root: Path, task: str, model: str) -> "Probe":
        p = probe_path(root, task, model)
        if not p.exists():
            raise FileNotFoundError(f"no {task} probe for {model} at {p}")
        d = joblib.load(p)
        meta = ProbeMeta(**json.loads(p.with_suffix(".json").read_text()))
        return cls(d["scaler"], d["clf"], meta)


def probe_path(root: Path, task: str, model: str) -> Path:
    return Path(root) / "probes" / f"{task}__{model}.joblib"


def _grouped_splits(y, groups, n_splits):
    from sklearn.model_selection import GroupKFold, StratifiedKFold

    groups = np.asarray(groups)
    if len(np.unique(groups)) >= n_splits:
        return list(GroupKFold(n_splits=n_splits).split(np.zeros(len(y)), y, groups))
    # no patient/slide ids (NCT): stratified tile-level folds, recorded as such in meta
    return list(StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=0).split(np.zeros(len(y)), y))


def fit_probe(X: np.ndarray, y: np.ndarray, groups, *, task: str, model: str, classes: list[str],
              Cs=(0.01, 0.1, 1.0), n_splits: int = 5, max_iter: int = 2000, notes: str = "") -> tuple[Probe, np.ndarray]:
    """Pick C by grouped CV, return (probe fit on all data, out-of-fold probabilities)."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import log_loss
    from sklearn.preprocessing import StandardScaler

    from secondlook.ids import sequence_digest

    X = np.asarray(X, dtype=np.float32)
    y = np.asarray(y)
    splits = _grouped_splits(y, groups, n_splits)
    k = len(classes)
    best = None
    for C in Cs:
        oof = np.zeros((len(y), k), np.float32)
        for tr, te in splits:
            sc = StandardScaler().fit(X[tr])
            clf = LogisticRegression(C=C, max_iter=max_iter).fit(sc.transform(X[tr]), y[tr])
            p = clf.predict_proba(sc.transform(X[te]))
            oof[np.ix_(te, clf.classes_.astype(int))] = p
        loss = log_loss(y, np.clip(oof, 1e-7, 1), labels=list(range(k)))
        if best is None or loss < best[0]:
            best = (loss, C, oof)
    loss, C, oof = best
    sc = StandardScaler().fit(X)
    clf = LogisticRegression(C=C, max_iter=max_iter).fit(sc.transform(X), y)
    acc = float((oof.argmax(1) == y).mean())
    meta = ProbeMeta(task=task, model=model, classes=list(classes), n_train=int(len(y)),
                     n_groups=int(len(np.unique(groups))), C=float(C),
                     cv={"log_loss": float(loss), "accuracy": acc, "n_splits": n_splits,
                         "grouped": len(np.unique(groups)) >= n_splits},
                     train_digest=sequence_digest(np.asarray(groups)[:: max(1, len(y) // 5000)]), notes=notes)
    return Probe(sc, clf, meta), oof


def fit_temperature(probe: Probe, X_val: np.ndarray, y_val: np.ndarray) -> float:
    """Single temperature minimising validation NLL (golden-section on log T)."""
    from scipy.optimize import minimize_scalar

    Z = probe.logits(X_val)
    y_val = np.asarray(y_val)

    def nll(logT):
        z = Z / np.exp(logT)
        z = z - z.max(axis=1, keepdims=True)
        lp = z - np.log(np.exp(z).sum(axis=1, keepdims=True))
        return -lp[np.arange(len(y_val)), y_val].mean()

    r = minimize_scalar(nll, bounds=(-3, 3), method="bounded")
    T = float(np.exp(r.x))
    probe.meta.temperature = T
    probe.meta.calibration = "temperature"
    return T
