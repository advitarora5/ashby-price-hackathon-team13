"""CrowdGleason prostate probe (Delta job: needs Patches.zip, 16 GB).

    python -m secondlook.pipeline.run_prostate embed --patches <dir with train/ val/ test/>
    python -m secondlook.pipeline.run_prostate train

Train on the train split with Dawid-Skene aggregated resident labels, fit a
temperature on val, predict the test split once. Exports
bundle/eval/crowdgleason_test_ai.parquet (patch_id, ai_class, ai_conf,
ai_entropy, ai_disagreement, p_*) for the policy evaluation, and the
disagreement-vs-resident-error check.
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.config import PATHOLOGY_MODELS, PRIMARY_MODEL, PROSTATE_CLASSES, RAW_DIR, WORK_DIR, bundle_paths
from secondlook.pipeline.datasets.crowdgleason import MARKERS, load_split
from secondlook.store.arrays import read_matrix, read_parquet, write_matrix, write_parquet

CG_RAW = RAW_DIR / "crowdgleason"
WORK = WORK_DIR / "crowdgleason"


def _find(patch_root: Path, split: str, patch_id: str) -> Path | None:
    for ext in (".jpg", ".png", ".tif", ".jpeg"):
        for sub in (split, split.capitalize(), ""):
            p = patch_root / sub / f"{patch_id}{ext}"
            if p.exists():
                return p
    return None


def _load(path: str) -> np.ndarray:
    import cv2
    from PIL import Image

    with Image.open(path) as im:
        a = np.asarray(im.convert("RGB"))
    return cv2.resize(a, (224, 224), interpolation=cv2.INTER_AREA)  # 512 px patch -> 224, whole field of view


def stage_embed(patch_root: Path, models, batch=128, workers=8):
    from secondlook.pipeline.embed import available_models, get_encoder

    encs = {m: get_encoder(m) for m in available_models(models)}
    for split in ("train", "val", "test"):
        df = load_split(CG_RAW, split)
        df["path"] = [str(_find(patch_root, split, p) or "") for p in df.patch_id]
        missing = int((df.path == "").sum())
        if missing:
            print(f"[prostate] {split}: {missing} patch images not found under {patch_root}; they are dropped", flush=True)
        df = df[df.path != ""].reset_index(drop=True)
        out = WORK / split
        out.mkdir(parents=True, exist_ok=True)
        write_parquet(df, out / "index.parquet")
        embs = {m: np.zeros((len(df), e.dim), np.float16) for m, e in encs.items()}
        with ThreadPoolExecutor(workers) as pool:
            for s in range(0, len(df), batch):
                imgs = np.stack(list(pool.map(_load, df.path.iloc[s:s + batch])))
                for m, e in encs.items():
                    embs[m][s:s + len(imgs)] = e.encode_images(imgs)
        for m in encs:
            write_matrix(embs[m], out / f"emb_{m}.npy", df.patch_id, model=m)
        print(f"[prostate] {split}: {len(df)} patches embedded", flush=True)


def stage_train(models, label_col="DS"):
    from secondlook.pipeline.disagreement import components, entropy, midrank_percentile
    from secondlook.pipeline.probes import fit_probe, fit_temperature

    paths = bundle_paths()
    probs, report = {}, {}
    te = read_parquet(WORK / "test" / "index.parquet")
    for m in models:
        tr = read_parquet(WORK / "train" / "index.parquet")
        va = read_parquet(WORK / "val" / "index.parquet")
        Xtr = np.asarray(read_matrix(WORK / "train" / f"emb_{m}.npy", tr.patch_id), np.float32)
        Xva = np.asarray(read_matrix(WORK / "val" / f"emb_{m}.npy", va.patch_id), np.float32)
        Xte = np.asarray(read_matrix(WORK / "test" / f"emb_{m}.npy", te.patch_id), np.float32)
        probe, _ = fit_probe(Xtr, tr[label_col].to_numpy(), tr.slide_id.to_numpy(), task="prostate", model=m,
                             classes=list(PROSTATE_CLASSES), notes=f"CrowdGleason train, {label_col} labels")
        T = fit_temperature(probe, Xva, va[label_col].to_numpy())
        probe.save(paths.models_dir)
        probs[m] = probe.predict_proba(Xte)  # test split used once
        acc = float((probs[m].argmax(1) == te.expert.to_numpy()).mean())
        report[m] = {"temperature": T, "test_acc_vs_expert": acc}
        print(f"[prostate] {m}: T={T:.2f} test acc vs expert {acc:.3f}", flush=True)
    P = probs[PRIMARY_MODEL]
    out = pd.DataFrame({"patch_id": te.patch_id, "ai_class": P.argmax(1), "ai_conf": P.max(1), "ai_entropy": entropy(P)})
    for k, c in enumerate(PROSTATE_CLASSES):
        out[f"p_{c}"] = P[:, k]
    path_models = [m for m in probs if m in PATHOLOGY_MODELS]
    if len(path_models) >= 2:
        comp = components({m: probs[m] for m in path_models})
        out["ai_disagreement"] = np.mean([midrank_percentile(v, np.sort(v)) for v in comp.values()], axis=0)
        # does model disagreement predict where residents differ from the expert?
        L = te[MARKERS].to_numpy()
        resident_err = np.where(L >= 0, L != te.expert.to_numpy()[:, None], np.nan)
        err_rate = np.nanmean(resident_err, axis=1)
        from scipy.stats import spearmanr

        rho = spearmanr(out.ai_disagreement, err_rate, nan_policy="omit")
        report["disagreement_vs_resident_error"] = {"spearman": float(rho.statistic), "p": float(rho.pvalue)}
    else:
        out["ai_disagreement"] = np.nan
    write_parquet(out, paths.eval_dir / "crowdgleason_test_ai.parquet")
    (paths.eval_dir / "prostate_probe.json").write_text(json.dumps({"title": "Prostate probe", "report": report}, indent=1))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["embed", "train"])
    ap.add_argument("--patches", type=Path, default=CG_RAW / "Patches")
    ap.add_argument("--models", nargs="+", default=["quiltnet", "plip"])
    a = ap.parse_args(argv)
    if a.stage == "embed":
        stage_embed(a.patches, a.models)
    else:
        stage_train(a.models)


if __name__ == "__main__":
    main()
