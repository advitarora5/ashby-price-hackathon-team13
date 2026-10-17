"""Parquet / .npy stores with explicit row alignment.

Rule: an embedding matrix is only valid next to the tiles.parquet whose
`tile_id` order produced it. Every .npy is written with a sidecar
`<name>.meta.json` holding the row count and `sequence_digest` of tile ids;
loaders refuse to pair arrays whose digests differ.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.ids import sequence_digest


class AlignmentError(RuntimeError):
    pass


def write_parquet(df: pd.DataFrame, path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.parquet")
    df.to_parquet(tmp, index=False)
    tmp.replace(path)
    return path


def read_parquet(path: Path, columns: list[str] | None = None) -> pd.DataFrame:
    return pd.read_parquet(path, columns=columns)


def write_matrix(mat: np.ndarray, path: Path, row_ids, *, model: str, dtype=np.float16, extra: dict | None = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    row_ids = list(row_ids)
    if len(row_ids) != mat.shape[0]:
        raise AlignmentError(f"{len(row_ids)} ids for {mat.shape[0]} rows")
    np.save(path, mat.astype(dtype, copy=False))
    meta = {"n_rows": int(mat.shape[0]), "dim": int(mat.shape[1]) if mat.ndim > 1 else 1,
            "row_digest": sequence_digest(row_ids), "model": model, "dtype": np.dtype(dtype).name}
    meta.update(extra or {})
    path.with_suffix(".meta.json").write_text(json.dumps(meta, indent=1))
    return path


def read_meta(path: Path) -> dict:
    p = Path(path).with_suffix(".meta.json")
    if not p.exists():
        raise AlignmentError(f"{path} has no .meta.json; refusing to use unaligned rows")
    return json.loads(p.read_text())


def read_matrix(path: Path, expected_ids=None, mmap: bool = True) -> np.ndarray:
    meta = read_meta(path)
    mat = np.load(path, mmap_mode="r" if mmap else None)
    if mat.shape[0] != meta["n_rows"]:
        raise AlignmentError(f"{path}: file has {mat.shape[0]} rows, meta says {meta['n_rows']}")
    if expected_ids is not None:
        ids = list(expected_ids)
        if len(ids) != meta["n_rows"] or sequence_digest(ids) != meta["row_digest"]:
            raise AlignmentError(f"{path}: row order does not match the tile index")
    return mat
