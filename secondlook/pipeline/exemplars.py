"""Stage 7: similar labelled examples via FAISS.

Two flat inner-product indexes (tumour / benign) over labelled tiles from
*training* slides only. Retrieval always excludes the query slide, and the
index never contains held-out evaluation slides.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.store.arrays import read_matrix, read_parquet, write_matrix, write_parquet


class ExemplarIndex:
    def __init__(self, root: Path, model: str):
        self.root = Path(root)
        self.model = model
        self.meta: pd.DataFrame | None = None
        self.indexes: dict[str, object] = {}
        self.rows: dict[str, np.ndarray] = {}

    @property
    def meta_path(self) -> Path:
        return self.root / "exemplars.parquet"

    @property
    def emb_path(self) -> Path:
        return self.root / f"exemplar_emb_{self.model}.npy"

    def build(self, meta: pd.DataFrame, emb: np.ndarray) -> None:
        """meta columns: exemplar_id, tile_id, slide_id, label (tumor|benign), image (relative path)."""
        meta = meta.reset_index(drop=True)
        write_parquet(meta, self.meta_path)
        write_matrix(emb, self.emb_path, meta["exemplar_id"], model=self.model, dtype=np.float32)

    def available(self) -> bool:
        return self.meta_path.exists() and self.emb_path.exists()

    def load(self) -> "ExemplarIndex":
        import faiss

        self.meta = read_parquet(self.meta_path)
        emb = np.ascontiguousarray(read_matrix(self.emb_path, self.meta["exemplar_id"], mmap=False), dtype=np.float32)
        for lab in ("tumor", "benign"):
            rows = np.nonzero(self.meta["label"].to_numpy() == lab)[0]
            idx = faiss.IndexFlatIP(emb.shape[1])
            if len(rows):
                idx.add(emb[rows])
            self.indexes[lab] = idx
            self.rows[lab] = rows
        return self

    def query(self, vec: np.ndarray, exclude_slide: str, k: int = 2, overfetch: int = 32) -> dict[str, list[dict]]:
        if self.meta is None:
            self.load()
        q = np.ascontiguousarray(np.asarray(vec, dtype=np.float32).reshape(1, -1))
        q /= max(np.linalg.norm(q), 1e-6)
        out = {}
        for lab, idx in self.indexes.items():
            hits = []
            if idx.ntotal:
                sims, ids = idx.search(q, min(overfetch, idx.ntotal))
                for s, i in zip(sims[0], ids[0]):
                    if i < 0:
                        continue
                    row = self.meta.iloc[self.rows[lab][i]]
                    if row["slide_id"] == exclude_slide:
                        continue
                    hits.append({"exemplar_id": row["exemplar_id"], "slide_id": row["slide_id"],
                                 "label": lab, "similarity": round(float(s), 4), "image": row["image"]})
                    if len(hits) == k:
                        break
            out[lab] = hits
        return out
