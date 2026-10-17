"""Stable identifiers. Every store keys on these; nothing keys on row order."""
from __future__ import annotations

import hashlib
import uuid

import numpy as np


def tile_id(slide_id: str, row: int, col: int) -> str:
    return f"{slide_id}:r{int(row)}c{int(col)}"


def parse_tile_id(tid: str) -> tuple[str, int, int]:
    slide_id, rc = tid.rsplit(":", 1)
    r, c = rc[1:].split("c")
    return slide_id, int(r), int(c)


def region_id(slide_id: str, kind: str, rank: int, read_id: str | None = None) -> str:
    base = f"{slide_id}:{kind}:{rank}"
    return f"{base}:{read_id}" if read_id else base


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def sequence_digest(ids) -> str:
    """Digest of an ordered id sequence; stored in manifests to prove row alignment."""
    h = hashlib.sha1()
    for i in ids:
        h.update(str(i).encode())
        h.update(b"\x00")
    return h.hexdigest()[:16]


def patch_slide_id(patch_name: str) -> str:
    """CrowdGleason patch 'CasoHEProstata_A_0001_row_12288_column_51200' -> WSI id."""
    return patch_name.split("_row_")[0]


def stable_fold(key: str, n_folds: int, salt: str = "secondlook") -> int:
    d = hashlib.sha1(f"{salt}:{key}".encode()).digest()
    return int.from_bytes(d[:4], "little") % n_folds


def as_str_array(x) -> np.ndarray:
    return np.asarray([str(v) for v in x], dtype=object)
