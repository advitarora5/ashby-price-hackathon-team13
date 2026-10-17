"""Statistics shared by the evaluations: grouped bootstrap, AUROC, ECE, Holm."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import numpy as np

from secondlook.config import BOOTSTRAP_REPS, RNG_SEED


def auroc(y: np.ndarray, s: np.ndarray) -> float:
    from sklearn.metrics import roc_auc_score

    y = np.asarray(y)
    if len(np.unique(y)) < 2:
        return float("nan")
    return float(roc_auc_score(y, s))


def ece(y: np.ndarray, p: np.ndarray, bins: int = 10) -> float:
    y, p = np.asarray(y, float), np.clip(np.asarray(p, float), 0, 1)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    out = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            out += m.mean() * abs(y[m].mean() - p[m].mean())
    return float(out)


def brier(y, p) -> float:
    return float(np.mean((np.asarray(p, float) - np.asarray(y, float)) ** 2))


def group_bootstrap(stat: Callable[[np.ndarray], float], groups: np.ndarray | None, n: int,
                    reps: int = BOOTSTRAP_REPS, seed: int = RNG_SEED) -> np.ndarray:
    """Bootstrap a statistic over index sets; resample whole groups when given."""
    rng = np.random.default_rng(seed)
    if groups is None:
        return np.array([stat(rng.integers(0, n, n)) for _ in range(reps)])
    ug, inv = np.unique(np.asarray(groups), return_inverse=True)
    members = [np.nonzero(inv == g)[0] for g in range(len(ug))]
    vals = []
    for _ in range(reps):
        pick = rng.integers(0, len(ug), len(ug))
        vals.append(stat(np.concatenate([members[g] for g in pick])))
    return np.asarray(vals, float)


def ci(draws: np.ndarray) -> list[float]:
    d = draws[np.isfinite(draws)]
    if not len(d):
        return [float("nan"), float("nan")]
    return [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]


def paired_p(diff_draws: np.ndarray) -> float:
    """Two-sided bootstrap p-value for H0: difference == 0."""
    d = diff_draws[np.isfinite(diff_draws)]
    if not len(d):
        return float("nan")
    p = 2 * min((d <= 0).mean(), (d >= 0).mean())
    return float(min(1.0, max(p, 1.0 / len(d))))


def holm(pvals: dict[str, float]) -> dict[str, float]:
    keys = sorted(pvals, key=lambda k: pvals[k])
    m = len(keys)
    out, running = {}, 0.0
    for i, k in enumerate(keys):
        running = max(running, min(1.0, (m - i) * pvals[k]))
        out[k] = running
    return out


def fmt_ci(c) -> str:
    return f"95% CI {c[0]:.3f} to {c[1]:.3f}"


def write_eval(path: Path, doc: dict) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))
    return doc
