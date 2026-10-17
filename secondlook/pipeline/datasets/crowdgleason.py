"""CrowdGleason (Zenodo 14178894): patches, 7 resident annotators, expert test labels.

Verified 2026-10-17 from Annotations.zip:
  train.csv / val.csv: marker1..marker7 (-1 = not annotated), 'Patch filename', MV, DS, GLAD, MACE
  test.csv:            marker1..marker7, 'Patch filename', 'ground truth' (expert)
  labels: 0 non-cancer, 1 G3, 2 G4, 3 G5
  test: 2926 patches from 232 WSI prefixes (paper says 262 WSIs); 2812 patches have all 7 residents.
Patch images (Patches.zip, 16 GB) are only needed for the prostate probe (Delta).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from secondlook.ids import patch_slide_id

MARKERS = [f"marker{i}" for i in range(1, 8)]


def load_split(root: Path, split: str) -> pd.DataFrame:
    df = pd.read_csv(Path(root) / f"{split}.csv")
    missing = [c for c in MARKERS + ["Patch filename"] if c not in df]
    if missing:
        raise KeyError(f"CrowdGleason {split}.csv missing columns {missing}")
    df = df.rename(columns={"Patch filename": "patch_id", "ground truth": "expert"})
    df["slide_id"] = df["patch_id"].map(patch_slide_id)
    df["split"] = split
    return df


def residents_matrix(test: pd.DataFrame, complete_only: bool = True):
    L = test[MARKERS].to_numpy()
    mask = (L >= 0).all(axis=1) if complete_only else np.ones(len(L), bool)
    return L[mask].astype(int), test["expert"].to_numpy()[mask].astype(int), test["slide_id"].to_numpy()[mask], \
        test["patch_id"].to_numpy()[mask]


def ingest_labels(root: Path, con) -> dict:
    from secondlook.store import db

    n = 0
    db.insert_many(con, "readers", [{"reader_id": f"crowdgleason_resident{i}", "dataset": "crowdgleason",
                                     "experience_level": "pathologist-in-training"} for i in range(1, 8)]
                   + [{"reader_id": "crowdgleason_expert", "dataset": "crowdgleason", "experience_level": "expert"}])
    for split in ("train", "val", "test"):
        df = load_split(root, split)
        db.insert_many(con, "patches", [{"patch_id": r.patch_id, "slide_id": r.slide_id, "dataset": "crowdgleason",
                                         "split": split, "image_path": None} for r in df.itertuples()])
        rows = []
        for r in df.itertuples():
            for i, m in enumerate(MARKERS, 1):
                v = getattr(r, m)
                if v >= 0:
                    rows.append({"patch_id": r.patch_id, "annotator": f"resident{i}", "label": int(v),
                                 "is_expert": 0, "is_aggregate": 0})
            if split == "test":
                rows.append({"patch_id": r.patch_id, "annotator": "expert", "label": int(r.expert),
                             "is_expert": 1, "is_aggregate": 0})
            else:
                for agg in ("MV", "DS", "GLAD", "MACE"):
                    rows.append({"patch_id": r.patch_id, "annotator": agg, "label": int(getattr(r, agg)),
                                 "is_expert": 0, "is_aggregate": 1})
        n += db.insert_many(con, "labels", rows)
    con.commit()
    return {"labels": n}
