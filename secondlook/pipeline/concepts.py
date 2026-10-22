"""Explain the tumour score in words (concept explanations, after CoCoX).

CoCoX (Sadashivaiah, Yan, Hendler; NeurIPS 2024 AIM-FM workshop, arXiv:2407.00557) explained chest
X-ray classifiers with text concepts taken from a vision-language model's joint space: a concept
direction is text("... with {concept}") minus a neutral text, and the classifier is explained by how
it responds along those directions. Here the "VLM + linear" case applies directly: the tumour probe
is logistic regression on CONCH image embeddings, and the concept directions are the feature text
bank's positive-minus-negative prototypes (config/features.yaml), in the same CONCH space.

The explainer is a small surrogate fitted to the probe (not to labels): the probe's tumour logit is
regressed on each tile's standardised similarity to the concept directions, with every concept held
to the sign of its own correlation with the logit (non-negative least squares on sign-flipped
inputs), so "for" and "against" mean what they say. A tile's explanation is each concept's
contribution relative to the typical benign tile (probe probability < 0.1). Labels are never used
to fit; eval/concepts_eval.py measures fidelity and faithfulness against the expert masks.

    python -m secondlook.pipeline.concepts      # writes <bundle>/models/concepts_<model>.json
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from secondlook.config import PRIMARY_MODEL, BundlePaths, bundle_paths

BENIGN_PROB = 0.1        # baseline: tiles the probe calls clearly benign
# "metastatic carcinoma" is left out of the shown explanation: "tumour because it looks like tumour"
# is circular. Without it, morphology concepts alone carry the score (eval/concepts_eval.py).
DEFAULT_DROP = ("metastasis",)
# Lymph-node vocabulary groups left out of the explanation: "circular" names the answer; "artifact"
# and "other" (fluid, vessels, fat, ink, ...) let the surrogate explain tumour by what is absent
# ("little pink fluid"), which read poorly. Cells and node structures alone keep AUROC 0.991 on the
# held-out slides (eval/concepts_eval.py).
HIDDEN_GROUPS = ("circular", "artifact", "other")
FIT_TILES = 80_000       # tiles sampled across slides to fit the surrogate
VERSION = "concepts_v1"


def concepts_path(paths: BundlePaths, model: str = PRIMARY_MODEL) -> Path:
    return paths.models_dir / f"concepts_{model}.json"


def probe_line(paths: BundlePaths, model: str = PRIMARY_MODEL) -> tuple[np.ndarray, float]:
    """The tumour probe as one direction and offset on raw embeddings: logit = x @ v + b."""
    from secondlook.pipeline.probes import Probe

    p = Probe.load(paths.models_dir, "tumor", model)
    coef = p.clf.coef_.ravel()
    v = coef / p.scaler.scale_
    b = float(p.clf.intercept_[0] - (coef * p.scaler.mean_ / p.scaler.scale_).sum()) / p.meta.temperature
    return (v / p.meta.temperature).astype(np.float32), b


def vocab_path(paths: BundlePaths, model: str = PRIMARY_MODEL) -> Path:
    return paths.models_dir / f"concept_vocab_{model}.npz"


def default_vocab(paths: BundlePaths, model: str = PRIMARY_MODEL) -> str:
    """The lymph-node vocabulary (scripts/build_concept_vocab.py) when built, else the 11 feature prompts."""
    return "lymph_node" if vocab_path(paths, model).exists() else "bank"


def default_drop(paths: BundlePaths, vocab: str, model: str = PRIMARY_MODEL) -> tuple[str, ...]:
    """Concepts that name the answer: encoded for the sanity check, left out of the shown explanation."""
    if vocab == "bank":
        return DEFAULT_DROP
    d = np.load(vocab_path(paths, model))
    return tuple(str(i) for i, g in zip(d["ids"], d["groups"]) if str(g) in HIDDEN_GROUPS)


def circular_ids(paths: BundlePaths, vocab: str, model: str = PRIMARY_MODEL) -> tuple[str, ...]:
    """Concepts that name the answer (for the sanity check that adds them back)."""
    if vocab == "bank":
        return DEFAULT_DROP
    d = np.load(vocab_path(paths, model))
    return tuple(str(i) for i, g in zip(d["ids"], d["groups"]) if str(g) == "circular")


def concept_directions(paths: BundlePaths, model: str = PRIMARY_MODEL, drop: tuple[str, ...] = (), vocab: str = "bank"):
    """(ids, labels, [k, D] unit directions): the lymph-node vocabulary (text(phrase) - text(neutral)),
    or the feature text bank (positive minus negative prototype)."""
    from secondlook.pipeline.features import load_features
    from secondlook.pipeline.run_camelyon import load_text_bank

    if vocab == "lymph_node":
        d = np.load(vocab_path(paths, model))
        keep = [k for k, i in enumerate(d["ids"]) if str(i) not in drop]
        return [str(d["ids"][k]) for k in keep], [str(d["labels"][k]) for k in keep], d["directions"][keep].astype(np.float32)

    tb = load_text_bank(paths, model)
    if tb is None:
        raise FileNotFoundError(f"no text bank for {model} in {paths.models_dir / 'text_banks'}")
    labels = {f.id: f.label for f in load_features()[1]}
    ids = [i for i in tb["ids"] if i not in drop]
    C = np.stack([tb["bank"][i][0] - tb["bank"][i][1] for i in ids]).astype(np.float32)
    return ids, [labels.get(i, i) for i in ids], C / np.linalg.norm(C, axis=1, keepdims=True)


@dataclass
class Explainer:
    model: str
    ids: list[str]
    labels: list[str]
    C: np.ndarray          # [k, D] concept directions
    mu: np.ndarray         # [k] similarity mean (fit tiles)
    sd: np.ndarray         # [k] similarity sd
    weight: np.ndarray     # [k] logit per sd of similarity; sign fixed to the concept's own correlation
    offset: float
    baseline: np.ndarray   # [k] standardised similarity of the typical benign tile
    v: np.ndarray          # probe direction, for the residual
    b: float
    meta: dict

    def z(self, X: np.ndarray) -> np.ndarray:
        return (np.asarray(X, np.float32) @ self.C.T - self.mu) / self.sd

    def words_logit(self, X: np.ndarray) -> np.ndarray:
        return self.z(X) @ self.weight + self.offset

    def explain(self, X: np.ndarray) -> dict:
        """Explain one tile or the mean of a region's tiles."""
        X = np.atleast_2d(np.asarray(X, np.float32))
        z = self.z(X).mean(axis=0)
        contrib = self.weight * (z - self.baseline)
        full = float((X @ self.v + self.b).mean())
        base = float(self.baseline @ self.weight + self.offset)
        words = float(base + contrib.sum())
        rows = [{"id": i, "label": l, "contribution": round(float(c), 3), "similarity_sd": round(float(zz - bb), 2)}
                for i, l, c, zz, bb in zip(self.ids, self.labels, contrib, z, self.baseline) if self.weight[self.ids.index(i)] != 0]
        rows.sort(key=lambda r: -abs(r["contribution"]))
        moved = full - base
        return {"tumour_logit": round(full, 3), "benign_logit": round(base, 3), "words_logit": round(words, 3),
                "explained_share": None if abs(moved) < 1e-6 else round(float(np.clip((words - base) / moved, 0, 1.5)), 3),
                "for": [r for r in rows if r["contribution"] > 0.05], "against": [r for r in rows if r["contribution"] < -0.05],
                "concepts": rows}


