"""Coverage: which tissue tiles did the reader inspect?

Two definitions that are never mixed (CoverageParams.mode):

gaze      A tile is seen if its centre lies within `radius_deg` of visual angle
          of a fixation made at >= `min_magnification`. The radius is converted
          to screen px from the eye distance (eye tracker, or default), then to
          level-0 px by dividing by the zoom (screen px per level-0 px).
viewport  A tile is seen if its centre was inside the on-screen viewport at
          >= `min_magnification`. This is weaker evidence: being on screen does
          not prove anyone looked at it.

Dwell is accumulated per tile (fixation durations for gaze; time until the
next viewport event, capped, for viewport). Events are sorted by (t_ms, seq)
before use so out-of-order arrivals give the same answer.

This module is shared by the live API, the PathoGaze replay and evaluation.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from secondlook.config import CoverageParams
from secondlook.geometry import TileGrid, magnification, visual_angle_radius_px


@dataclass
class Coverage:
    seen: np.ndarray       # bool [N] aligned with the slide's tiles.parquet
    dwell_ms: np.ndarray   # float32 [N]
    max_mag: np.ndarray    # float32 [N] highest magnification at which the tile was touched (0 = never)
    n_events_used: int
    mode: str

    def as_array(self) -> np.ndarray:
        return np.stack([self.seen.astype(np.float32), self.dwell_ms, self.max_mag], axis=1)

    @classmethod
    def from_array(cls, a: np.ndarray, mode: str) -> "Coverage":
        return cls(a[:, 0] > 0.5, a[:, 1].astype(np.float32), a[:, 2].astype(np.float32), -1, mode)


EVENT_COLUMNS = ["seq", "t_ms", "kind", "x", "y", "w", "h", "zoom", "duration_ms", "eye_mm"]


def normalise_events(ev: pd.DataFrame) -> pd.DataFrame:
    """Sort by time then seq, drop duplicate seq, drop rows with missing geometry."""
    if ev is None or len(ev) == 0:
        return pd.DataFrame(columns=EVENT_COLUMNS)
    ev = ev.copy()
    if "seq" not in ev:
        ev["seq"] = np.arange(len(ev))
    ev = ev.drop_duplicates("seq", keep="last")
    ev = ev.dropna(subset=["t_ms", "x", "y", "zoom"])
    ev = ev[ev["zoom"] > 0]
    return ev.sort_values(["t_ms", "seq"], kind="stable").reset_index(drop=True)


def _tile_lookup(grid: TileGrid, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    lut = np.full(grid.shape, -1, dtype=np.int64)
    lut[rows, cols] = np.arange(len(rows))
    return lut


def compute(events: pd.DataFrame, grid: TileGrid, rows: np.ndarray, cols: np.ndarray,
            params: CoverageParams) -> Coverage:
    n = len(rows)
    seen = np.zeros(n, bool)
    dwell = np.zeros(n, np.float32)
    maxmag = np.zeros(n, np.float32)
    ev = normalise_events(events)
    kind = "fixation" if params.mode == "gaze" else "viewport"
    ev = ev[ev["kind"] == kind]
    if not len(ev):
        return Coverage(seen, dwell, maxmag, 0, params.mode)
    lut = _tile_lookup(grid, rows, cols)
    t = grid.tile_w0
    mags = magnification(ev["zoom"].to_numpy(), grid.mpp)
    used = 0

    if params.mode == "gaze":
        eye = ev["eye_mm"].to_numpy(dtype=np.float64) if "eye_mm" in ev else np.full(len(ev), np.nan)
        eye = np.where(np.isfinite(eye) & (eye > 100), eye, params.eye_distance_mm)
        r_screen = visual_angle_radius_px(params.radius_deg, eye, params.screen_mm_per_px)
        r_img = r_screen / ev["zoom"].to_numpy()
        xs, ys = ev["x"].to_numpy(), ev["y"].to_numpy()
        dur = np.nan_to_num(ev["duration_ms"].to_numpy(dtype=np.float64), nan=0.0)
        for i in range(len(ev)):
            r = r_img[i]
            c0, c1 = int(max(0, (xs[i] - r) // t)), int(min(grid.cols - 1, (xs[i] + r) // t))
            r0, r1 = int(max(0, (ys[i] - r) // t)), int(min(grid.rows - 1, (ys[i] + r) // t))
            if c1 < c0 or r1 < r0:
                continue
            rr, cc = np.mgrid[r0:r1 + 1, c0:c1 + 1]
            cx, cy = (cc + 0.5) * t, (rr + 0.5) * t
            inside = (cx - xs[i]) ** 2 + (cy - ys[i]) ** 2 <= r * r
            idx = lut[rr[inside], cc[inside]]
            idx = idx[idx >= 0]
            if not len(idx):
                continue
            used += 1
            maxmag[idx] = np.maximum(maxmag[idx], mags[i])
            if mags[i] >= params.min_magnification:
                seen[idx] = True
                dwell[idx] += dur[i]
    else:
        tt = ev["t_ms"].to_numpy(dtype=np.float64)
        dt = np.diff(np.append(tt, tt[-1]))
        dur_given = ev["duration_ms"].to_numpy(dtype=np.float64) if "duration_ms" in ev else np.full(len(ev), np.nan)
        dt = np.where(np.isfinite(dur_given), dur_given, dt)
        dt = np.clip(dt, 0, params.viewport_max_dwell_ms)
        xs, ys = ev["x"].to_numpy(), ev["y"].to_numpy()
        ws, hs = ev["w"].to_numpy(), ev["h"].to_numpy()
        for i in range(len(ev)):
            if not (np.isfinite(ws[i]) and np.isfinite(hs[i])):
                continue
            r0, r1, c0, c1 = grid.rect_to_rc_range(xs[i], ys[i], ws[i], hs[i])
            if r1 <= r0 or c1 <= c0:
                continue
            idx = lut[r0:r1, c0:c1].ravel()
            idx = idx[idx >= 0]
            if not len(idx):
                continue
            used += 1
            maxmag[idx] = np.maximum(maxmag[idx], mags[i])
            if mags[i] >= params.min_magnification:
                seen[idx] = True
                dwell[idx] += dt[i]
    return Coverage(seen, dwell, maxmag, used, params.mode)
