"""Read-side access to the bundle for the API.

Loads per-slide arrays lazily (small LRU), checks row alignment against the
artifact manifest, and never fabricates values: missing pieces are reported
as `unavailable` with a reason.
"""
from __future__ import annotations

import json
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.config import DATA_ROOT, PRIMARY_MODEL, RAW_DIR, BundlePaths, bundle_paths
from secondlook.geometry import TileGrid
from secondlook.ids import sequence_digest
from secondlook.store import db
from secondlook.store.arrays import AlignmentError, read_matrix


class Unavailable(Exception):
    def __init__(self, what: str, reason: str):
        super().__init__(f"{what} unavailable: {reason}")
        self.what, self.reason = what, reason


@dataclass
class SlideData:
    slide_id: str
    row: dict
    grid: TileGrid
    tiles: pd.DataFrame
    scores: pd.DataFrame | None
    problems: list[str] = field(default_factory=list)
    _emb: np.ndarray | None = None
    _lut: np.ndarray | None = None

    @property
    def rows(self) -> np.ndarray:
        return self.tiles["row"].to_numpy()

    @property
    def cols(self) -> np.ndarray:
        return self.tiles["col"].to_numpy()

    @property
    def tissue(self) -> np.ndarray:
        return ~self.tiles["art_blank"].to_numpy()

    def col(self, name: str) -> np.ndarray | None:
        if self.scores is None or name not in self.scores:
            return None
        return self.scores[name].to_numpy()

    def lut(self) -> np.ndarray:
        if self._lut is None:
            lut = np.full(self.grid.shape, -1, np.int64)
            lut[self.rows, self.cols] = np.arange(len(self.tiles))
            self._lut = lut
        return self._lut

    def index_of(self, tile_id: str) -> int | None:
        hit = np.nonzero(self.tiles["tile_id"].to_numpy() == tile_id)[0]
        return int(hit[0]) if len(hit) else None


class Store:
    def __init__(self, paths: BundlePaths | None = None, cache_size: int = 6):
        self.paths = paths or bundle_paths()
        self._cache: OrderedDict[str, SlideData] = OrderedDict()
        self._lock = threading.Lock()
        self.cache_size = cache_size
        self._exemplars = None
        self._dz: dict[str, object] = {}
        db.init_db(self.paths.db).close()  # creates or migrates once per process

    def con(self):
        return db.connect(self.paths.db)

    def thresholds(self) -> dict:
        p = self.paths.thresholds
        return json.loads(p.read_text()) if p.exists() else {}

    def manifest(self) -> dict:
        p = self.paths.manifest
        return json.loads(p.read_text()) if p.exists() else {}

    # ------------------------------------------------------------------ slides
    def slide(self, slide_id: str) -> SlideData:
        with self._lock:
            if slide_id in self._cache:
                self._cache.move_to_end(slide_id)
                return self._cache[slide_id]
        con = self.con()
        try:
            row = db.one(con, "SELECT * FROM slides WHERE slide_id=?", slide_id)
            manif = {r["artifact_type"]: r for r in db.all_(con, "SELECT * FROM artifact_manifests WHERE slide_id=?", slide_id)}
        finally:
            con.close()
        if row is None:
            raise Unavailable("slide", f"{slide_id} is not in the database")
        if row["status"] != "ok":
            raise Unavailable("slide", f"{slide_id}: {row['status']} ({row['status_detail']})")
        tiles_p = self.paths.tiles(slide_id)
        if not tiles_p.exists():
            raise Unavailable("tiles", f"{tiles_p.name} missing for {slide_id}")
        tiles = pd.read_parquet(tiles_p)
        problems = []
        digest = sequence_digest(tiles["tile_id"])
        m = manif.get("tiles")
        if m and m["row_digest"] and m["row_digest"] != digest:
            raise Unavailable("tiles", "tile index does not match its manifest (re-export the slide)")
        scores = None
        sp = self.paths.scores(slide_id)
        if sp.exists():
            scores = pd.read_parquet(sp)
            if len(scores) != len(tiles) or not (scores["tile_id"].to_numpy() == tiles["tile_id"].to_numpy()).all():
                problems.append("scores are not aligned with the tile index; AI layers disabled")
                scores = None
        else:
            problems.append("no precomputed scores for this slide")
        grid = TileGrid(int(row["width"]), int(row["height"]), float(row["mpp"]), int(row["tile_w0"]))
        sd = SlideData(slide_id, row, grid, tiles, scores, problems)
        with self._lock:
            self._cache[slide_id] = sd
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return sd

    def embedding(self, sd: SlideData, model: str = PRIMARY_MODEL) -> np.ndarray:
        if sd._emb is None:
            p = self.paths.embedding(sd.slide_id, model)
            if not p.exists():
                raise Unavailable("embeddings", f"{p.name} not exported for {sd.slide_id}")
            try:
                sd._emb = read_matrix(p, sd.tiles["tile_id"])
            except AlignmentError as e:
                raise Unavailable("embeddings", str(e))
        return sd._emb

    def exemplars(self):
        if self._exemplars is None:
            from secondlook.pipeline.exemplars import ExemplarIndex

            idx = ExemplarIndex(self.paths.exemplar_dir, PRIMARY_MODEL)
            if not idx.available():
                raise Unavailable("exemplars", "no exemplar index in the bundle")
            self._exemplars = idx.load()
        return self._exemplars

    def similar(self, sd: SlideData, tile_index: int, k: int = 2) -> dict:
        try:
            ex = self.exemplars()
            vec = np.asarray(self.embedding(sd)[tile_index], dtype=np.float32)
            hits = ex.query(vec, exclude_slide=sd.slide_id, k=k)
            return {"available": True, **hits}
        except Unavailable as e:
            return {"available": False, "reason": e.reason, "tumor": [], "benign": []}

    # ------------------------------------------------------------------ deep zoom
    def image_path(self, slide_id: str) -> Path | None:
        """The whole-slide file on this machine. The stored path is where the slide was scored
        (often another machine), so when it is missing look for the same file name next to the
        bundle (`<data>/slides`), under SECONDLOOK_SLIDES, or in the raw CAMELYON16 folder."""
        con = self.con()
        row = db.one(con, "SELECT image_path FROM slides WHERE slide_id=?", slide_id)
        con.close()
        if not row or not row["image_path"]:
            return None
        stored = Path(row["image_path"])
        if stored.is_absolute() and stored.exists():
            return stored
        dirs = [Path(d).expanduser() for d in os.environ.get("SECONDLOOK_SLIDES", "").split(os.pathsep) if d]
        dirs += [self.paths.root.parent / "slides", DATA_ROOT / "slides", RAW_DIR / "camelyon16" / "images"]
        return next((d / stored.name for d in dirs if (d / stored.name).exists()), None)

    def deepzoom(self, slide_id: str):
        if slide_id in self._dz:
            return self._dz[slide_id]
        path = self.image_path(slide_id)
        if path is None:
            raise Unavailable("slide image", "whole-slide file is not on this machine (thumbnail only)")
        import openslide
        from openslide.deepzoom import DeepZoomGenerator

        dz = DeepZoomGenerator(openslide.OpenSlide(str(path)), tile_size=254, overlap=1, limit_bounds=False)
        self._dz[slide_id] = (dz, threading.Lock())
        return self._dz[slide_id]


_store: Store | None = None
_store_lock = threading.Lock()


def get_store() -> Store:
    global _store
    if _store is None:
        # the first requests arrive together: build (and migrate) the store once, not once per request
        with _store_lock:
            if _store is None:
                _store = Store()
    return _store


def set_store(store: Store) -> None:
    global _store
    _store = store