def fit(X: np.ndarray, paths: BundlePaths, model: str = PRIMARY_MODEL, drop: tuple[str, ...] = DEFAULT_DROP,
        seed: int = 0, source: str = "bundle", vocab: str = "bank") -> Explainer:
    """Fit the sign-constrained surrogate to the probe's logits on tissue tiles X (labels not used)."""
    from scipy.optimize import nnls

    v, b = probe_line(paths, model)
    ids, labels, C = concept_directions(paths, model, drop, vocab)
    X = np.asarray(X, np.float32)
    rng = np.random.default_rng(seed)
    if len(X) > FIT_TILES:
        X = X[rng.choice(len(X), FIT_TILES, replace=False)]
    logit = X @ v + b
    S = X @ C.T
    mu, sd = S.mean(0), S.std(0) + 1e-6
    Z = (S - mu) / sd
    sign = np.sign([np.corrcoef(Z[:, k], logit)[0, 1] for k in range(len(ids))])
    sign[sign == 0] = 1
    w, _ = nnls(Z * sign, logit - logit.mean())
    weight = (w * sign).astype(np.float32)
    offset = float(logit.mean())
    pred = Z @ weight + offset
    r2 = 1 - float(((logit - pred) ** 2).sum() / ((logit - logit.mean()) ** 2).sum())
    benign = 1 / (1 + np.exp(-logit)) < BENIGN_PROB
    baseline = Z[benign].mean(0) if benign.any() else np.zeros(len(ids), np.float32)
    meta = {"version": VERSION, "model": model, "n_fit": int(len(X)), "r2_vs_probe_logit": round(r2, 4),
            "dropped": list(drop), "vocab": vocab, "n_concepts": len(ids), "benign_prob": BENIGN_PROB, "fit_on": source,
            "method": "sign-constrained least squares of the probe logit on CONCH concept similarities (CoCoX-style)"}
    return Explainer(model, ids, labels, C, mu.astype(np.float32), sd.astype(np.float32), weight, offset,
                     baseline.astype(np.float32), v, b, meta)


