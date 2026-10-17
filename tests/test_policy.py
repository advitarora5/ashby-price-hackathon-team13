import numpy as np
import pytest

from secondlook.core.policy import enumerate_policies, majority_label, metrics, qwk, recommend


def test_majority_ties_use_human_median():
    assert majority_label([1, 1, 2]) == 1
    assert majority_label([0, 1, 3]) == 1  # three-way tie -> ordinal median, which is a human label
    assert majority_label([0, 0, 3, 3]) in (0, 3)


def test_recommend_requires_all_gates():
    r = recommend(False, False, True, "green")
    assert r.one_read_enough and r.suggestion == "one_read"
    assert recommend(False, True, True, "green").suggestion == "second_read"     # reader vs AI
    assert recommend(False, False, False, "green").suggestion == "second_read"   # models disagree
    assert recommend(False, False, True, "amber").suggestion == "second_read"    # risky unseen tissue
    assert recommend(False, None, True, "green").suggestion == "second_read"     # AI unavailable -> not one read


def test_ai_never_breaks_human_tie():
    r = recommend(True, False, True, None, human_reads=[False])
    assert r.suggestion == "third_read"
    assert recommend(True, False, True, None, human_reads=[True]).suggestion == "complete"


def test_enumeration_identities():
    rng = np.random.default_rng(1)
    truth = rng.integers(0, 4, 300)
    L = np.where(rng.random((300, 7)) < 0.7, truth[:, None], rng.integers(0, 4, (300, 7)))
    res = enumerate_policies(L)
    m = {k: metrics(v.dist, v.reads, truth) for k, v in res.items()}
    assert m["single"]["reads_per_100"] == 100
    assert 200 <= m["double_arbitrated"]["reads_per_100"] <= 300
    # double reading with arbitration decides exactly like majority of 3
    assert m["double_arbitrated"]["agreement"] == pytest.approx(m["majority_3"]["agreement"])
    assert m["majority_7"]["agreement"] >= m["single"]["agreement"]
    # perfect AI cuts reads but never decides alone
    res_ai = enumerate_policies(L, ai=truth)
    mai = metrics(res_ai["ai_supported"].dist, res_ai["ai_supported"].reads, truth)
    assert mai["reads_per_100"] < m["double_arbitrated"]["reads_per_100"]
    assert np.allclose(res_ai["ai_supported"].dist.sum(1), 1)


def test_qwk_perfect_and_chance():
    cm = np.diag([10, 10, 10, 10]).astype(float)
    assert qwk(cm) == pytest.approx(1.0)
    assert qwk(np.ones((4, 4))) == pytest.approx(0.0)
