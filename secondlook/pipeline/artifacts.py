"""Stage 2: artifact gate.

Rules on each 224 px tile (OpenCV/NumPy), optionally combined with text
descriptors ("pen marking", "out of focus", "folded tissue") scored by a
vision-language encoder. Flags are *warnings*: flagged tiles stay in the tile
index and remain viewable; they are only excluded from the disagreement score.
"""
from __future__ import annotations

import numpy as np

from secondlook.config import ARTIFACT_RULES, ArtifactRules

FLAGS = ("blank", "blur", "ink", "fold")


def tile_stats(batch: np.ndarray) -> dict[str, np.ndarray]:
    """batch: uint8 [B, H, W, 3] RGB -> per-tile statistics used by the rules."""
    import cv2

    n = batch.shape[0]
    out = {k: np.zeros(n, np.float32) for k in ("blank_frac", "lap_var", "ink_frac", "fold_frac", "sat_mean")}
    for i in range(n):
        rgb = batch[i]
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        h = hsv[..., 0].astype(np.float32) * 2.0  # degrees
        s = hsv[..., 1].astype(np.float32) / 255.0
        v = hsv[..., 2].astype(np.float32) / 255.0
        glass = (s < 0.08) & (v > 0.82)
        tissue = ~glass
        out["blank_frac"][i] = glass.mean()
        out["sat_mean"][i] = s.mean()
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        lap = cv2.Laplacian(gray, cv2.CV_64F)
        # variance of the Laplacian over tissue only: glass is flat and would fake "blur"
        out["lap_var"][i] = lap[tissue].var() if tissue.sum() > 500 else np.nan
        # H&E lives in pink-to-purple hues (~270..360 and 0..25 deg). Green/blue/cyan
        # ink and near-black marker sit outside it. Blue marker is ~225..245 deg, so the band
        # runs to 250 (v1 stopped at 225 and missed blue entirely); on 3,239 real CAMELYON16
        # tissue tiles that adds ~0.03% of saturated pixels.
        colored_ink = (s > 0.25) & (v > 0.15) & (h >= 70) & (h <= 250)
        black_ink = (v < 0.18) & (s < 0.6)
        out["ink_frac"][i] = (colored_ink | black_ink).mean()
        # folds: double-thickness tissue is dark and saturated (weak heuristic)
        out["fold_frac"][i] = ((s > 0.55) & (v < 0.45)).mean()
    return out


def rule_flags(stats: dict[str, np.ndarray], rules: ArtifactRules = ARTIFACT_RULES) -> dict[str, np.ndarray]:
    blank = stats["blank_frac"] >= rules.blank_frac
    lap = np.nan_to_num(stats["lap_var"], nan=np.inf)
    blur = (~blank) & (lap < rules.blur_laplacian_var)
    ink = stats["ink_frac"] >= rules.ink_frac
    fold = (~blank) & (stats["fold_frac"] >= rules.fold_frac)
    return {"blank": blank, "blur": blur, "ink": ink, "fold": fold}


ARTIFACT_PROMPTS = {
    "ink": (["a histology slide with pen marking", "blue ink marker on a glass slide", "green pen ink over tissue"],
            ["a clean histology image of tissue"]),
    "blur": (["an out of focus blurry histology image", "a blurred microscopy image"],
             ["a sharp in focus histology image"]),
    "fold": (["folded tissue on a histology slide", "a tissue fold artifact"],
             ["flat well-prepared tissue section"]),
    "blank": (["empty glass slide background", "white background with no tissue"],
              ["tissue on a histology slide"]),
}


def combine(rule: dict[str, np.ndarray], text_prob: dict[str, np.ndarray] | None, mode: str = "rules") -> dict[str, np.ndarray]:
    """mode: rules | text | rules_or_text. The text path needs calibrated cutoffs to be
    trusted; until evaluation fixes them, `rules` is the shipped default."""
    if mode == "rules" or not text_prob:
        return rule
    out = {}
    for k in FLAGS:
        t = text_prob.get(k)
        t_flag = (t >= 0.5) if t is not None else np.zeros_like(rule[k])
        out[k] = t_flag if mode == "text" else (rule[k] | t_flag)
    return out


def inject_pen(rgb: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Synthetic pen stroke for sanity-checking ink recall (not a substitute for real tiles)."""
    import cv2

    out = rgb.copy()
    color = [(30, 140, 60), (40, 70, 170), (60, 90, 200), (20, 20, 20)][rng.integers(4)]
    pts = rng.integers(0, rgb.shape[0], size=(4, 2)).astype(np.int32)
    cv2.polylines(out, [pts], False, color, thickness=int(rng.integers(10, 26)))
    return out


def inject_blur(rgb: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    import cv2

    k = int(rng.choice([9, 13, 17]))
    return cv2.GaussianBlur(rgb, (k, k), 0)
