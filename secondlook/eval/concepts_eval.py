"""Are the word explanations of the tumour score faithful? (pipeline/concepts.py)

On every labelled tissue tile of the CAMELYON16 test slides (expert-mask truth: tumour if overlap
>= 0.5, benign if 0; mixed tiles excluded):

  fidelity      AUROC of the words-only score vs the full probe, and R^2 of the words-only logit
                against the probe logit
  deletion      erase the k most important concept directions from the embeddings, re-score the
                probe; the AUROC drop should exceed erasing k random directions (CoCoX left
                faithfulness as future work; this is the test it did not run)
  sanity        CoCoX's check, inverted: refit without "metastatic carcinoma" and report which
                morphology concepts carry the score and how well

Bootstrap by slide.

    python -m secondlook.eval.concepts_eval      # writes bundle/eval/concepts.json
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from secondlook.config import PRIMARY_MODEL, bundle_paths
from secondlook.eval.stats import auroc, ci, group_bootstrap, write_eval
from secondlook.pipeline import concepts as cx
from secondlook.store.arrays import AlignmentError, read_matrix

REPS = 200
N_RANDOM = 20


def labelled_tiles(paths, model=PRIMARY_MODEL):
    X, y, g = [], [], []
    for d in sorted((paths.root / "slides").iterdir()):
        lp = paths.eval_dir / "labels" / f"{d.name}.parquet"
        if not lp.exists() or not (d / "tiles.parquet").exists():
            continue
        t = pd.read_parquet(d / "tiles.parquet")
        try:
            e = np.asarray(read_matrix(paths.embedding(d.name, model), t["tile_id"]), np.float32)
        except (AlignmentError, FileNotFoundError):
            continue
        ov = pd.read_parquet(lp).set_index("tile_id").reindex(t.tile_id)["tumor_overlap"].to_numpy()
        m = ~t["art_blank"].to_numpy(bool) & np.isfinite(ov) & ((ov >= 0.5) | (ov == 0))
        X.append(e[m]); y.append((ov[m] >= 0.5).astype(int)); g += [d.name] * int(m.sum())
    return np.concatenate(X), np.concatenate(y), np.asarray(g)


def _erase(X, dirs):
    Q, _ = np.linalg.qr(np.asarray(dirs, np.float32).T)
    return X - (X @ Q) @ Q.T


def run() -> dict:
    paths = bundle_paths()
    out = paths.eval_dir / "concepts.json"
    e = cx.load(paths)
    if e is None:
        return write_eval(out, {"available": False, "reason": "run python -m secondlook.pipeline.concepts first"})
    X, y, g = labelled_tiles(paths)
    if len(np.unique(y)) < 2:
        return write_eval(out, {"available": False, "reason": "needs labelled tumour and benign tiles"})
    boot = lambda f: ci(group_bootstrap(f, g, len(y), reps=REPS))  # noqa: E731
    full = X @ e.v + e.b
    words = e.words_logit(X)
    fidelity = {"full_probe_auroc": auroc(y, full), "full_probe_ci": boot(lambda i: auroc(y[i], full[i])),
                "words_only_auroc": auroc(y, words), "words_only_ci": boot(lambda i: auroc(y[i], words[i])),
                "r2_words_vs_probe_logit": round(1 - float(((full - words) ** 2).sum() / ((full - full.mean()) ** 2).sum()), 4)}

    order = [int(k) for k in np.argsort(-np.abs(e.weight)) if e.weight[k] != 0]
    rng = np.random.default_rng(0)
    deletion = []
    for k in (1, 2, 3, len(order)):
        top = _erase(X, e.C[order[:k]]) @ e.v + e.b
        rand = [_erase(X, rng.normal(size=(k, X.shape[1]))) @ e.v + e.b for _ in range(N_RANDOM)]
        rand_auc = [auroc(y, r) for r in rand]
        r0 = rand[int(np.argsort(rand_auc)[len(rand_auc) // 2])]  # the median random erasure, for a paired CI
        deletion.append({"k": k, "erased": [e.labels[j] for j in order[:k]], "auroc_after": auroc(y, top),
                         "auroc_after_random_mean": float(np.mean(rand_auc)),
                         "drop_vs_random_ci": boot(lambda i: auroc(y[i], r0[i]) - auroc(y[i], top[i]))})

    with_label = cx.fit_default(paths, drop=())
    wl = with_label.words_logit(X)
    sanity = {"with": "Metastatic carcinoma", "words_only_auroc": auroc(y, wl),
              "words_only_ci": boot(lambda i: auroc(y[i], wl[i])),
              "weights": {l: round(float(w), 3) for l, w in sorted(zip(with_label.labels, with_label.weight), key=lambda x: -abs(x[1])) if abs(w) >= 0.1},
              "r2_vs_probe_logit": with_label.meta["r2_vs_probe_logit"]}

    tum = np.flatnonzero(y == 1)
    contrib = e.weight * (e.z(X[tum]) - e.baseline)
    top_for = pd.Series([e.labels[j] for j in contrib.argmax(1)]).value_counts(normalize=True).round(3).to_dict()

    d0 = deletion[-1]  # all words together; the detector has backups, so small subsets matter little
    head = [{"label": f"Tumour found by the {len(e.ids)} morphology words alone (AUROC, held-out test tiles)", "value": f"{fidelity['words_only_auroc']:.3f}",
             "ci": f"{fidelity['words_only_ci'][0]:.3f}-{fidelity['words_only_ci'][1]:.3f}",
             "note": f"full detector {fidelity['full_probe_auroc']:.3f}; words reproduce R^2 {fidelity['r2_words_vs_probe_logit']:.2f} of its score"},
            {"label": f"Erasing all {d0['k']} words from the tiles lowers the detector's AUROC to", "value": f"{d0['auroc_after']:.3f}",
             "ci": f"drop vs random {d0['drop_vs_random_ci'][0]:+.3f} to {d0['drop_vs_random_ci'][1]:+.3f}",
             "note": f"erasing {d0['k']} random directions: {d0['auroc_after_random_mean']:.3f}"},
            {"label": "With the circular word 'metastatic carcinoma' added back", "value": f"{sanity['words_only_auroc']:.3f}",
             "note": "the shown explanation leaves it out; carried by " + ", ".join(sanity["weights"])}]
    doc = {"title": "Concept explanations (CoCoX-style) are faithful to the tumour probe", "measure": "interpretability",
           "dataset": f"CAMELYON16 test tiles ({len(y)} tiles, {int(y.sum())} tumour, {len(np.unique(g))} slides)",
           "headline": head, "available": True, "model": e.model, "explainer": e.meta,
           "weights": {l: round(float(w), 3) for l, w in zip(e.labels, e.weight)},
           "fidelity": fidelity, "deletion": deletion, "with_label_concept": sanity,
           "top_reason_on_tumour_tiles": top_for, "bootstrap": f"by slide, {REPS} reps",
           "caveats": ["11 concepts from the feature text bank; a larger vocabulary needs the CONCH text encoder.",
                       "Explains what the probe relies on, not biology; fitted to the probe, not to labels."]}
    return write_eval(out, doc)


if __name__ == "__main__":
    d = run()
    for h in d.get("headline", []):
        print(h)
    print("top reason on tumour tiles:", d.get("top_reason_on_tumour_tiles"))
    print("deletion:", [(x["k"], x["erased"], round(x["auroc_after"], 4), round(x["auroc_after_random_mean"], 4), x["drop_vs_random_ci"]) for x in d.get("deletion", [])])
