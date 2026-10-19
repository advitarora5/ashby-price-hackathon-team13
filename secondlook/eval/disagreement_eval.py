"""Measure #2: do the top 15% most-disputed tiles hold a large share of model mistakes?

Compared against single-model entropy, margin, nearest-neighbour distance and
random routing, on (a) NCT colon test tiles (tissue probe errors) and
(b) CAMELYON16 test-slide tiles (tumour probe errors, labels from expert masks).
Paired bootstrap differences with Holm correction across the baselines. We also
report the error rate left inside the fast tier, because agreed != right.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from secondlook.config import NCT_CLASSES, PRIMARY_MODEL, SECONDARY_MODEL, SLOW_PATH_SHARE, bundle_paths
from secondlook.eval.stats import ci, group_bootstrap, holm, paired_p, write_eval
from secondlook.pipeline.disagreement import (Reference, components, entropy, knn_distance, margin_uncertainty,
                                              midrank_percentile)

REPS = 500


def capture(err: np.ndarray, score: np.ndarray, share: float = SLOW_PATH_SHARE) -> tuple[float, float]:
    """(share of all errors inside the top `share` by score, error rate in the remaining fast tier)."""
    n = len(err)
    k = max(1, int(round(share * n)))
    order = np.argsort(-score, kind="stable")
    top = np.zeros(n, bool)
    top[order[:k]] = True
    tot = err.sum()
    return (float(err[top].sum() / tot) if tot else float("nan"), float(err[~top].mean()) if (~top).any() else float("nan"))


def compare(err: np.ndarray, scores: dict[str, np.ndarray], groups=None, seed_scores_random=True) -> dict:
    rng = np.random.default_rng(0)
    scores = dict(scores)
    if seed_scores_random:
        scores["random"] = rng.random(len(err))
    out = {}
    draws = {}
    for name, s in scores.items():
        cap, fast_err = capture(err, s)
        d = group_bootstrap(lambda i: capture(err[i], s[i])[0], groups, len(err), reps=REPS)
        draws[name] = d
        out[name] = {"capture_top15": cap, "capture_ci": ci(d), "fast_tier_error_rate": fast_err}
    if "disagreement" in scores:
        pv = {}
        for name in scores:
            if name == "disagreement":
                continue
            diff = draws["disagreement"] - draws[name]
            out[name]["disagreement_minus_this_ci"] = ci(diff)
            pv[name] = paired_p(diff)
        for name, p in holm(pv).items():
            out[name]["p_holm"] = p
    return out


def nct() -> dict:
    from secondlook.pipeline.run_nct import WORK, load, protocol

    a, b = PRIMARY_MODEL, SECONDARY_MODEL
    pa, pb = WORK / f"test_preds_{a}.parquet", WORK / f"test_preds_{b}.parquet"
    if not (pa.exists() and pb.exists()):
        return {"available": False, "reason": f"need NCT test predictions for {a} and {b}"}
    A, B = pd.read_parquet(pa), pd.read_parquet(pb)
    pcols = [f"p_{c}" for c in NCT_CLASSES]
    feat_cols = sorted(c for c in A if c.startswith("raw_") and c in B)
    probs = {a: A[pcols].to_numpy(), b: B[pcols].to_numpy()}
    feats = {a: A[feat_cols].to_numpy(), b: B[feat_cols].to_numpy()} if feat_cols else None
    comp = components(probs, feats)
    # within-set percentiles (recipe disagreement_v1: mean of component percentiles)
    dis = np.mean([midrank_percentile(v, np.sort(v)) for v in comp.values()], axis=0)
    y = A.label.to_numpy()
    err = (probs[a].argmax(1) != y).astype(int)
    scores = {"disagreement": dis, "entropy": entropy(probs[a]), "margin": margin_uncertainty(probs[a])}
    idx_te, X_te = load("test", PRIMARY_MODEL)
    idx_tr, X_tr = load("train", PRIMARY_MODEL)
    if X_tr is not None:
        sub = np.random.default_rng(0).choice(len(X_tr), min(30000, len(X_tr)), replace=False)
        scores["knn_distance"] = knn_distance(X_te, X_tr[sub])
    return {"available": True, "protocol": protocol(), "n_tiles": int(len(y)), "n_errors": int(err.sum()),
            "error_rate": float(err.mean()), "models": [a, b], "results": compare(err, scores),
            "bootstrap": "tile-level (no patient ids)"}


def camelyon() -> dict:
    from secondlook.pipeline.run_camelyon import WORK as C16_WORK
    from secondlook.store.arrays import read_matrix

    paths = bundle_paths()
    parts, embs = [], []
    for p in sorted((paths.eval_dir / "labels").glob("test_*.parquet")):
        sid = p.stem
        if not paths.scores(sid).exists():
            continue
        sc = pd.read_parquet(paths.scores(sid))
        lab = pd.read_parquet(p)
        tl = pd.read_parquet(paths.tiles(sid))
        if "disagreement" not in sc:
            continue
        ov = lab.tumor_overlap.to_numpy()
        keep = ((ov >= 0.5) | (ov == 0)) & np.isfinite(sc.disagreement.to_numpy())
        emb = np.asarray(read_matrix(paths.embedding(sid, PRIMARY_MODEL), tl.tile_id), dtype=np.float32)
        parts.append(pd.DataFrame({"slide": sid, "y": (ov[keep] >= 0.5).astype(int), "p": sc.tumor_prob.to_numpy()[keep],
                                   "dis": sc.disagreement.to_numpy()[keep]}))
        embs.append(emb[keep])
    if not parts:
        return {"available": False, "reason": "no scored test slides with disagreement and labels"}
    df = pd.concat(parts, ignore_index=True)
    emb = np.concatenate(embs)
    P = np.stack([1 - df.p.to_numpy(), df.p.to_numpy()], axis=1)
    err = ((df.p.to_numpy() >= 0.5).astype(int) != df.y.to_numpy()).astype(int)
    scores = {"disagreement": df.dis.to_numpy(), "entropy": entropy(P), "margin": margin_uncertainty(P)}
    train_embs = []
    for d in sorted(C16_WORK.glob("tumor_*")) + sorted(C16_WORK.glob("normal_*")):
        f = d / f"emb_{PRIMARY_MODEL}.npy"
        if f.exists():
            e = np.load(f, mmap_mode="r")
            sel = np.random.default_rng(0).choice(len(e), min(3000, len(e)), replace=False)
            train_embs.append(np.asarray(e[np.sort(sel)], dtype=np.float32))
    if train_embs:
        scores["knn_distance"] = knn_distance(emb, np.concatenate(train_embs))
    return {"available": True, "n_tiles": int(len(df)), "n_slides": int(df.slide.nunique()), "n_errors": int(err.sum()),
            "error_rate": float(err.mean()), "results": compare(err, scores, groups=df.slide.to_numpy()),
            "bootstrap": "by slide", "note": "tiles with partial mask overlap (0 < overlap < 0.5) excluded; artifacts excluded"}


def run() -> dict:
    a, b = nct(), camelyon()
    head, caveats = [], []
    for name, r in (("Colon (NCT)", a), ("Lymph node (CAMELYON16)", b)):
        if not r.get("available"):
            caveats.append(f"{name}: {r.get('reason')}")
            continue
        res = r["results"]
        best_base = max((k for k in res if k != "disagreement"), key=lambda k: res[k]["capture_top15"])
        d = res["disagreement"]
        beats = all(res[k].get("disagreement_minus_this_ci", [0])[0] > 0 for k in res if k != "disagreement")
        head.append({"label": f"{name}: share of model errors in the top 15% most-disputed tiles",
                     "value": f"{d['capture_top15']:.1%}", "ci": f"{d['capture_ci'][0]:.1%}-{d['capture_ci'][1]:.1%}",
                     "status": "pass" if beats else "fail",
                     "note": f"best baseline: {best_base} {res[best_base]['capture_top15']:.1%}; random {res['random']['capture_top15']:.1%}; "
                             f"error rate left in fast tier {d['fast_tier_error_rate']:.1%}"})
        if not beats:
            caveats.append(f"{name}: disagreement does not beat every baseline with a CI excluding zero; "
                           "per the plan the queue is kept only as a baseline comparison.")
    routing = None
    if b.get("available"):
        res = b["results"]
        ent = res.get("entropy", {})
        beats = ent.get("disagreement_minus_this_ci", [0])[0] > 0
        routing = {"signal": "disagreement" if beats else "entropy",
                   "source": f"disagreement_eval camelyon16: disagreement {res['disagreement']['capture_top15']:.3f} vs "
                             f"entropy {ent.get('capture_top15', float('nan')):.3f} ({b['n_slides']} slides)"}
        import json as _json

        tp = bundle_paths().thresholds
        th = _json.loads(tp.read_text()) if tp.exists() else {}
        th["routing_signal"] = routing
        tp.write_text(_json.dumps(th, indent=1))
        if not beats:
            caveats.append("Tiering therefore uses single-model entropy (the stronger baseline); disagreement is still shown.")
    doc = {"title": "Disagreement routing catches model mistakes", "measure": "#2 routing",
           "dataset": "NCT-CRC-HE test tiles; CAMELYON16 test-slide tiles", "headline": head,
           "caveats": caveats + ["Models: QuiltNet and PLIP only (PathGen-CLIP gated; CONCH/MUSK not approved)."],
           "nct": a, "camelyon16": b, "routing_signal": routing}
    return write_eval(bundle_paths().eval_dir / "disagreement.json", doc)


if __name__ == "__main__":
    import json

    print(json.dumps(run()["headline"], indent=1))
