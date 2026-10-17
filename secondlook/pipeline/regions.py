"""Tile values -> grid -> 3x3 smoothing -> connected regions (8-connectivity)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from secondlook.geometry import TileGrid, smooth_grid


def to_grid(tiles: pd.DataFrame, values: np.ndarray, shape: tuple[int, int], fill=np.nan) -> np.ndarray:
    g = np.full(shape, fill, dtype=np.float64)
    g[tiles["row"].to_numpy(), tiles["col"].to_numpy()] = values
    return g


def from_grid(tiles: pd.DataFrame, grid: np.ndarray) -> np.ndarray:
    return grid[tiles["row"].to_numpy(), tiles["col"].to_numpy()]


def smoothed(tiles: pd.DataFrame, values: np.ndarray, shape, k: int = 3) -> np.ndarray:
    g = to_grid(tiles, values, shape)
    return from_grid(tiles, smooth_grid(np.nan_to_num(g), np.isfinite(g), k)).astype(np.float32)


@dataclass
class Region:
    rank: int
    rows: np.ndarray
    cols: np.ndarray
    peak_row: int
    peak_col: int
    risk: float          # max value inside the region
    mean: float
    bbox: tuple[int, int, int, int]  # level-0 x, y, w, h

    @property
    def n_tiles(self) -> int:
        return int(len(self.rows))


def find_regions(value_grid: np.ndarray, mask: np.ndarray, threshold: float, grid: TileGrid,
                 max_regions: int = 50, min_tiles: int = 1) -> list[Region]:
    """Connected components of (mask & value >= threshold), ranked by peak value."""
    from scipy.ndimage import label

    seed = mask & np.isfinite(value_grid) & (value_grid >= threshold)
    lab, n = label(seed, structure=np.ones((3, 3), int))
    regions = []
    for k in range(1, n + 1):
        rr, cc = np.nonzero(lab == k)
        if len(rr) < min_tiles:
            continue
        vals = value_grid[rr, cc]
        i = int(np.argmax(vals))
        regions.append(Region(0, rr, cc, int(rr[i]), int(cc[i]), float(vals[i]), float(vals.mean()),
                              grid.bbox_of_cells(rr, cc)))
    regions.sort(key=lambda r: (-r.risk, -r.n_tiles))
    for i, r in enumerate(regions[:max_regions]):
        r.rank = i + 1
    return regions[:max_regions]