def save(e: Explainer, paths: BundlePaths) -> Path:
    p = concepts_path(paths, e.model)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"ids": e.ids, "labels": e.labels, "mu": e.mu.tolist(), "sd": e.sd.tolist(),
                             "weight": e.weight.tolist(), "offset": e.offset, "baseline": e.baseline.tolist(),
                             "meta": e.meta}, indent=1))
    return p


def load(paths: BundlePaths, model: str = PRIMARY_MODEL) -> Explainer | None:
    p = concepts_path(paths, model)
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    ids, labels, C = concept_directions(paths, model, tuple(d["meta"].get("dropped", ())), d["meta"].get("vocab", "bank"))
    if ids != d["ids"]:
        return None  # text bank changed since the explainer was fitted
    v, b = probe_line(paths, model)
    a = lambda k: np.asarray(d[k], np.float32)  # noqa: E731
    return Explainer(model, ids, labels, C, a("mu"), a("sd"), a("weight"), float(d["offset"]), a("baseline"), v, b, d["meta"])


def training_slide_dirs(paths: BundlePaths) -> list[Path]:
    """Work folders of the slides the tumour probe was trained on (manifest), when on this machine."""
    from secondlook.config import WORK_DIR

    if not paths.manifest.exists():
        return []
    names = json.loads(paths.manifest.read_text()).get("tumor_probe", {}).get("train_slides", [])
    return [WORK_DIR / "camelyon16" / n for n in names if (WORK_DIR / "camelyon16" / n / "tiles.parquet").exists()]


def tissue_embeddings(paths: BundlePaths, model: str = PRIMARY_MODEL, per_slide: int | None = None, seed: int = 0,
                      slide_dirs: list[Path] | None = None):
    """Embeddings of tissue tiles (no blank/artifact): every scored slide in the bundle, or the given
    work folders (each with tiles.parquet and emb_<model>.npy)."""
    import pandas as pd

    from secondlook.store.arrays import AlignmentError, read_matrix

    rng = np.random.default_rng(seed)
    out = []
    dirs = slide_dirs if slide_dirs is not None else sorted((paths.root / "slides").iterdir())
    for d in dirs:
        tp = d / "tiles.parquet"
        ep = d / f"emb_{model}.npy" if slide_dirs is not None else paths.embedding(d.name, model)
        if not tp.exists() or not ep.exists():
            continue
        t = pd.read_parquet(tp)
        try:
            e = np.asarray(read_matrix(ep, t["tile_id"]), np.float32)
        except AlignmentError:
            continue
        m = ~t["art_blank"].to_numpy(bool)
        if "artifact" in t:
            m &= ~t["artifact"].to_numpy(bool)
        idx = np.flatnonzero(m)
        if per_slide and len(idx) > per_slide:
            idx = rng.choice(idx, per_slide, replace=False)
        out.append(e[idx])
    if not out:
        raise FileNotFoundError(f"no {model} embeddings under {paths.root / 'slides'}")
    return np.concatenate(out)


def fit_default(paths: BundlePaths, drop: tuple[str, ...] | None = None, vocab: str | None = None) -> Explainer:
    """Fit on the probe's training slides when they are on this machine (so the test slides stay
    held out), else on the bundle's slides."""
    vocab = vocab or default_vocab(paths)
    drop = default_drop(paths, vocab) if drop is None else drop
    train = training_slide_dirs(paths)
    if train:
        return fit(tissue_embeddings(paths, per_slide=4000, slide_dirs=train), paths, drop=drop,
                   source=f"{len(train)} probe training slides", vocab=vocab)
    return fit(tissue_embeddings(paths, per_slide=4000), paths, drop=drop, source="bundle slides", vocab=vocab)


if __name__ == "__main__":
    import sys

    paths = bundle_paths()
    e = fit_default(paths, vocab=sys.argv[1] if len(sys.argv) > 1 else None)
    print(save(e, paths), e.meta)
    print({l: round(float(w), 2) for l, w in zip(e.labels, e.weight)})
