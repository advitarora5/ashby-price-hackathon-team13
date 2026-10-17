"""Measure #1: is each feature bar highest on tiles that carry the matching label?

Colon (NCT test tiles, per-feature one-vs-rest): AUROC plus calibration error for
  text_raw    two-way prompt softmax (what a zero-shot bar would show)
  text_cal    the same score through the isotonic calibrator (ranking unchanged by design;
              calibration fixes the 0-100% scale, so ECE/Brier is where it should differ)
  probe       tissue-probe class probability on the same embedding
  controls    tissue probe on ImageNet ViT and on colour histograms
Lymph node (CAMELYON16 test-slide tiles): the `metastasis` bar vs expert masks,
bootstrap by slide.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from secondlook.config import NCT_CLASSES, NCT_CLASS_NAMES, PRIMARY_MODEL, bundle_paths
from secondlook.eval.stats import auroc, brier, ci, ece, group_bootstrap, write_eval
from secondlook.pipeline.features import load_features
from secondlook.pipeline.run_nct import WORK as NCT_WORK
from secondlook.pipeline.run_nct import protocol

REPS = 300


def _boot_auc(y, s, groups=None):
    return ci(group_bootstrap(lambda i: auroc(y[i], s[i]), groups, len(y), reps=REPS))


def colon(models=("quiltnet", "plip", "colorhist", "imagenet")) -> dict:
    preds = {m: pd.read_parquet(NCT_WORK / f"test_preds_{m}.parquet") for m in models
             if (NCT_WORK / f"test_preds_{m}.parquet").exists()}
    if PRIMARY_MODEL not in preds:
        return {"available": False, "reason": "NCT test predictions missing (run secondlook.pipeline.run_nct)"}
    _, feats = load_features()
    P = preds[PRIMARY_MODEL]
    rows = []
    for f in feats:
        if not f.calibrate_on.startswith("nct:"):
            continue
        cls = f.calibrate_on[4:]
        y = (P.label.to_numpy() == NCT_CLASSES.index(cls)).astype(int)
        r = {"feature": f.id, "label": cls, "label_name": NCT_CLASS_NAMES[cls], "n_pos": int(y.sum()), "n": int(len(y))}
        if f"raw_{f.id}" in P:
            raw = P[f"raw_{f.id}"].to_numpy()
            r.update(text_raw_auroc=auroc(y, raw), text_raw_auroc_ci=_boot_auc(y, raw),
                     text_raw_ece=ece(y, raw), text_raw_brier=brier(y, raw))
        if f"cal_{f.id}" in P:
            c = P[f"cal_{f.id}"].to_numpy()
            r.update(text_cal_auroc=auroc(y, c), text_cal_ece=ece(y, c), text_cal_brier=brier(y, c))
        p = P[f"p_{cls}"].to_numpy()
        r.update(probe_auroc=auroc(y, p), probe_auroc_ci=_boot_auc(y, p), probe_ece=ece(y, p))
        for m, D in preds.items():
            if m == PRIMARY_MODEL:
                continue
            r[f"{m}_probe_auroc"] = auroc(y, D[f"p_{cls}"].to_numpy())
            if f"raw_{f.id}" in D:
                r[f"{m}_text_raw_auroc"] = auroc(y, D[f"raw_{f.id}"].to_numpy())
        rows.append(r)
    df = pd.DataFrame(rows)
    med = lambda c: float(df[c].median()) if c in df else None
    rep_p = NCT_WORK / "train_report.json"
    max_train = __import__("json").loads(rep_p.read_text()).get("max_train") if rep_p.exists() else None
    return {"available": True, "protocol": protocol(), "max_train_tiles": max_train, "n_tiles": int(len(P)), "per_feature": rows,
            "median_auroc": {k: med(k) for k in ("text_raw_auroc", "text_cal_auroc", "probe_auroc",
                                                 "imagenet_probe_auroc", "colorhist_probe_auroc", "plip_text_raw_auroc")},
            "mean_ece": {k: float(df[k].mean()) for k in ("text_raw_ece", "text_cal_ece", "probe_ece") if k in df},
            "tissue_probe_accuracy": {m: float((D[[f"p_{c}" for c in NCT_CLASSES]].to_numpy().argmax(1)
                                                == D.label.to_numpy()).mean()) for m, D in preds.items()}}


def lymph_node() -> dict:
    paths = bundle_paths()
    lab_dir = paths.eval_dir / "labels"
    ys, raw, prob, groups = [], [], [], []
    for p in sorted(lab_dir.glob("test_*.parquet")):
        sid = p.stem
        sp = paths.scores(sid)
        if not sp.exists():
            continue
        lab = pd.read_parquet(p)
        sc = pd.read_parquet(sp)
        tl = pd.read_parquet(paths.tiles(sid))
        if not (lab.tile_id.to_numpy() == sc.tile_id.to_numpy()).all():
            continue
        ov = lab.tumor_overlap.to_numpy()
        keep = ((ov >= 0.5) | (ov == 0)) & ~tl.art_blank.to_numpy()
        if "feat_metastasis_raw" not in sc or "tumor_prob" not in sc:
            continue
        ys.append((ov[keep] >= 0.5).astype(int))
        raw.append(sc.feat_metastasis_raw.to_numpy()[keep])
        prob.append(sc.tumor_prob.to_numpy()[keep])
        groups += [sid] * int(keep.sum())
    if not ys:
        return {"available": False, "reason": "no scored CAMELYON16 test slides with labels"}
    y, raw, prob, g = np.concatenate(ys), np.concatenate(raw), np.concatenate(prob), np.asarray(groups)
    return {"available": True, "n_tiles": int(len(y)), "n_pos": int(y.sum()), "n_slides": int(len(set(groups))),
            "metastasis_text_auroc": auroc(y, raw), "metastasis_text_auroc_ci": _boot_auc(y, raw, g),
            "tumor_probe_auroc": auroc(y, prob), "tumor_probe_auroc_ci": _boot_auc(y, prob, g),
            "bootstrap": "by slide"}


def run() -> dict:
    c, ln = colon(), lymph_node()
    head = []
    if c.get("available"):
        m = c["median_auroc"]
        head += [
            {"label": "Median per-feature AUROC, text prompt only (QuiltNet)", "value": f"{m['text_raw_auroc']:.3f}", "status": "info"},
            {"label": "Median per-feature AUROC, tissue probe (QuiltNet)", "value": f"{m['probe_auroc']:.3f}", "status": "info"},
            {"label": "Median AUROC, ImageNet ViT control probe", "value": f"{m['imagenet_probe_auroc']:.3f}" if m.get("imagenet_probe_auroc") else "n/a"},
            {"label": "Median AUROC, colour-histogram control probe", "value": f"{m['colorhist_probe_auroc']:.3f}" if m.get("colorhist_probe_auroc") else "n/a"},
        ]
        if c["mean_ece"].get("text_cal_ece") is not None:
            head.append({"label": "Mean calibration error (ECE): text raw -> calibrated",
                         "value": f"{c['mean_ece']['text_raw_ece']:.3f} -> {c['mean_ece']['text_cal_ece']:.3f}",
                         "note": "isotonic calibration keeps the ranking (same AUROC) and fixes the 0-100% scale"})
    if ln.get("available"):
        head.append({"label": f"Lymph node 'metastasis' bar AUROC (text), {ln['n_slides']} test slides",
                     "value": f"{ln['metastasis_text_auroc']:.3f}", "ci": f"{ln['metastasis_text_auroc_ci'][0]:.3f}-{ln['metastasis_text_auroc_ci'][1]:.3f}"})
        head.append({"label": "Tumour probe tile AUROC on the same tiles", "value": f"{ln['tumor_probe_auroc']:.3f}",
                     "ci": f"{ln['tumor_probe_auroc_ci'][0]:.3f}-{ln['tumor_probe_auroc_ci'][1]:.3f}"})
    caveats = ["NCT tiles have no patient ids: tile-level bootstrap, no claim beyond tile level.",
               "Features without a labelled counterpart (irregular nuclei, mitoses) are not evaluated and carry a badge."]
    if c.get("max_train_tiles"):
        caveats.append(f"Probes and calibrators fit on a random {c['max_train_tiles']:,}-tile subset of NCT-CRC-HE-100K (local run).")
    if c.get("protocol") == "cv_on_7k":
        caveats.append("NCT-CRC-HE-100K not processed yet: 5-fold CV on CRC-VAL-HE-7K only.")
    doc = {"title": "Feature bars match tissue labels", "measure": "#1 evidence",
           "dataset": "NCT-CRC-HE (colon) and CAMELYON16 test slides (lymph node)",
           "headline": head, "caveats": caveats, "colon": c, "lymph_node": ln}
    return write_eval(bundle_paths().eval_dir / "features.json", doc)


if __name__ == "__main__":
    import json

    print(json.dumps(run()["headline"], indent=1))
