"""Sign-out check: rank unseen tissue by precomputed tumour risk and set the light.

unseen_risk = highest smoothed tumour probability over unseen, non-blank tissue.
light       = green  if unseen_risk <  lo
              amber  if lo <= unseen_risk < hi
              red    if unseen_risk >= hi
Cut-offs come from thresholds.json (nested slide-grouped CV on held-out slides).
If they are missing the default is used and flagged `default_unvalidated`.
Alerts are the top 1-2 connected unseen regions with risk >= lo.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from secondlook.config import REGION_RISK_THRESHOLD
from secondlook.geometry import TileGrid
from secondlook.pipeline.regions import Region, find_regions

DEFAULT_LIGHT = {"lo": REGION_RISK_THRESHOLD, "hi": 0.80, "source": "default_unvalidated"}


def load_light_thresholds(path: Path | None) -> dict:
    if path is not None and Path(path).exists():
        d = json.loads(Path(path).read_text()).get("light")
        if d and "lo" in d and "hi" in d:
            return d
    return dict(DEFAULT_LIGHT)


def light_for(unseen_risk: float | None, th: dict) -> str:
    if unseen_risk is None:
        return "unavailable"
    if unseen_risk >= th["hi"]:
        return "red"
    if unseen_risk >= th["lo"]:
        return "amber"
    return "green"


@dataclass
class SignoutResult:
    light: str
    unseen_risk: float | None
    regions: list[Region] = field(default_factory=list)
    unseen_tissue_share: float = 0.0
    n_tissue: int = 0
    thresholds: dict = field(default_factory=dict)
    reason: str | None = None


def unseen_check(grid: TileGrid, rows: np.ndarray, cols: np.ndarray, tissue: np.ndarray,
                 risk_smooth: np.ndarray | None, seen: np.ndarray, th: dict, max_regions: int = 2,
                 seed_threshold: float | None = None) -> SignoutResult:
    n_tissue = int(tissue.sum())
    unseen = tissue & ~seen
    share = float(unseen.sum() / max(n_tissue, 1))
    if risk_smooth is None:
        return SignoutResult("unavailable", None, [], share, n_tissue, th, "no tumour-risk scores for this slide")
    risk = np.where(unseen, np.nan_to_num(risk_smooth, nan=0.0), np.nan)
    unseen_risk = float(np.nanmax(risk)) if unseen.any() else 0.0
    light = light_for(unseen_risk, th)
    g = np.full(grid.shape, np.nan)
    g[rows, cols] = risk
    seed = th["lo"] if seed_threshold is None else seed_threshold
    regions = find_regions(g, np.isfinite(g), seed, grid, max_regions=max_regions)
    return SignoutResult(light, unseen_risk, regions, share, n_tissue, th)


def ranked_unseen_regions(grid, rows, cols, tissue, score, seen, max_regions=50, seed=0.0):
    """All unseen regions ranked by an arbitrary per-tile score (used by evaluation baselines)."""
    unseen = tissue & ~seen
    g = np.full(grid.shape, np.nan)
    g[rows, cols] = np.where(unseen, score, np.nan)
    return find_regions(g, np.isfinite(g), seed, grid, max_regions=max_regions)
