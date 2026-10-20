"""CAMELYON16 pipeline: embed (GPU) -> train (CPU) -> score (CPU) -> export.

    python -m secondlook.pipeline.run_camelyon embed  tumor_091 test_084 ... --models quiltnet plip colorhist
    python -m secondlook.pipeline.run_camelyon train  --models quiltnet plip colorhist
    python -m secondlook.pipeline.run_camelyon score  test_084 test_122 ...
    python -m secondlook.pipeline.run_camelyon all    <names...>     # embed + train + score

Train slides are CAMELYON16 tumor_* / normal_*; every test_* slide is held out
(never used to fit probes, calibrators, exemplars or the disagreement reference).
Intermediate arrays go to WORK_DIR; only what the laptop needs goes to the bundle.
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook import config
from secondlook.config import PATHOLOGY_MODELS, PRIMARY_MODEL, RAW_DIR, WORK_DIR, bundle_paths
from secondlook.geometry import TileGrid
from secondlook.ids import sequence_digest, stable_fold, tile_id
from secondlook.store import db
from secondlook.store.arrays import read_matrix, read_parquet, write_matrix, write_parquet

C16_RAW = RAW_DIR / "camelyon16"
WORK = WORK_DIR / "camelyon16"
TEXT_MODELS = PATHOLOGY_MODELS
PREPROC_VERSION = f"tiles_{config.TILE_PX}px_{config.TARGET_MPP}mpp_tissue{config.MIN_TISSUE_FRACTION}_v1"


def split_of(name: str) -> str:
    return "train" if name.startswith(("tumor_", "normal_")) else "test"


def work_dir(name: str) -> Path:
    return WORK / name


def load_info(name: str) -> dict:
    return json.loads((work_dir(name) / "info.json").read_text())


def grid_of(info: dict) -> TileGrid:
    return TileGrid(info["width"], info["height"], info["mpp"], info["tile_w0"])


# ------------------------------------------------------------------------------------------
# embed
# ------------------------------------------------------------------------------------------

def stage_embed(names, models, batch=256, workers=8, exemplars_per_class=60, force=False):
    from secondlook.pipeline.artifacts import rule_flags, tile_stats
    from secondlook.pipeline.datasets.camelyon16 import tile_overlap_fraction
    from secondlook.pipeline.embed import available_models, get_encoder
    from secondlook.pipeline.tiler import SlideError, TileReader, describe, save_thumbnail, tile_index

    encs = {m: get_encoder(m) for m in available_models(models)}
    for name in names:
        out = work_dir(name)
        out.mkdir(parents=True, exist_ok=True)
        todo = [m for m in encs if force or not (out / f"emb_{m}.npy").exists()]
        if (out / "tiles.parquet").exists() and not todo:
            print(f"[embed] {name}: up to date", flush=True)
            continue
        t0 = time.time()
        path = C16_RAW / "images" / f"{name}.tif"
        try:
            info = describe(name, path)
            tiles, frac, thumb = tile_index(info)
        except SlideError as e:
            (out / "info.json").write_text(json.dumps({"slide_id": name, "status": e.status, "detail": e.detail}))
            print(f"[embed] {name}: {e.status} ({e.detail})", flush=True)
            continue
        xml = C16_RAW / "annotations" / f"{name}.xml"
        overlap = tile_overlap_fraction(xml if xml.exists() else None, info.grid)
        tiles["tumor_overlap"] = overlap[tiles["row"], tiles["col"]].astype(np.float32)

        # exemplar candidates (training slides only)
        ex_rows: set[int] = set()
        if split_of(name) == "train":
            rng = np.random.default_rng(stable_fold(name, 2**31))
            pos = np.nonzero(tiles["tumor_overlap"].to_numpy() >= config.TUMOR_LABEL_POS_OVERLAP)[0]
            neg = np.nonzero(tiles["tumor_overlap"].to_numpy() <= config.TUMOR_LABEL_NEG_OVERLAP)[0]
            for cand in (pos, neg):
                if len(cand):
                    ex_rows.update(rng.choice(cand, min(exemplars_per_class, len(cand)), replace=False).tolist())
        ex_dir = out / "exemplar_tiles"

        reader = TileReader(info)
        n = len(tiles)
        embs = {m: np.zeros((n, encs[m].dim), np.float16) for m in todo}
        stats_parts = []
        for idx, imgs in reader.iter_batches(tiles, batch=batch, workers=workers):
            stats_parts.append((idx, tile_stats(imgs)))
            for m in todo:
                embs[m][idx] = encs[m].encode_images(imgs)
            for j, i in enumerate(idx):
                if int(i) in ex_rows:
                    import cv2

                    ex_dir.mkdir(exist_ok=True)
                    cv2.imwrite(str(ex_dir / f"{tiles.tile_id.iat[i].replace(':', '_')}.jpg"),
                                cv2.cvtColor(imgs[j], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
        stats = {k: np.concatenate([s[k] for _, s in stats_parts]) for k in stats_parts[0][1]}
        for k, v in stats.items():
            tiles[k] = v
        for k, v in rule_flags(stats).items():
            tiles[f"art_{k}"] = v
        tiles["artifact"] = tiles[[f"art_{k}" for k in ("blank", "blur", "ink", "fold")]].any(axis=1)
        tiles["exemplar_candidate"] = np.isin(np.arange(n), list(ex_rows))

        write_parquet(tiles, out / "tiles.parquet")
        for m in todo:
            write_matrix(embs[m], out / f"emb_{m}.npy", tiles["tile_id"], model=m)
        save_thumbnail(thumb, out / "thumb.jpg")
        np.save(out / "tissue_frac.npy", frac)
        (out / "info.json").write_text(json.dumps({
            "slide_id": name, "status": "ok", "path": str(path), "width": info.width, "height": info.height,
            "mpp": info.mpp, "tile_w0": info.grid.tile_w0, "rows": info.grid.rows, "cols": info.grid.cols,
            "n_tiles": n, "split": split_of(name), "has_xml": xml.exists(), "preprocessing": PREPROC_VERSION,
            "read_level": reader.level}))
        dt = time.time() - t0
        print(f"[embed] {name}: {n} tiles, models={todo}, {dt:.0f}s ({n / max(dt, 1e-6):.0f} tiles/s)", flush=True)


# ------------------------------------------------------------------------------------------
# train
# ------------------------------------------------------------------------------------------

def _training_sample(names, model, neg_per_slide, pos_per_slide, seed=0):
    X, y, groups, tids = [], [], [], []
    for name in names:
        t = read_parquet(work_dir(name) / "tiles.parquet")
        p = work_dir(name) / f"emb_{model}.npy"
        if not p.exists():
            continue
        e = read_matrix(p, t["tile_id"])
        ov = t["tumor_overlap"].to_numpy()
        keep = ~t["art_blank"].to_numpy()
        pos = np.nonzero(keep & (ov >= config.TUMOR_LABEL_POS_OVERLAP))[0]
        neg = np.nonzero(keep & (ov <= config.TUMOR_LABEL_NEG_OVERLAP))[0]
        rng = np.random.default_rng(stable_fold(name + model, 2**31) + seed)
        pos = rng.choice(pos, min(len(pos), pos_per_slide), replace=False) if len(pos) else pos
        neg = rng.choice(neg, min(len(neg), neg_per_slide), replace=False) if len(neg) else neg
        rows = np.sort(np.concatenate([pos, neg]))
        X.append(np.asarray(e[rows], dtype=np.float32))
        y.append((ov[rows] >= config.TUMOR_LABEL_POS_OVERLAP).astype(int))
        groups += [name] * len(rows)
        tids += t["tile_id"].iloc[rows].tolist()
    return np.concatenate(X), np.concatenate(y), np.asarray(groups), np.asarray(tids)


def build_text_banks(models, paths):
    from secondlook.pipeline.embed import ModelUnavailable, get_encoder
    from secondlook.pipeline.features import load_features, text_bank

    version, feats = load_features()
    out = paths.models_dir / "text_banks"
    out.mkdir(parents=True, exist_ok=True)
    built = []
    for m in models:
        if m not in TEXT_MODELS:
            continue
        try:
            enc = get_encoder(m)
        except ModelUnavailable as e:
            print(f"[train] no text bank for {m}: {e}")
            continue
        bank = text_bank(enc, feats)
        np.savez(out / f"{m}.npz", logit_scale=np.float32(enc.logit_scale), version=np.array(version),
                 ids=np.array([f.id for f in feats]), protos=np.stack([bank[f.id] for f in feats]))
        built.append(m)
    return built


def load_text_bank(paths, model):
    p = paths.models_dir / "text_banks" / f"{model}.npz"
    if not p.exists():
        return None
    d = np.load(p)
    return {"logit_scale": float(d["logit_scale"]), "ids": [str(i) for i in d["ids"]],
            "bank": {str(i): d["protos"][k] for k, i in enumerate(d["ids"])}}


def feature_matrix(emb, tb) -> tuple[list[str], np.ndarray]:
    from secondlook.pipeline.features import raw_scores

    raw = raw_scores(np.asarray(emb, dtype=np.float32), tb["bank"], tb["logit_scale"])
    return tb["ids"], np.stack([raw[i] for i in tb["ids"]], axis=1)


def stage_train(models, neg_per_slide=3000, pos_per_slide=3000):
    from secondlook.pipeline.disagreement import Reference, components
    from secondlook.pipeline.exemplars import ExemplarIndex
    from secondlook.pipeline.features import Calibrators
    from secondlook.pipeline.probes import fit_probe

    paths = bundle_paths()
    names = sorted(p.name for p in WORK.iterdir() if (p / "tiles.parquet").exists() and split_of(p.name) == "train")
    if not names:
        raise SystemExit("no embedded training slides")
    print(f"[train] {len(names)} training slides: {names}", flush=True)
    built = build_text_banks(models, paths)
    print(f"[train] text banks: {built}", flush=True)
    cal = Calibrators(paths.models_dir)
    oof_by_model, feats_by_model, sample_ids = {}, {}, None
    report = {}
    for m in models:
        X, y, groups, tids = _training_sample(names, m, neg_per_slide, pos_per_slide)
        if len(np.unique(y)) < 2:
            raise SystemExit("training sample has a single class; need tumour and normal slides")
        probe, oof = fit_probe(X, y, groups, task="tumor", model=m, classes=["benign", "tumor"],
                               n_splits=min(5, len(np.unique(groups))),
                               notes=f"CAMELYON16 train slides {len(names)}; label=overlap>={config.TUMOR_LABEL_POS_OVERLAP}")
        probe.save(paths.models_dir)
        from sklearn.metrics import roc_auc_score

        auc = float(roc_auc_score(y, oof[:, 1]))
        report[m] = {"n": int(len(y)), "pos": int(y.sum()), "slides": len(np.unique(groups)), "oof_auroc": auc, "C": probe.meta.C}
        print(f"[train] tumor probe {m}: n={len(y)} pos={int(y.sum())} OOF tile AUROC={auc:.3f}", flush=True)
        write_parquet(pd.DataFrame({"tile_id": tids, "slide_id": groups, "y": y, "p_oof": oof[:, 1]}),
                      WORK / f"tumor_oof_{m}.parquet")
        tb = load_text_bank(paths, m)
        if tb is not None:
            ids, F = feature_matrix(X, tb)
            k = ids.index("metastasis")
            meta = cal.fit(m, "metastasis", F[:, k], y, source="camelyon16_train_tiles")
            print(f"[train] calibrator metastasis/{m}: {meta}", flush=True)
            feats_by_model[m] = (tids, F)
        oof_by_model[m] = (tids, oof)

    # disagreement reference over the shared training sample (out-of-fold probabilities)
    path_models = [m for m in models if m in TEXT_MODELS and m in oof_by_model]
    if len(path_models) >= 2:
        common = set.intersection(*[set(oof_by_model[m][0]) for m in path_models])
        common = np.array(sorted(common))
        probs, feats = {}, {}
        for m in path_models:
            tid, oof = oof_by_model[m]
            pos = pd.Series(np.arange(len(tid)), index=tid)[common].to_numpy()
            probs[m] = oof[pos]
            if m in feats_by_model:
                feats[m] = feats_by_model[m][1][pos]
        comp = components(probs, feats if len(feats) == len(path_models) else None)
        ref = Reference(comp, source=f"camelyon16_train_oof:{','.join(path_models)}:n={len(common)}")
        ref.save(paths.models_dir / "disagreement_ref.npz")
        report["disagreement_ref"] = {"models": path_models, "n": int(len(common))}
        print(f"[train] disagreement reference: {ref.source}", flush=True)

    # exemplar index (primary model; training slides only)
    rows = []
    vecs = []
    ex_root = paths.exemplar_dir
    (ex_root / "images").mkdir(parents=True, exist_ok=True)
    for name in names:
        t = read_parquet(work_dir(name) / "tiles.parquet")
        sel = np.nonzero(t["exemplar_candidate"].to_numpy())[0]
        if not len(sel):
            continue
        e = read_matrix(work_dir(name) / f"emb_{PRIMARY_MODEL}.npy", t["tile_id"])
        for i in sel:
            tid = t.tile_id.iat[i]
            src = work_dir(name) / "exemplar_tiles" / f"{tid.replace(':', '_')}.jpg"
            if not src.exists():
                continue
            rel = f"images/{src.name}"
            shutil.copyfile(src, ex_root / rel)
            lab = "tumor" if t.tumor_overlap.iat[i] >= config.TUMOR_LABEL_POS_OVERLAP else "benign"
            rows.append({"exemplar_id": f"ex_{tid}", "tile_id": tid, "slide_id": name, "label": lab, "image": rel})
            vecs.append(np.asarray(e[i], dtype=np.float32))
    if rows:
        ExemplarIndex(ex_root, PRIMARY_MODEL).build(pd.DataFrame(rows), np.stack(vecs))
        report["exemplars"] = pd.DataFrame(rows).label.value_counts().to_dict()
        print(f"[train] exemplar index: {report['exemplars']}", flush=True)

    from secondlook.pipeline.export import write_manifest

    write_manifest(paths, {"tumor_probe": {"train_slides": names, "models": report, "label_rule":
                    f"tile positive if >= {config.TUMOR_LABEL_POS_OVERLAP} of area in expert mask; negative if 0; else excluded"}})
    (WORK / "train_report.json").write_text(json.dumps(report, indent=1))
    return report


# ------------------------------------------------------------------------------------------
# score
# ------------------------------------------------------------------------------------------

def stage_score(names, models, reference_labels: dict | None = None):
    from secondlook.pipeline.disagreement import Reference, case_score, components, recipe_name, tile_scores
    from secondlook.pipeline.export import assign_tiers, register_artifact, register_slide, write_regions
    from secondlook.pipeline.features import Calibrators, load_features
    from secondlook.pipeline.probes import Probe
    from secondlook.pipeline.regions import find_regions, smoothed, to_grid

    paths = bundle_paths()
    con = db.init_db(paths.db)
    _, feats = load_features()
    cal = Calibrators(paths.models_dir)
    ref_path = paths.models_dir / "disagreement_ref.npz"
    ref = Reference.load(ref_path) if ref_path.exists() else None
    probes = {}
    for m in models:
        try:
            probes[m] = Probe.load(paths.models_dir, "tumor", m)
        except FileNotFoundError:
            print(f"[score] no tumor probe for {m}; skipping that model")
    primary = PRIMARY_MODEL if PRIMARY_MODEL in probes else (next(iter(probes)) if probes else None)

    for name in names:
        info = load_info(name)
        split = split_of(name)
        label = ("tumor" if name.startswith("tumor_") else "normal" if name.startswith("normal_")
                 else (reference_labels or {}).get(name))
        if info.get("status") != "ok":
            register_slide(con, slide_id=name, dataset="camelyon16", organ="lymph_node", split=split,
                           status=info.get("status"), status_detail=info.get("detail"))
            con.commit()
            continue
        grid = grid_of(info)
        t = read_parquet(work_dir(name) / "tiles.parquet")
        sd = paths.slide_dir(name)
        sd.mkdir(parents=True, exist_ok=True)
        scores = pd.DataFrame({"tile_id": t["tile_id"]})
        emb = {m: read_matrix(work_dir(name) / f"emb_{m}.npy", t["tile_id"]) for m in probes
               if (work_dir(name) / f"emb_{m}.npy").exists()}
        probs = {m: probes[m].predict_proba(np.asarray(emb[m], dtype=np.float32)) for m in emb}
        tissue = ~t["art_blank"].to_numpy()
        artifact = t["artifact"].to_numpy()

        tumor_source = None
        if primary in probs:
            p = probs[primary][:, 1]
            scores["tumor_prob"] = p
            scores["tumor_prob_smooth"] = smoothed(t, np.where(tissue, p, np.nan), grid.shape)
            tumor_source = f"tumor_probe:{primary}:{probes[primary].meta.version}"
        for m, pr in probs.items():
            scores[f"tumor_prob_{m}"] = pr[:, 1]
        if primary in probs:
            from secondlook.pipeline.disagreement import entropy

            scores["uncertainty"] = np.where(artifact | ~tissue, np.nan, entropy(probs[primary])).astype(np.float32)

        # feature bars
        feat_raw = {}
        for m in emb:
            tb = load_text_bank(paths, m)
            if tb is None:
                continue
            ids, F = feature_matrix(emb[m], tb)
            feat_raw[m] = F
            if m == primary:
                for k, fid in enumerate(ids):
                    scores[f"feat_{fid}_raw"] = F[:, k]
                    c = cal.apply(m, fid, F[:, k])
                    if c is not None:
                        scores[f"feat_{fid}_cal"] = c

        # disagreement (pathology models with probes + text banks)
        dis_models = [m for m in probs if m in TEXT_MODELS]
        dis_source = None
        if len(dis_models) >= 2 and ref is not None:
            comp = components({m: probs[m] for m in dis_models},
                              {m: feat_raw[m] for m in dis_models} if all(m in feat_raw for m in dis_models) else None)
            for k, v in comp.items():
                scores[f"dis_{k}"] = v.astype(np.float32)
            scores["disagreement"] = tile_scores(comp, ref, exclude=artifact | ~tissue)
            dis_source = recipe_name(dis_models)

        write_parquet(scores, sd / "scores.parquet")
        keep_cols = ["tile_id", "slide_id", "row", "col", "x", "y", "w0", "tissue_fraction", "embedding_row",
                     "art_blank", "art_blur", "art_ink", "art_fold", "artifact", "lap_var", "ink_frac", "blank_frac"]
        tiles_out = t[keep_cols].copy()
        write_parquet(tiles_out, sd / "tiles.parquet")
        if primary in emb:
            write_matrix(np.asarray(emb[primary]), sd / f"emb_{primary}.npy", t["tile_id"], model=primary)
        # evaluation-only labels, kept outside the slide folder the review API reads
        if info.get("has_xml") or label == "normal":
            write_parquet(t[["tile_id", "tumor_overlap"]], paths.eval_dir / "labels" / f"{name}.parquet")
        shutil.copyfile(work_dir(name) / "thumb.jpg", sd / "thumb.jpg")
        np.save(sd / "tissue_frac.npy", np.load(work_dir(name) / "tissue_frac.npy"))

        class _Info:  # adapter for register_slide
            width, height, mpp = info["width"], info["height"], info["mpp"]
            grid_ = grid
        _Info.grid = grid
        register_slide(con, slide_id=name, dataset="camelyon16", organ="lymph_node", info=_Info,
                       image_path=info["path"], split=split, slide_label=label)
        prov = "real"
        register_artifact(con, name, "tiles", sd / "tiles.parquet", paths.root, n_rows=len(t),
                          row_digest=sequence_digest(t["tile_id"]), preprocessing_version=info["preprocessing"], provenance=prov)
        register_artifact(con, name, "scores", sd / "scores.parquet", paths.root, n_rows=len(t),
                          row_digest=sequence_digest(t["tile_id"]), model_version=tumor_source, provenance=prov)
        if primary in emb:
            register_artifact(con, name, f"emb_{primary}", sd / f"emb_{primary}.npy", paths.root, model_version=primary)

        # regions
        if "tumor_prob_smooth" in scores:
            g = to_grid(t, scores["tumor_prob_smooth"].to_numpy(), grid.shape)
            regs = find_regions(g, np.isfinite(g), config.REGION_RISK_THRESHOLD, grid, max_regions=20)
            dgrid = to_grid(t, scores["disagreement"].to_numpy(), grid.shape) if "disagreement" in scores else None
            write_regions(con, name, "evidence", regs, source=tumor_source, disagreement_grid=dgrid)
        if "disagreement" in scores:
            dgrid = to_grid(t, scores["disagreement"].to_numpy(), grid.shape)
            regs = find_regions(dgrid, np.isfinite(dgrid), 0.90, grid, max_regions=10)
            write_regions(con, name, "disputed", regs, source=dis_source, disagreement_grid=dgrid)

        if split != "train":
            ai_max = float(np.nanmax(scores["tumor_prob_smooth"].to_numpy()[tissue & ~artifact])) \
                if "tumor_prob_smooth" in scores and (tissue & ~artifact).any() else None
            db.upsert(con, "cases", {
                "case_id": f"case_{name}", "slide_id": name,
                "disagreement_score": case_score(scores["disagreement"].to_numpy()) if "disagreement" in scores else None,
                "disagreement_source": dis_source, "artifact_share": float(artifact.mean()), "ai_max_risk": ai_max,
                "uncertainty_score": case_score(scores["uncertainty"].to_numpy()) if "uncertainty" in scores else None})
        con.commit()
        print(f"[score] {name}: tiles={len(t)} primary={primary} dis={dis_source} "
              f"max_risk={scores['tumor_prob_smooth'].max() if 'tumor_prob_smooth' in scores else None}", flush=True)
    from secondlook.pipeline.export import write_manifest

    n_train = len([d for d in WORK.iterdir() if (d / "tiles.parquet").exists() and split_of(d.name) == "train"])
    write_manifest(paths, {"provenance": f"real CAMELYON16 slides; tumour probe trained on {n_train} slides"})
    tiers = assign_tiers(con, paths)
    print(f"[score] tiers: {tiers}", flush=True)
    con.close()


def main(argv=None):
    from secondlook.pipeline.datasets.camelyon16 import fetch_reference, load_reference

    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["embed", "train", "score", "all"])
    ap.add_argument("names", nargs="*")
    ap.add_argument("--models", nargs="+", default=["quiltnet", "plip", "colorhist"])
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    names = a.names or sorted(p.stem for p in (C16_RAW / "images").glob("*.tif"))
    if a.stage in ("embed", "all"):
        stage_embed(names, a.models, a.batch, a.workers, force=a.force)
    if a.stage in ("train", "all"):
        stage_train(a.models)
    if a.stage in ("score", "all"):
        ref = load_reference(fetch_reference(C16_RAW))
        test = [n for n in names if split_of(n) == "test"] if a.stage == "all" else names
        stage_score(test, a.models, ref)


if __name__ == "__main__":
    main()
