"""NCT-CRC-HE: embed tiles, train the 9-class tissue probe, fit feature-bar calibrators.

    python -m secondlook.pipeline.run_nct embed --models quiltnet plip colorhist imagenet
    python -m secondlook.pipeline.run_nct train

Protocol: train on NCT-CRC-HE-100K, test on CRC-VAL-HE-7K (different patients).
If 100K is not on disk, the test set alone is used with 5-fold stratified CV and
every output is labelled `protocol: cv_on_7k` (no patient ids => tile-level only).
"""
from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.config import NCT_CLASSES, PRIMARY_MODEL, RAW_DIR, WORK_DIR, bundle_paths
from secondlook.store.arrays import read_matrix, read_parquet, write_matrix, write_parquet

NCT_RAW = RAW_DIR / "nct"
WORK = WORK_DIR / "nct"
SPLITS = {"train": "NCT-CRC-HE-100K", "test": "CRC-VAL-HE-7K"}


def index_split(split: str) -> pd.DataFrame | None:
    root = NCT_RAW / SPLITS[split]
    if not root.exists():
        return None
    rows = []
    for k, cls in enumerate(NCT_CLASSES):
        for p in sorted((root / cls).glob("*.tif")):
            rows.append({"image_id": f"{split}/{cls}/{p.stem}", "path": str(p), "label": k, "cls": cls})
    df = pd.DataFrame(rows)
    return df if len(df) else None


def _load(path: str) -> np.ndarray:
    from PIL import Image

    with Image.open(path) as im:
        a = np.asarray(im.convert("RGB"))
    if a.shape[:2] != (224, 224):
        import cv2

        a = cv2.resize(a, (224, 224), interpolation=cv2.INTER_AREA)
    return a


def stage_embed(models, batch=256, workers=8, force=False):
    from secondlook.pipeline.embed import available_models, get_encoder

    encs = {m: get_encoder(m) for m in available_models(models)}
    for split in SPLITS:
        idx = index_split(split)
        if idx is None:
            print(f"[nct] {SPLITS[split]} not on disk; skipping", flush=True)
            continue
        out = WORK / split
        out.mkdir(parents=True, exist_ok=True)
        todo = [m for m in encs if force or not (out / f"emb_{m}.npy").exists()]
        if not todo:
            continue
        write_parquet(idx, out / "index.parquet")
        n = len(idx)
        embs = {m: np.zeros((n, encs[m].dim), np.float16) for m in todo}
        t0 = time.time()
        with ThreadPoolExecutor(workers) as pool:
            for s in range(0, n, batch):
                imgs = np.stack(list(pool.map(_load, idx.path.iloc[s:s + batch])))
                for m in todo:
                    embs[m][s:s + len(imgs)] = encs[m].encode_images(imgs)
        for m in todo:
            write_matrix(embs[m], out / f"emb_{m}.npy", idx.image_id, model=m)
        print(f"[nct] {split}: {n} tiles, {todo}, {time.time() - t0:.0f}s", flush=True)


def load(split: str, model: str):
    d = WORK / split
    if not (d / "index.parquet").exists() or not (d / f"emb_{model}.npy").exists():
        return None, None
    idx = read_parquet(d / "index.parquet")
    return idx, np.asarray(read_matrix(d / f"emb_{model}.npy", idx.image_id), dtype=np.float32)


def protocol() -> str:
    return "train_100k_test_7k" if (WORK / "train" / f"emb_{PRIMARY_MODEL}.npy").exists() else "cv_on_7k"


