"""Does Clef's region referee add anything over simple statistics on the same evidence?

Regions (evidence and disputed) on CAMELYON16 slides with expert-mask labels. Truth per
region: tumour if >= half of its tissue tiles are tumour tiles (mask overlap >= 0.5),
benign if none are; mixed regions are excluded. Compared, by AUROC for "tumour":

  region risk           the region's existing peak tumour score (no training)
  stacker               logistic regression on the numeric evidence Clef is shown,
                        grouped cross-validation by slide
  clef                  P(real_tumour) from the referee (state + region crop + nearest examples)

Bootstrap by slide. Each region costs one Clef call; answers are cached in the DB.

    python -m secondlook.eval.referee_eval [--max-regions 200]   # writes bundle/eval/referee.json
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from secondlook import clef
from secondlook.config import bundle_paths
from secondlook.eval.stats import auroc, ci, group_bootstrap, write_eval
from secondlook.store import db


def _flatten(state: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in state.items():
        if isinstance(v, dict):
            out.update(_flatten(v, f"{prefix}{k}."))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[f"{prefix}{k}"] = float(v)
    return out


def regions_with_truth(store) -> pd.DataFrame:
    paths = store.paths
    con = store.con()
    try:
        regs = db.all_(con, "SELECT * FROM regions WHERE kind IN ('evidence','disputed') AND read_id IS NULL")
    finally:
        con.close()
    rows = []
    for r in regs:
        lp = paths.eval_dir / "labels" / f"{r['slide_id']}.parquet"
        if not lp.exists() or not paths.tiles(r["slide_id"]).exists():
            continue
        tiles = pd.read_parquet(paths.tiles(r["slide_id"]))
        ov = pd.read_parquet(lp).set_index("tile_id").reindex(tiles.tile_id)["tumor_overlap"].to_numpy()
        cx, cy = tiles.x + tiles.w0 / 2, tiles.y + tiles.w0 / 2
        inside = ((cx >= r["x"]) & (cx <= r["x"] + r["w"]) & (cy >= r["y"]) & (cy <= r["y"] + r["h"])
                  & ~tiles.art_blank).to_numpy() & np.isfinite(ov)
        if not inside.any():
            continue
        share = float((ov[inside] >= 0.5).mean())
        if 0 < share < 0.5:
            continue
        rows.append({**r, "truth": int(share >= 0.5)})
    return pd.DataFrame(rows)


def run(max_regions: int = 200) -> dict:
    from secondlook.api.services.clef import referee_inputs
    from secondlook.api.store import Store

    store = Store(bundle_paths())
    out = store.paths.eval_dir / "referee.json"
    regs = regions_with_truth(store)
    if regs.empty or regs.truth.nunique() < 2 or regs.slide_id.nunique() < 3:
        return write_eval(out, {"available": False, "reason": "needs labelled CAMELYON16 slides with both tumour and "
                                                              "benign regions on at least 3 slides"})
    regs = regs.sample(min(max_regions, len(regs)), random_state=0).reset_index(drop=True)
    client = clef.get_client()
    states, p_tumour, explanation = [], [], []
    for r in regs.to_dict("records"):
        sd = store.slide(r["slide_id"])
        state, images = referee_inputs(store, sd, r)
        ans = client.ask(state, clef.REFEREE_QUESTIONS, images)
        e = ans.get("explanation", {})
        p_tumour.append(float((e.get("probabilities") or {}).get("real_tumour", np.nan)))
        explanation.append(e.get("choice"))
        states.append(_flatten(state))
    X = pd.DataFrame(states).fillna(0.0)
    y, groups = regs.truth.to_numpy(), regs.slide_id.to_numpy()
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    stack = np.zeros(len(regs))
    for tr, te in GroupKFold(min(5, len(np.unique(groups)))).split(X, y, groups):
        if len(np.unique(y[tr])) < 2:
            stack[te] = y[tr].mean()
            continue
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=2000)).fit(X.iloc[tr], y[tr])
        stack[te] = m.predict_proba(X.iloc[te])[:, 1]
    scores = {"region risk": regs.risk.fillna(0).to_numpy(), "stacker": stack, "clef": np.nan_to_num(np.array(p_tumour))}
    res = {k: {"auroc": auroc(y, s), "ci": ci(group_bootstrap(lambda i, s=s: auroc(y[i], s[i]), groups, len(y)))}
           for k, s in scores.items()}
    diffs = {f"clef - {b}": ci(group_bootstrap(lambda i, b=b: auroc(y[i], scores["clef"][i]) - auroc(y[i], scores[b][i]),
                                               groups, len(y))) for b in ("region risk", "stacker")}
    table = pd.crosstab(pd.Series(explanation, name="clef"), pd.Series(np.where(y == 1, "tumour", "benign"), name="truth"))
    doc = {"available": True, "model": client.model, "n_regions": int(len(regs)), "n_tumour": int(y.sum()),
           "n_slides": int(len(np.unique(groups))), "results": res, "clef_minus_baseline_ci": diffs,
           "explanations_by_truth": table.to_dict(), "bootstrap": "by slide",
           "keep_rule": "show the referee only if clef beats the stacker (CI of the difference above 0)"}
    return write_eval(out, doc)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-regions", type=int, default=200)
    d = run(ap.parse_args().max_regions)
    print({k: v for k, v in d.items() if k != "explanations_by_truth"})
