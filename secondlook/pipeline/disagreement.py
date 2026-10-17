"""Stage 6: model disagreement (recipe `disagreement_v1`, frozen before evaluation).

For every pair of models (a, b) on the same tile:
  js   = Jensen-Shannon divergence (base 2, in [0, 1]) between class probabilities
  top  = 1 if the arg-max class differs
  rank = (1 - Spearman rho between the two models' raw feature-bar vectors) / 2
Pair values are averaged over pairs, each component is turned into a mid-rank
percentile against a fixed reference distribution (training tiles), and the
tile score is the mean of the three percentiles. Artifact tiles get NaN.
Case score = 90th percentile of tile scores over non-artifact tissue.

Baselines for evaluation live here too so they share inputs: single-model
entropy, margin, nearest-neighbour distance, random.
"""
from __future__ import annotations

from itertools import combinations
from pathlib import Path

import numpy as np

from secondlook.config import CASE_SCORE_PERCENTILE, DISAGREEMENT_RECIPE

COMPONENTS = ("js", "top", "rank")


def js_divergence(p: np.ndarray, q: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-9, 1)
    q = np.clip(q, 1e-9, 1)
    m = 0.5 * (p + q)
    kl = lambda a, b: (a * np.log2(a / b)).sum(axis=1)
    return np.clip(0.5 * kl(p, m) + 0.5 * kl(q, m), 0, 1)


def rank_distance(fa: np.ndarray, fb: np.ndarray) -> np.ndarray:
    """Row-wise (1 - Spearman) / 2 between two [N, F] feature matrices."""
    from scipy.stats import rankdata

    ra = rankdata(fa, axis=1)
    rb = rankdata(fb, axis=1)
    ra -= ra.mean(axis=1, keepdims=True)
    rb -= rb.mean(axis=1, keepdims=True)
    num = (ra * rb).sum(axis=1)
    den = np.sqrt((ra ** 2).sum(axis=1) * (rb ** 2).sum(axis=1))
    rho = np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)
    return (1 - rho) / 2


def components(probs: dict[str, np.ndarray], feats: dict[str, np.ndarray] | None = None) -> dict[str, np.ndarray]:
    models = sorted(probs)
    if len(models) < 2:
        raise ValueError("disagreement needs at least two models")
    pairs = list(combinations(models, 2))
    js = np.mean([js_divergence(probs[a], probs[b]) for a, b in pairs], axis=0)
    top = np.mean([(probs[a].argmax(1) != probs[b].argmax(1)).astype(float) for a, b in pairs], axis=0)
    out = {"js": js, "top": top}
    if feats and all(m in feats for m in models):
        out["rank"] = np.mean([rank_distance(feats[a], feats[b]) for a, b in pairs], axis=0)
    return out


def midrank_percentile(values: np.ndarray, ref_sorted: np.ndarray) -> np.ndarray:
    lo = np.searchsorted(ref_sorted, values, side="left")
    hi = np.searchsorted(ref_sorted, values, side="right")
    return (lo + 0.5 * (hi - lo)) / max(len(ref_sorted), 1)


class Reference:
    """Sorted reference values per component (from training tiles)."""

    def __init__(self, ref: dict[str, np.ndarray], source: str):
        self.ref = {k: np.sort(np.asarray(v, dtype=np.float64)) for k, v in ref.items()}
        self.source = source

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, source=np.array(self.source), **self.ref)

    @classmethod
    def load(cls, path: Path) -> "Reference":
        d = np.load(path, allow_pickle=False)
        return cls({k: d[k] for k in d.files if k != "source"}, str(d["source"]))


def tile_scores(comp: dict[str, np.ndarray], ref: Reference, exclude: np.ndarray | None = None) -> np.ndarray:
    pcts = [midrank_percentile(comp[k], ref.ref[k]) for k in COMPONENTS if k in comp and k in ref.ref]
    score = np.mean(pcts, axis=0)
    if exclude is not None:
        score = np.where(exclude, np.nan, score)
    return score.astype(np.float32)


def case_score(tile_score: np.ndarray, pct: float = CASE_SCORE_PERCENTILE) -> float | None:
    v = tile_score[np.isfinite(tile_score)]
    return float(np.percentile(v, pct)) if len(v) else None


def recipe_name(models) -> str:
    return f"{DISAGREEMENT_RECIPE}({','.join(sorted(models))})"


# ---- baselines -----------------------------------------------------------------------

def entropy(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-9, 1)
    return -(p * np.log(p)).sum(axis=1) / np.log(p.shape[1])


def margin_uncertainty(p: np.ndarray) -> np.ndarray:
    s = np.sort(p, axis=1)
    return 1 - (s[:, -1] - s[:, -2])


def knn_distance(query: np.ndarray, reference: np.ndarray, k: int = 10) -> np.ndarray:
    """1 - mean cosine similarity to the k nearest reference embeddings."""
    import faiss

    ref = np.ascontiguousarray(reference, dtype=np.float32)
    q = np.ascontiguousarray(query, dtype=np.float32)
    index = faiss.IndexFlatIP(ref.shape[1])
    index.add(ref)
    sims, _ = index.search(q, k)
    return 1 - sims.mean(axis=1)
