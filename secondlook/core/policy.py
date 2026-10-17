"""Review policies.

1) Live routing rule (`recommend`): one human read is enough only if the reader
   and the AI agree, the models agree with each other, and the sign-out light is
   green. Otherwise a second human read is suggested; a third human resolves a
   human tie. The AI never breaks a tie.

2) Offline policy enumeration on CrowdGleason (`enumerate_policies`): exact
   expectation over reader orderings (all 7*6*5 = 210 ordered triples), so no
   Monte-Carlo noise. Each policy yields, per patch, a distribution over the 4
   decided classes and the expected number of human reads.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations, permutations

import numpy as np

K = 4  # non-cancer, G3, G4, G5


# ----------------------------------------------------------------------------------------
# live rule
# ----------------------------------------------------------------------------------------

@dataclass
class Recommendation:
    one_read_enough: bool
    suggestion: str            # "one_read" | "second_read" | "third_read" | "complete"
    reasons: list[str] = field(default_factory=list)
    checks: dict = field(default_factory=dict)


def recommend(reader_positive: bool | None, ai_positive: bool | None, models_agree: bool | None,
              light: str | None, human_reads: list[bool] | None = None) -> Recommendation:
    """reader_positive: the first reader's call (True = tumour/suspicious).
    ai_positive: AI case-level flag (routing only, not a diagnosis); None if unavailable.
    models_agree: False on the slow path. light: sign-out light or None if not run.
    human_reads: calls of additional human readers so far, in order."""
    checks = {
        "reader_ai_agree": None if (reader_positive is None or ai_positive is None) else reader_positive == ai_positive,
        "models_agree": models_agree,
        "light_green": None if light in (None, "unavailable") else light == "green",
    }
    reasons = []
    if checks["reader_ai_agree"] is None:
        reasons.append("AI case flag unavailable, so agreement cannot be checked")
    elif not checks["reader_ai_agree"]:
        reasons.append("reader and AI disagree")
    if checks["models_agree"] is None:
        reasons.append("model agreement unavailable (fewer than two models)")
    elif not checks["models_agree"]:
        reasons.append("the AI models disagree on this case (slow path)")
    if reader_positive is False:
        if checks["light_green"] is None:
            reasons.append("coverage check not available")
        elif not checks["light_green"]:
            reasons.append(f"suspicious tissue left unviewed (light {light})")
    one_ok = all(v is True for k, v in checks.items() if not (k == "light_green" and reader_positive))
    human_reads = human_reads or []
    if one_ok:
        return Recommendation(True, "one_read", ["all gates passed"], checks)
    if not human_reads:
        return Recommendation(False, "second_read", reasons, checks)
    if len(human_reads) == 1 and human_reads[0] != reader_positive:
        return Recommendation(False, "third_read", reasons + ["first and second human readers disagree"], checks)
    return Recommendation(False, "complete", reasons + ["human readers resolved the case"], checks)


# ----------------------------------------------------------------------------------------
# enumeration
# ----------------------------------------------------------------------------------------

def _median_label(labels) -> int:
    s = sorted(labels)
    return int(s[len(s) // 2])


def majority_label(labels) -> int:
    """Plurality; ties broken by the ordinal median of all labels (always a human label)."""
    vals, counts = np.unique(labels, return_counts=True)
    top = vals[counts == counts.max()]
    if len(top) == 1:
        return int(top[0])
    return _median_label(labels)


def _three_reader_decision(l1, l2, l3) -> int:
    return l1 if l1 == l2 else majority_label([l1, l2, l3])


@dataclass
class PolicyResult:
    name: str
    params: dict
    dist: np.ndarray       # [n, K] probability of each decided class per patch
    reads: np.ndarray      # [n] expected human reads per patch


def enumerate_policies(L: np.ndarray, ai: np.ndarray | None = None, ai_gate: np.ndarray | None = None,
                       ks=(3, 5, 7)) -> dict[str, PolicyResult]:
    """L: [n, R] resident labels (complete rows). ai: [n] AI class or None.
    ai_gate: [n] bool, True when the optional confidence / disagreement gates pass."""
    n, R = L.shape
    triples = list(permutations(range(R), 3))
    out: dict[str, PolicyResult] = {}

    d = np.zeros((n, K))
    for r in range(R):
        d[np.arange(n), L[:, r]] += 1.0 / R
    out["single"] = PolicyResult("single", {"readers": 1}, d, np.ones(n))

    d = np.zeros((n, K))
    reads = np.zeros(n)
    for a, b, c in triples:
        dec = np.where(L[:, a] == L[:, b], L[:, a],
                       [majority_label([x, y, z]) for x, y, z in zip(L[:, a], L[:, b], L[:, c])])
        d[np.arange(n), dec] += 1.0 / len(triples)
        reads += (2 + (L[:, a] != L[:, b])) / len(triples)
    out["double_arbitrated"] = PolicyResult("double_arbitrated", {"readers": "2 (+1 on disagreement)"}, d, reads)

    for k in ks:
        if k > R:
            continue
        subsets = list(combinations(range(R), k))
        d = np.zeros((n, K))
        for s in subsets:
            dec = np.array([majority_label(row) for row in L[:, s]])
            d[np.arange(n), dec] += 1.0 / len(subsets)
        out[f"majority_{k}"] = PolicyResult(f"majority_{k}", {"readers": k}, d, np.full(n, float(k)))

    if ai is not None:
        gate = np.ones(n, bool) if ai_gate is None else ai_gate
        d = np.zeros((n, K))
        reads = np.zeros(n)
        for a, b, c in triples:
            stop = (L[:, a] == ai) & gate
            two = L[:, a] == L[:, b]
            dec3 = np.array([_three_reader_decision(x, y, z) for x, y, z in zip(L[:, a], L[:, b], L[:, c])])
            dec = np.where(stop, L[:, a], dec3)
            d[np.arange(n), dec] += 1.0 / len(triples)
            reads += np.where(stop, 1, np.where(two, 2, 3)) / len(triples)
        out["ai_supported"] = PolicyResult("ai_supported", {"gate": ai_gate is not None}, d, reads)
        # random-skip control with the same skip rate
        p = float(np.mean([((L[:, a] == ai) & gate).mean() for a in range(R)]))  # share of single-read stops
        ds, dd = out["single"], out["double_arbitrated"]
        out["random_skip"] = PolicyResult("random_skip", {"skip_rate": round(p, 4)},
                                          p * ds.dist + (1 - p) * dd.dist, p * ds.reads + (1 - p) * dd.reads)
    return out


# ----------------------------------------------------------------------------------------
# metrics
# ----------------------------------------------------------------------------------------

def expected_confusion(dist: np.ndarray, truth: np.ndarray) -> np.ndarray:
    cm = np.zeros((K, K))
    np.add.at(cm, truth, dist)
    return cm


def qwk(cm: np.ndarray) -> float:
    k = cm.shape[0]
    w = np.array([[(i - j) ** 2 for j in range(k)] for i in range(k)]) / (k - 1) ** 2
    n = cm.sum()
    if n == 0:
        return float("nan")
    exp = np.outer(cm.sum(1), cm.sum(0)) / n
    den = (w * exp).sum()
    return float(1 - (w * cm).sum() / den) if den > 0 else float("nan")


def metrics(dist: np.ndarray, reads: np.ndarray, truth: np.ndarray) -> dict:
    cm = expected_confusion(dist, truth)
    n = len(truth)
    cancer_pred = dist[:, 1:].sum(1)
    hg_pred = dist[:, 2:].sum(1)
    return {
        "n": int(n),
        "agreement": float(np.trace(cm) / n),
        "kappa": qwk(cm),
        "cancer_acc": float(np.mean(np.where(truth > 0, cancer_pred, 1 - cancer_pred))),
        "highgrade_acc": float(np.mean(np.where(truth >= 2, hg_pred, 1 - hg_pred))),
        "reads_per_100": float(100 * reads.mean()),
    }


def bootstrap(results: dict[str, PolicyResult], truth: np.ndarray, groups: np.ndarray, reps: int, seed: int,
              reference: str = "double_arbitrated", margin: float = 0.02) -> dict[str, dict]:
    """Slide-level bootstrap CIs; non-inferiority of agreement vs `reference`."""
    rng = np.random.default_rng(seed)
    ug, inv = np.unique(groups, return_inverse=True)
    members = [np.nonzero(inv == g)[0] for g in range(len(ug))]
    draws = {k: {"agreement": [], "kappa": [], "reads_per_100": [], "diff": []} for k in results}
    for _ in range(reps):
        pick = rng.integers(0, len(ug), len(ug))
        idx = np.concatenate([members[g] for g in pick])
        ref_acc = None
        if reference in results:
            r = results[reference]
            ref_acc = np.trace(expected_confusion(r.dist[idx], truth[idx])) / len(idx)
        for k, r in results.items():
            cm = expected_confusion(r.dist[idx], truth[idx])
            acc = np.trace(cm) / len(idx)
            draws[k]["agreement"].append(acc)
            draws[k]["kappa"].append(qwk(cm))
            draws[k]["reads_per_100"].append(100 * r.reads[idx].mean())
            if ref_acc is not None:
                draws[k]["diff"].append(acc - ref_acc)
    out = {}
    for k, dd in draws.items():
        ci = lambda v: (float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5)))
        o = {"agreement_ci": ci(dd["agreement"]), "kappa_ci": ci(dd["kappa"]), "reads_ci": ci(dd["reads_per_100"])}
        if dd["diff"]:
            lo, hi = ci(dd["diff"])
            o["diff_vs_reference_ci"] = (lo, hi)
            o["noninferior"] = bool(lo > -margin)
        out[k] = o
    return out
