"""Does spatial context / feature correlation give better tumour predictions?

Tile-level tumour detection on CAMELYON16, labels from expert masks (overlap >= 0.5
positive, no overlap negative, partial overlap and artifact tiles excluded).
Inputs per tile are the feature scores plus the tumour probe's probability, and
ring descriptors of the same values from secondlook/pipeline/context.py.

  tumour probe          existing per-tile probability (no training here)
  probe, 3x3 smoothed   what the app ranks with today (no training here)
  tile only             logistic regression on the tile's own values
  + surroundings        ... plus every value in each ring around the tile
  + correlations        ... plus own x ring products: "Y around a tile high in X"

Trained on the train slides and scored once on the test slides; with fewer than
MIN_TRAIN labelled train slides, grouped 5-fold cross-validation by slide instead.
Differences are bootstrapped by slide with Holm correction.

    python -m secondlook.eval.context_eval         # writes bundle/eval/context.json
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from secondlook.config import BundlePaths, RNG_SEED, bundle_paths
from secondlook.eval.stats import auroc, ci, group_bootstrap, holm, paired_p, write_eval
from secondlook.pipeline import context as ctx
from secondlook.store import db

MIN_TRAIN = 4
PER_CLASS_PER_SLIDE = 2000
SENSITIVITY = 0.90
REPS = 500


def average_precision(y, s) -> float:
    from sklearn.metrics import average_precision_score

    return float(average_precision_score(y, s)) if len(np.unique(y)) == 2 else float("nan")


def false_alarms(y, s, sensitivity: float = SENSITIVITY) -> float:
    """Share of non-tumour tiles flagged when the cut-off catches `sensitivity` of tumour tiles."""
    y, s = np.asarray(y), np.asarray(s)
    if y.sum() == 0 or (y == 0).sum() == 0:
        return float("nan")
    cut = np.quantile(s[y == 1], 1 - sensitivity)
    return float((s[y == 0] >= cut).mean())


def slide_table(paths: BundlePaths) -> pd.DataFrame:
    """One row per tissue tile with a clear label: slide, split, y, probe scores and model inputs."""
    from secondlook.pipeline.features import load_features

    fids = [f.id for f in load_features()[1]]
    labels = {f.id: f.label for f in load_features()[1]}
    con = db.connect(paths.db)
    try:
        slides = {r["slide_id"]: r for r in db.all_(con, "SELECT * FROM slides WHERE status='ok'")}
    finally:
        con.close()
    rows, names = [], None
    for p in sorted((paths.eval_dir / "labels").glob("*.parquet")):
        sid = p.stem
        if sid not in slides or not paths.scores(sid).exists():
            continue
        s = slides[sid]
        tiles, scores = pd.read_parquet(paths.tiles(sid)), pd.read_parquet(paths.scores(sid))
        if "tumor_prob" not in scores:
            continue
        lab = pd.read_parquet(p).set_index("tile_id").reindex(tiles.tile_id)["tumor_overlap"].to_numpy()
        ids, vals, _ = ctx.feature_values(scores, fids)
        vals = np.column_stack([vals, scores["tumor_prob"].to_numpy(dtype=np.float64)])
        ids = ids + ["tumor_prob"]
        if names is None:
            names = [labels.get(i, "tumour probe") for i in ids]
        elif len(ids) != len(names):
            continue
        valid = ctx.valid_tiles(tiles, vals)
        desc = ctx.ring_descriptors(tiles, vals, valid, (int(s["grid_rows"]), int(s["grid_cols"])))
        keep = valid & np.isfinite(lab) & ((lab >= 0.5) | (lab == 0))
        smooth = scores["tumor_prob_smooth"].to_numpy() if "tumor_prob_smooth" in scores else scores["tumor_prob"].to_numpy()
        rows.append(pd.DataFrame({"slide": sid, "split": s["split"], "y": (lab[keep] >= 0.5).astype(int),
                                  "probe": scores["tumor_prob"].to_numpy()[keep], "smooth": smooth[keep],
                                  "desc": list(desc[keep])}))
    if not rows:
        return pd.DataFrame(), []
    return pd.concat(rows, ignore_index=True), names


def inputs(desc: np.ndarray, which: str) -> np.ndarray:
    """[n, R, F] ring descriptors -> model inputs for one model."""
    own = desc[:, 0, :]
    if which == "tile only":
        return own
    rings = desc[:, 1:, :].reshape(len(desc), -1)
    if which == "+ surroundings":
        return np.column_stack([own, rings])
    inter = (own[:, :, None, None] * desc[:, None, 1:, :]).reshape(len(desc), -1)   # X here x Y in ring r
    return np.column_stack([own, rings, inter])


def input_names(names: list[str], which: str) -> list[str]:
    out = [f"{n} here" for n in names]
    if which == "tile only":
        return out
    rings = [f"{n} {ctx.RING_LABELS[r]}" for r in range(1, len(ctx.RINGS)) for n in names]
    if which == "+ surroundings":
        return out + rings
    return out + rings + [f"{y} {ctx.RING_LABELS[r]} x {x} here" for x in names for r in range(1, len(ctx.RINGS)) for y in names]


def _sample(df: pd.DataFrame, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    pick = []
    for _, g in df.groupby(["slide", "y"]):
        idx = g.index.to_numpy()
        pick.append(rng.choice(idx, min(len(idx), PER_CLASS_PER_SLIDE), replace=False))
    return np.sort(np.concatenate(pick))


def _fit(X, y):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    return make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=3000, class_weight="balanced")).fit(X, y)


MODELS = ("tile only", "+ surroundings", "+ correlations")


def predict(df: pd.DataFrame, seed: int = RNG_SEED) -> tuple[dict[str, np.ndarray], np.ndarray, str, dict]:
    """Out-of-sample predictions for every trained model, the evaluated rows, the protocol and fitted models."""
    desc = np.stack(df["desc"].to_numpy())
    train = df.index[df.split == "train"].to_numpy()
    test = df.index[df.split != "train"].to_numpy()
    preds, fitted = {}, {}
    if df.loc[train, "slide"].nunique() >= MIN_TRAIN and df.loc[test, "slide"].nunique() >= 2:
        protocol, rows = "train slides -> test slides", test
        tr = _sample(df.loc[train], seed)
        for m in MODELS:
            fitted[m] = _fit(inputs(desc[tr], m), df.y.to_numpy()[tr])
            preds[m] = fitted[m].predict_proba(inputs(desc[rows], m))[:, 1]
    else:
        from sklearn.model_selection import GroupKFold

        protocol, rows = "5-fold cross-validation by slide (too few labelled train slides)", df.index.to_numpy()
        k = min(5, df.slide.nunique())
        for m in MODELS:
            out = np.zeros(len(df))
            for tr_i, te_i in GroupKFold(k).split(desc, df.y, df.slide):
                tr = _sample(df.iloc[tr_i], seed)
                model = _fit(inputs(desc[tr], m), df.y.to_numpy()[tr])
                out[te_i] = model.predict_proba(inputs(desc[te_i], m))[:, 1]
            preds[m] = out
            fitted[m] = model
    return preds, rows, protocol, fitted


def run(paths: BundlePaths | None = None) -> dict:
    paths = paths or bundle_paths()
    df, names = slide_table(paths)
    out_path = paths.eval_dir / "context.json"
    if df.empty or df.y.nunique() < 2 or df.slide.nunique() < 3:
        return write_eval(out_path, {"available": False,
                                     "reason": "needs CAMELYON16 slides with expert-mask labels in bundle/eval/labels"})
    preds, rows, protocol, fitted = predict(df)
    y, groups = df.y.to_numpy()[rows], df.slide.to_numpy()[rows]
    scores = {"tumour probe": df.probe.to_numpy()[rows], "probe, 3x3 smoothed": df["smooth"].to_numpy()[rows], **preds}
    metrics = {"AUROC": auroc, "average precision": average_precision,
               f"false alarms at {int(SENSITIVITY * 100)}% sensitivity": false_alarms}
    results = {}
    for name, s in scores.items():
        results[name] = {}
        for mname, f in metrics.items():
            draws = group_bootstrap(lambda i, s=s, f=f: f(y[i], s[i]), groups, len(y), reps=REPS)
            results[name][mname] = {"value": f(y, s), "ci": ci(draws)}
    comparisons, pvals = {}, {}
    for a, b in (("+ surroundings", "tile only"), ("+ correlations", "tile only"),
                 ("+ correlations", "+ surroundings"), ("+ correlations", "probe, 3x3 smoothed")):
        for mname, f in metrics.items():
            d = group_bootstrap(lambda i, a=a, b=b, f=f: f(y[i], scores[a][i]) - f(y[i], scores[b][i]), groups, len(y), reps=REPS)
            key = f"{a} vs {b} | {mname}"
            comparisons[key] = {"difference": f(y, scores[a]) - f(y, scores[b]), "ci": ci(d)}
            pvals[key] = paired_p(d)
    for k, p in holm(pvals).items():
        comparisons[k]["p_holm"] = p
    m = fitted["+ correlations"][-1]
    coef = m.coef_[0]
    top = np.argsort(-np.abs(coef))[:12]
    nm = input_names(names, "+ correlations")
    doc = {"available": True, "protocol": protocol, "n_tiles": int(len(y)), "n_slides": int(len(np.unique(groups))),
           "n_tumour_tiles": int(y.sum()), "bootstrap": "by slide", "results": results, "comparisons": comparisons,
           "top_inputs_of_correlation_model": [{"input": nm[i], "weight": round(float(coef[i]), 3)} for i in top],
           "note": "weights are on standardised inputs; positive = pushes towards tumour"}
    return write_eval(out_path, doc)


def report(doc: dict) -> str:
    if not doc.get("available"):
        return doc.get("reason", "unavailable")
    lines = [f"{doc['protocol']} · {doc['n_slides']} slides · {doc['n_tiles']} tiles ({doc['n_tumour_tiles']} tumour)", ""]
    ms = list(next(iter(doc["results"].values())))
    lines.append(f"{'':22}" + "".join(f"{m[:26]:>28}" for m in ms))
    for name, r in doc["results"].items():
        lines.append(f"{name:22}" + "".join(f"{r[m]['value']:>12.3f} [{r[m]['ci'][0]:.3f}-{r[m]['ci'][1]:.3f}]" for m in ms))
    lines += ["", "differences (bootstrap by slide, Holm-corrected p):"]
    for k, c in doc["comparisons"].items():
        lines.append(f"  {k:70} {c['difference']:+.3f} [{c['ci'][0]:+.3f} to {c['ci'][1]:+.3f}]  p={c['p_holm']:.3f}")
    lines += ["", "what the correlation model leans on most:"]
    lines += [f"  {t['weight']:+.3f}  {t['input']}" for t in doc["top_inputs_of_correlation_model"]]
    return "\n".join(lines)


if __name__ == "__main__":
    print(report(run()))
    print(f"\nwritten to {bundle_paths().eval_dir / 'context.json'}")