def stage_train(models, max_train: int | None = None):
    """Tissue probes per model + feature calibrators for nct:<CLASS> features.
    Writes test-set predictions to WORK for evaluation (measures #1 and #2)."""
    from secondlook.pipeline.features import Calibrators, load_features, raw_scores
    from secondlook.pipeline.probes import fit_probe
    from secondlook.pipeline.run_camelyon import build_text_banks, load_text_bank

    paths = bundle_paths()
    proto = protocol()
    _, feats = load_features()
    if not all(load_text_bank(paths, m) for m in models if m in ("quiltnet", "plip", "pathgen")):
        build_text_banks(models, paths)
    cal = Calibrators(paths.models_dir)
    report = {"protocol": proto, "max_train": max_train, "models": {}}
    for m in models:
        te_idx, Xte = load("test", m)
        if te_idx is None:
            print(f"[nct] no test embeddings for {m}")
            continue
        yte = te_idx.label.to_numpy()
        if proto == "train_100k_test_7k":
            tr_idx, Xtr = load("train", m)
            ytr = tr_idx.label.to_numpy()
            if max_train and len(ytr) > max_train:
                sel = np.random.default_rng(0).choice(len(ytr), max_train, replace=False)
                tr_idx, Xtr, ytr = tr_idx.iloc[sel], Xtr[sel], ytr[sel]
            probe, oof = fit_probe(Xtr, ytr, np.zeros(len(ytr)), task="tissue", model=m, classes=list(NCT_CLASSES),
                                   n_splits=5, notes="NCT-CRC-HE-100K, tile-level folds (no patient ids)")
            pte = probe.predict_proba(Xte)
            probe.save(paths.models_dir)
        else:
            probe, oof = fit_probe(Xte, yte, np.zeros(len(yte)), task="tissue", model=m, classes=list(NCT_CLASSES),
                                   n_splits=5, notes="CV on CRC-VAL-HE-7K only (100K not available)")
            pte = oof  # out-of-fold predictions are the honest test predictions here
            probe.save(paths.models_dir)
        acc = float((pte.argmax(1) == yte).mean())
        report["models"][m] = {"test_accuracy": acc, "C": probe.meta.C}
        print(f"[nct] tissue probe {m}: test acc {acc:.3f} ({proto})", flush=True)
        out = pd.DataFrame(pte, columns=[f"p_{c}" for c in NCT_CLASSES])
        out.insert(0, "image_id", te_idx.image_id.to_numpy())
        out.insert(1, "label", yte)
        tb = load_text_bank(paths, m)
        if tb is not None:
            raw_te = raw_scores(Xte, tb["bank"], tb["logit_scale"])
            for fid, v in raw_te.items():
                out[f"raw_{fid}"] = v
            # calibrators: fit on train raw scores (or OOF-style split when only 7k exists)
            if proto == "train_100k_test_7k":
                raw_tr = raw_scores(Xtr, tb["bank"], tb["logit_scale"])
                for f in feats:
                    if f.calibrate_on.startswith("nct:"):
                        k = NCT_CLASSES.index(f.calibrate_on[4:])
                        cal.fit(m, f.id, raw_tr[f.id], (ytr == k).astype(int), source="nct_crc_he_100k")
                        out[f"cal_{f.id}"] = cal.apply(m, f.id, raw_te[f.id])
            else:
                from sklearn.isotonic import IsotonicRegression
                from sklearn.model_selection import StratifiedKFold

                folds = list(StratifiedKFold(5, shuffle=True, random_state=0).split(Xte, yte))
                for f in feats:
                    if not f.calibrate_on.startswith("nct:"):
                        continue
                    k = NCT_CLASSES.index(f.calibrate_on[4:])
                    yb = (yte == k).astype(int)
                    col = np.zeros(len(yte), np.float32)
                    for tr, te in folds:
                        iso = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit(raw_te[f.id][tr], yb[tr])
                        col[te] = iso.predict(raw_te[f.id][te])
                    out[f"cal_{f.id}"] = col
                    cal.fit(m, f.id, raw_te[f.id], yb, source="crc_val_he_7k (cv protocol; no held-out set)")
        write_parquet(out, WORK / f"test_preds_{m}.parquet")
    (WORK / "train_report.json").write_text(json.dumps(report, indent=1))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["embed", "train", "all"])
    ap.add_argument("--models", nargs="+", default=["quiltnet", "plip", "colorhist", "imagenet"])
    ap.add_argument("--max-train", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    if a.stage in ("embed", "all"):
        stage_embed(a.models, force=a.force)
    if a.stage in ("train", "all"):
        stage_train(a.models, a.max_train)


if __name__ == "__main__":
    main()
