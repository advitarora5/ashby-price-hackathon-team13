"""One coordinate system for everything: level-0 slide pixels.

Masks, tiles, gaze fixations, viewport rectangles and viewer overlays are all
converted to level-0 pixel coordinates (origin top-left, x right, y down).
A tile grid is defined by the side length of one tile in level-0 pixels:

    tile_w0 = round(TILE_PX * target_mpp / slide_mpp)

Tile (row, col) covers level-0 pixels [col*tile_w0, (col+1)*tile_w0) x
[row*tile_w0, (row+1)*tile_w0).  The grid is never re-derived anywhere else;
services read `tile_w0`, `grid_rows`, `grid_cols` from the slides table.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class TileGrid:
    width: int        # level-0 slide width (px)
    height: int       # level-0 slide height (px)
    mpp: float        # level-0 micrometres per pixel
    tile_w0: int      # tile side in level-0 px

    @classmethod
    def for_slide(cls, width: int, height: int, mpp: float, tile_px: int, target_mpp: float) -> "TileGrid":
        if not mpp or mpp <= 0:
            raise ValueError("slide has no usable microns-per-pixel; refusing to guess magnification")
        tile_w0 = int(round(tile_px * target_mpp / mpp))
        if tile_w0 < 1:
            raise ValueError(f"target mpp {target_mpp} is finer than slide mpp {mpp}")
        return cls(int(width), int(height), float(mpp), tile_w0)

    @property
    def rows(self) -> int:
        return math.ceil(self.height / self.tile_w0)

    @property
    def cols(self) -> int:
        return math.ceil(self.width / self.tile_w0)

    @property
    def shape(self) -> tuple[int, int]:
        return self.rows, self.cols

    # level-0 point -> tile index ------------------------------------------------
    def point_to_rc(self, x: np.ndarray | float, y: np.ndarray | float):
        col = np.floor(np.asarray(x, dtype=np.float64) / self.tile_w0).astype(np.int64)
        row = np.floor(np.asarray(y, dtype=np.float64) / self.tile_w0).astype(np.int64)
        return row, col

    def rc_to_origin(self, row, col):
        return np.asarray(col) * self.tile_w0, np.asarray(row) * self.tile_w0

    def rc_to_center(self, row, col):
        x0, y0 = self.rc_to_origin(row, col)
        return x0 + self.tile_w0 / 2.0, y0 + self.tile_w0 / 2.0

    def in_bounds(self, row, col):
        row = np.asarray(row)
        col = np.asarray(col)
        return (row >= 0) & (row < self.rows) & (col >= 0) & (col < self.cols)

    def rect_to_rc_range(self, x: float, y: float, w: float, h: float) -> tuple[int, int, int, int]:
        """Inclusive-exclusive tile index range whose *centres* fall inside the rectangle."""
        t = self.tile_w0
        c0 = max(0, math.ceil((x - t / 2) / t))
        r0 = max(0, math.ceil((y - t / 2) / t))
        c1 = min(self.cols, math.floor((x + w - t / 2) / t) + 1)
        r1 = min(self.rows, math.floor((y + h - t / 2) / t) + 1)
        return r0, max(r0, r1), c0, max(c0, c1)

    def bbox_of_cells(self, rows: np.ndarray, cols: np.ndarray) -> tuple[int, int, int, int]:
        """(x, y, w, h) in level-0 px covering the given cells, clipped to the slide."""
        x0 = int(cols.min() * self.tile_w0)
        y0 = int(rows.min() * self.tile_w0)
        x1 = int(min(self.width, (cols.max() + 1) * self.tile_w0))
        y1 = int(min(self.height, (rows.max() + 1) * self.tile_w0))
        return x0, y0, x1 - x0, y1 - y0


def magnification(screen_px_per_level0_px: float | np.ndarray, slide_mpp: float):
    """Objective-equivalent magnification of what is on screen.

    Convention: 10x == 1.0 um per screen pixel, 20x == 0.5, 40x == 0.25.
    screen_px_per_level0_px is PathoGaze's `zoomScale` and OpenSeadragon's
    `viewport.viewportToImageZoom(zoom)`.
    """
    return 10.0 * np.asarray(screen_px_per_level0_px, dtype=np.float64) / float(slide_mpp)


def visual_angle_radius_px(radius_deg: float, eye_distance_mm, screen_mm_per_px: float):
    """Radius on screen (px) subtended by `radius_deg` of visual angle."""
    d = np.asarray(eye_distance_mm, dtype=np.float64)
    return d * np.tan(np.deg2rad(radius_deg)) / screen_mm_per_px


def smooth_grid(values: np.ndarray, valid: np.ndarray, k: int = 3) -> np.ndarray:
    """k x k mean over valid neighbours only (NaN where the cell itself is invalid)."""
    from scipy.ndimage import uniform_filter

    v = np.where(valid, values, 0.0).astype(np.float64)
    w = valid.astype(np.float64)
    num = uniform_filter(v, size=k, mode="constant")
    den = uniform_filter(w, size=k, mode="constant")
    out = np.full(values.shape, np.nan)
    ok = valid & (den > 0)
    out[ok] = num[ok] / den[ok]
    return out
