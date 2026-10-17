"""Stage 1: slide ingestion and tiling.

- Reads the slide with OpenSlide and records level-0 size and mpp.
- Builds a tissue mask from a low-resolution pyramid level (HSV saturation, Otsu).
- Defines the tile grid (geometry.TileGrid) and keeps tiles with enough tissue.
- Streams 224x224 RGB tiles at ~TARGET_MPP for the artifact gate and the embedders
  with a thread pool (OpenSlide releases the GIL inside read_region).
"""
from __future__ import annotations

import math
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd

from secondlook import config
from secondlook.geometry import TileGrid
from secondlook.ids import tile_id


class SlideError(RuntimeError):
    """Slide missing, unreadable, or without usable magnification."""

    def __init__(self, status: str, detail: str):
        super().__init__(f"{status}: {detail}")
        self.status = status
        self.detail = detail


def open_slide(path: Path):
    import openslide

    path = Path(path)
    if not path.exists():
        raise SlideError("unreadable", f"file not found: {path}")
    try:
        return openslide.OpenSlide(str(path))
    except Exception as e:  # OpenSlideUnsupportedFormatError, OpenSlideError
        raise SlideError("unreadable", f"{type(e).__name__}: {e}") from e


def slide_mpp(slide) -> float:
    p = slide.properties
    for key in ("openslide.mpp-x", "aperio.MPP"):
        if key in p:
            try:
                v = float(p[key])
                if v > 0:
                    return v
            except ValueError:
                pass
    # Generic TIFF fallback: XResolution in pixels per ResolutionUnit
    xres, unit = p.get("tiff.XResolution"), p.get("tiff.ResolutionUnit", "").lower()
    if xres:
        xres = float(xres)
        if unit in ("centimeter", "3") and xres > 0:
            return 1e4 / xres
        if unit in ("inch", "2") and xres > 0:
            return 25400.0 / xres
    raise SlideError("no_mpp", "slide has no microns-per-pixel metadata; refusing to guess magnification")


@dataclass
class SlideInfo:
    slide_id: str
    path: Path
    width: int
    height: int
    mpp: float
    grid: TileGrid
    level_count: int
    level_downsamples: tuple[float, ...]


def describe(slide_id: str, path: Path, target_mpp: float = config.TARGET_MPP) -> SlideInfo:
    s = open_slide(path)
    try:
        mpp = slide_mpp(s)
        w, h = s.dimensions
        if mpp > target_mpp * 1.05:
            raise SlideError("incompatible_magnification",
                             f"slide mpp {mpp:.3f} is coarser than target {target_mpp}")
        grid = TileGrid.for_slide(w, h, mpp, config.TILE_PX, target_mpp)
        return SlideInfo(slide_id, Path(path), w, h, mpp, grid, s.level_count, tuple(s.level_downsamples))
    finally:
        s.close()


def _read_level_image(slide, max_downsample: float) -> tuple[np.ndarray, float]:
    """Whole slide at the coarsest level whose downsample <= max_downsample (RGB uint8)."""
    level = 0
    for i, ds in enumerate(slide.level_downsamples):
        if ds <= max_downsample:
            level = i
    ds = slide.level_downsamples[level]
    w, h = slide.level_dimensions[level]
    img = slide.read_region((0, 0), level, (w, h))
    return _rgba_to_rgb(np.asarray(img)), ds


def _rgba_to_rgb(a: np.ndarray) -> np.ndarray:
    if a.shape[-1] == 3:
        return a
    rgb = a[..., :3].astype(np.float32)
    alpha = a[..., 3:4].astype(np.float32) / 255.0
    return (rgb * alpha + 255.0 * (1 - alpha)).astype(np.uint8)  # transparent => white glass


