"""Measure #3: artifact flags (ink, blur, blank, fold).

1) Synthetic sanity check: clean tiles from training slides with injected pen strokes
   and Gaussian blur -> recall per flag, false-positive rate on the untouched tiles.
2) Real tiles: needs teammate labels in raw/artifact_labels.csv
   (tile_id, label in {clean, ink, blur, fold, blank}). `--sheet` exports a labelling
   sheet (flagged + random tiles as JPEGs + a CSV template) for that.
"""
from __future__ import annotations

import argparse

import numpy as np
import pandas as pd

from secondlook.config import RAW_DIR, bundle_paths
from secondlook.eval.stats import write_eval
from secondlook.pipeline.artifacts import FLAGS, inject_blur, inject_pen, rule_flags, tile_stats
from secondlook.pipeline.run_camelyon import WORK as C16_WORK, load_info
from secondlook.store.arrays import read_parquet

LABELS = RAW_DIR / "artifact_labels.csv"


def _reader(name):
    from secondlook.pipeline.tiler import TileReader, describe

    return TileReader(describe(name, load_info(name)["path"]))


def _sample_tiles(n_per_slide: int, rng, flagged_only=False, clean_only=False):
    out = []
    for d in sorted(C16_WORK.iterdir()):
        if not (d / "tiles.parquet").exists():
            continue
        t = read_parquet(d / "tiles.parquet")
        m = np.ones(len(t), bool)
        if clean_only:
            m &= ~t.artifact.to_numpy()
        if flagged_only:
            m &= t.artifact.to_numpy() & ~t.art_blank.to_numpy()
        idx = np.nonzero(m)[0]
        if len(idx):
            out.append((d.name, t.iloc[rng.choice(idx, min(n_per_slide, len(idx)), replace=False)]))
    return out


def synthetic(n_per_slide=40, seed=0) -> dict:
    rng = np.random.default_rng(seed)
    clean, pen, blur = [], [], []
    for name, rows in _sample_tiles(n_per_slide, rng, clean_only=True):
        r = _reader(name)
        for x, y in zip(rows.x, rows.y):
            img = r.read(x, y)
            clean.append(img)
            pen.append(inject_pen(img, rng))
            blur.append(inject_blur(img, rng))
    if not clean:
        return {"available": False, "reason": "no embedded slides"}
    f = {k: rule_flags(tile_stats(np.stack(v))) for k, v in (("clean", clean), ("pen", pen), ("blur", blur))}
    return {"available": True, "n_tiles": len(clean),
            "ink_recall_on_injected_pen": float(f["pen"]["ink"].mean()),
            "blur_recall_on_injected_blur": float(f["blur"]["blur"].mean()),
            "false_flag_rate_on_clean": {k: float(f["clean"][k].mean()) for k in FLAGS},
            "ink_precision_pen_vs_clean": float(f["pen"]["ink"].sum() / max(1, f["pen"]["ink"].sum() + f["clean"]["ink"].sum())),
            "blur_precision_blur_vs_clean": float(f["blur"]["blur"].sum() / max(1, f["blur"]["blur"].sum() + f["clean"]["blur"].sum()))}


def real() -> dict:
    if not LABELS.exists():
        return {"available": False, "reason": f"no manual labels yet ({LABELS.name}); run with --sheet and have teammates fill it"}
    lab = pd.read_csv(LABELS).dropna(subset=["label"])
    tiles = pd.concat([read_parquet(d / "tiles.parquet") for d in C16_WORK.iterdir() if (d / "tiles.parquet").exists()])
    df = lab.merge(tiles, on="tile_id", how="inner")
    out = {"available": True, "n_labelled": int(len(df)), "per_flag": {}}
    for k in FLAGS:
        y = df.label.str.lower().eq(k).to_numpy()
        p = df[f"art_{k}"].to_numpy()
        tp = int((y & p).sum())
        out["per_flag"][k] = {"n_true": int(y.sum()), "recall": tp / y.sum() if y.sum() else None,
                              "precision": tp / p.sum() if p.sum() else None}
    return out


def sheet(n_flagged=8, n_random=6, seed=1):
    import cv2

    rng = np.random.default_rng(seed)
    out = RAW_DIR / "artifact_sheet"
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    rows = []
    for flagged in (True, False):
        for name, sel in _sample_tiles(n_flagged if flagged else n_random, rng, flagged_only=flagged):
            r = _reader(name)
            for t in sel.itertuples():
                fn = f"{t.tile_id.replace(':', '_')}.jpg"
                cv2.imwrite(str(out / "tiles" / fn), cv2.cvtColor(r.read(t.x, t.y), cv2.COLOR_RGB2BGR))
                rows.append({"tile_id": t.tile_id, "image": f"tiles/{fn}", "label": ""})
    pd.DataFrame(rows).sample(frac=1, random_state=0).to_csv(out / "artifact_labels_TEMPLATE.csv", index=False)
    print(f"wrote {len(rows)} tiles to {out}; flags are hidden so labellers are blind to the rules")


def _pct(v) -> str:
    return "n/a" if v is None else f"{v:.0%}"


def run() -> dict:
    s, r = synthetic(), real()
    head = []
    if s.get("available"):
        head += [{"label": "Ink recall on injected pen strokes (sanity only)", "value": f"{s['ink_recall_on_injected_pen']:.0%}"},
                 {"label": "Blur recall on injected blur (sanity only)", "value": f"{s['blur_recall_on_injected_blur']:.0%}"},
                 {"label": "Clean tiles wrongly flagged (any rule)", "value":
                  f"{max(s['false_flag_rate_on_clean'].values()):.1%} max per flag"}]
    if r.get("available"):
        for k, v in r["per_flag"].items():
            if v["n_true"]:
                head.append({"label": f"Real tiles: {k} recall / precision",
                             "value": f"{_pct(v['recall'])} / {_pct(v['precision'])}"})
    doc = {"title": "Artifact gate", "measure": "#3 evidence", "dataset": "CAMELYON16 training-slide tiles",
           "headline": head,
           "caveats": ["Injected damage only checks the rules fire; the reportable number needs real labelled tiles."]
           + ([r["reason"]] if not r.get("available") else []),
           "synthetic": s, "real": r, "text_descriptors": "not yet compared (rules are the shipped default)"}
    return write_eval(bundle_paths().eval_dir / "artifacts.json", doc)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", action="store_true")
    a = ap.parse_args()
    if a.sheet:
        sheet()
    else:
        import json

        print(json.dumps(run()["headline"], indent=1))