def tissue_fraction_grid(slide, grid: TileGrid, supersample: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Per-tile tissue fraction plus an RGB thumbnail at the same resolution."""
    import cv2

    img, ds = _read_level_image(slide, max_downsample=grid.tile_w0 / supersample)
    # Pad to the full grid extent so cell (r, c) maps exactly to supersample x supersample pixels
    full_w = grid.cols * grid.tile_w0 / ds
    full_h = grid.rows * grid.tile_w0 / ds
    pad = np.full((int(math.ceil(full_h)), int(math.ceil(full_w)), 3), 255, np.uint8)
    pad[: img.shape[0], : img.shape[1]] = img[: pad.shape[0], : pad.shape[1]]
    canvas = cv2.resize(pad, (grid.cols * supersample, grid.rows * supersample), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(canvas, cv2.COLOR_RGB2HSV)
    sat, val = hsv[..., 1], hsv[..., 2]
    thr, _ = cv2.threshold(sat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Otsu on saturation locks onto dark lymphoid tissue and drops pale stroma/fat, so cap
    # it low; the floor guards against Otsu splitting glass noise on near-empty slides.
    thr = float(np.clip(thr, 0.05 * 255, 0.08 * 255))
    mask = (sat > thr) & (val > 0.08 * 255)  # exclude black scanner borders
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    frac = mask.reshape(grid.rows, supersample, grid.cols, supersample).mean(axis=(1, 3))
    return frac.astype(np.float32), canvas


def tile_index(info: SlideInfo, min_tissue: float = config.MIN_TISSUE_FRACTION) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Returns (tiles dataframe in row-major order, tissue fraction grid, thumbnail)."""
    s = open_slide(info.path)
    try:
        frac, thumb = tissue_fraction_grid(s, info.grid)
    finally:
        s.close()
    rows, cols = np.nonzero(frac >= min_tissue)
    if len(rows) == 0:
        raise SlideError("no_tissue", f"no tile has tissue fraction >= {min_tissue}")
    order = np.lexsort((cols, rows))
    rows, cols = rows[order], cols[order]
    x0, y0 = info.grid.rc_to_origin(rows, cols)
    df = pd.DataFrame({
        "tile_id": [tile_id(info.slide_id, r, c) for r, c in zip(rows, cols)],
        "slide_id": info.slide_id,
        "row": rows.astype(np.int32), "col": cols.astype(np.int32),
        "x": x0.astype(np.int64), "y": y0.astype(np.int64),
        "w0": np.int32(info.grid.tile_w0),
        "tissue_fraction": frac[rows, cols].astype(np.float32),
    })
    df["embedding_row"] = np.arange(len(df), dtype=np.int64)
    return df, frac, thumb


class TileReader:
    """Thread-safe tile reader: one OpenSlide handle per thread."""

    def __init__(self, info: SlideInfo, tile_px: int = config.TILE_PX):
        self.info = info
        self.tile_px = tile_px
        self._local = threading.local()
        s = open_slide(info.path)
        ds = info.grid.tile_w0 / tile_px
        self.level = s.get_best_level_for_downsample(ds + 1e-6)
        self.level_ds = s.level_downsamples[self.level]
        s.close()

    def _slide(self):
        if not hasattr(self._local, "s"):
            self._local.s = open_slide(self.info.path)
        return self._local.s

    def read(self, x: int, y: int) -> np.ndarray:
        import cv2

        n = int(math.ceil(self.info.grid.tile_w0 / self.level_ds))
        region = self._slide().read_region((int(x), int(y)), self.level, (n, n))
        rgb = _rgba_to_rgb(np.asarray(region))
        if rgb.shape[0] != self.tile_px:
            rgb = cv2.resize(rgb, (self.tile_px, self.tile_px), interpolation=cv2.INTER_AREA)
        return rgb

    def iter_batches(self, tiles: pd.DataFrame, batch: int = 256, workers: int = 8,
                     prefetch: int = 3) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """Yields (row indices into `tiles`, uint8 array [B, 224, 224, 3]) in order.
        A producer thread reads ahead `prefetch` batches so slide I/O overlaps GPU work."""
        import queue

        xs, ys = tiles["x"].to_numpy(), tiles["y"].to_numpy()
        q: queue.Queue = queue.Queue(maxsize=prefetch)
        done = object()

        def produce():
            try:
                with ThreadPoolExecutor(workers) as pool:
                    for start in range(0, len(tiles), batch):
                        idx = np.arange(start, min(start + batch, len(tiles)))
                        imgs = list(pool.map(lambda i: self.read(xs[i], ys[i]), idx))
                        q.put((idx, np.stack(imgs)))
            except BaseException as e:  # surface reader errors in the consumer
                q.put(e)
            q.put(done)

        t = threading.Thread(target=produce, daemon=True)
        t.start()
        while True:
            item = q.get()
            if item is done:
                break
            if isinstance(item, BaseException):
                raise item
            yield item


def save_thumbnail(thumb: np.ndarray, path: Path, max_side: int = 2048) -> Path:
    import cv2

    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = thumb.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1:
        thumb = cv2.resize(thumb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(path), cv2.cvtColor(thumb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return path
