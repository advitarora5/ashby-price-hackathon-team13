"""PathoGaze 1.0 (CC BY-SA 4.0, https://go.osu.edu/pathogaze) -> events parquet + reads.

Verified 2026-10-17 against the released files of experiment P10S60T600:
  ImageMapping.csv / ImageMetrics.csv  experimentImageName (C1..) -> CAMELYONImageName (test_001..)
  Metadata.csv      imageID, participantID, trialID, taskCompletionTime (ms), diagnosis
                    (Benign | Atypical | Neoplastic | Malignant), annotations (JSON), correct
  GazeOnlyData.csv  EyeMovementType (Fixation | Saccade), ImageFixationPointX/Y(px) (level-0 px),
                    EventEyesPositionZ(mm), Viewport*(px) in level-0 px, relativeTimestamp(ms),
                    GazeEventDuration(ms), outOfScreen, inImage, zoomScale (screen px per level-0 px)
  MouseOnlyData.csv viewport per mouse event (used for the viewport-only coverage variant)
Gaze and CAMELYON16 share level-0 pixel coordinates, so no transform is needed.
Column aliases from the paper text (e.g. ViewportAreaUpperLeftY) are accepted.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ALIASES = {
    "ViewportUpperLeftY(px)": ["ViewportAreaUpperLeftY(px)"],
    "EventEyesPositionZ(mm)": ["EyesPositionZ(mm)"],
    "imageID": ["experimentImageName"],
    "relativeTimestamp(ms)": ["relativeTimestamp(px)"],
}


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df:
        return df[name]
    for alt in ALIASES.get(name, []):
        if alt in df:
            return df[alt]
    raise KeyError(f"PathoGaze column {name!r} not found; have {list(df.columns)[:30]}")


def _bool(s: pd.Series) -> pd.Series:
    return s.astype(str).str.lower().isin(["true", "1"])


def read_id(participant: str, image_id: str) -> str:
    return f"pg_{participant}_{image_id}"


def load(root: Path, experiment: str = "P10S60T600"):
    root = Path(root)
    mapping = pd.read_csv(root / "ImageMapping.csv")
    metrics = pd.read_csv(root / "ImageMetrics.csv")
    exp = root / experiment
    meta = pd.read_csv(exp / "Metadata.csv")
    exp_csv = exp / "Experience.csv"
    experience = pd.read_csv(exp_csv) if exp_csv.exists() else pd.DataFrame(columns=["participantID", "experience"])
    to_c16 = dict(zip(mapping["experimentImageName"], mapping["CAMELYONImageName"]))

    reads = pd.DataFrame({
        "image_id": _col(meta, "imageID"),
        "reader_id": "pathogaze_" + meta["participantID"].astype(str),
        "participant": meta["participantID"].astype(str),
        "trial": meta["trialID"],
        "decision": meta["diagnosis"].astype(str),
        "seconds": meta["taskCompletionTime"].astype(float) / 1000.0,
        "correct": _bool(meta["correct"]),
    })
    reads["slide_id"] = reads["image_id"].map(to_c16)
    reads["read_id"] = [read_id(p, i) for p, i in zip(reads.participant, reads.image_id)]
    truth = metrics.set_index("CAMELYONImageName")
    reads["slide_truth"] = reads["slide_id"].map(truth["diagnosis"])
    reads["tumor_size"] = reads["slide_id"].map(truth["tumorSize"])

    events = []
    gaze = pd.read_csv(exp / "GazeOnlyData.csv", low_memory=False)
    fx = gaze[(gaze["EyeMovementType"] == "Fixation") & _bool(gaze["inImage"]) & ~_bool(gaze["outOfScreen"])]
    events.append(pd.DataFrame({
        "read_id": [read_id(p, i) for p, i in zip(fx["participantID"].astype(str), fx["experimentImageName"])],
        "t_ms": _col(fx, "relativeTimestamp(ms)").astype(float),
        "kind": "fixation",
        "x": fx["ImageFixationPointX(px)"].astype(float), "y": fx["ImageFixationPointY(px)"].astype(float),
        "w": np.nan, "h": np.nan,
        "zoom": fx["zoomScale"].astype(float),
        "duration_ms": fx["GazeEventDuration(ms)"].astype(float),
        "eye_mm": _col(fx, "EventEyesPositionZ(mm)").astype(float),
    }))
    mouse_path = exp / "MouseOnlyData.csv"
    if mouse_path.exists():
        mo = pd.read_csv(mouse_path, low_memory=False)
        mo = mo.dropna(subset=["ViewportUpperLeftX(px)", "zoomScale"])
        vp_cols = ["ViewportUpperLeftX(px)", "ViewportUpperLeftY(px)", "ViewportWidth(px)", "ViewportHeight(px)"]
        key = mo[["participantID", "experimentImageName"]].astype(str).agg("|".join, axis=1)
        changed = (mo[vp_cols].diff().abs().sum(axis=1) > 0) | (key != key.shift())
        mo = mo[changed]
        events.append(pd.DataFrame({
            "read_id": [read_id(p, i) for p, i in zip(mo["participantID"].astype(str), mo["experimentImageName"])],
            "t_ms": _col(mo, "relativeTimestamp(ms)").astype(float),
            "kind": "viewport",
            "x": mo[vp_cols[0]].astype(float), "y": mo[vp_cols[1]].astype(float),
            "w": mo[vp_cols[2]].astype(float), "h": mo[vp_cols[3]].astype(float),
            "zoom": mo["zoomScale"].astype(float), "duration_ms": np.nan, "eye_mm": np.nan,
        }))
    ev = pd.concat(events, ignore_index=True)
    ev = ev.sort_values(["read_id", "t_ms", "kind"], kind="stable").reset_index(drop=True)
    ev["seq"] = ev.groupby("read_id").cumcount().astype(np.int64)
    return reads, ev, experience


def is_benign_call(decision: str) -> bool:
    return str(decision).strip().lower() == "benign"


def ingest(root: Path, paths, slides_in_db: set[str] | None = None) -> dict:
    from secondlook.store import db
    from secondlook.store.arrays import write_parquet

    reads, ev, experience = load(root)
    write_parquet(ev, paths.events("pathogaze"))
    con = db.init_db(paths.db)
    exp = dict(zip("pathogaze_" + experience["participantID"].astype(str), experience["experience"].astype(str)))
    db.insert_many(con, "readers", [{"reader_id": r, "dataset": "pathogaze", "experience_level": exp.get(r)}
                                    for r in sorted(reads.reader_id.unique())])
    keep = reads if slides_in_db is None else reads[reads.slide_id.isin(slides_in_db)]
    db.insert_many(con, "reads", [{
        "read_id": r.read_id, "slide_id": r.slide_id, "case_id": f"case_{r.slide_id}", "reader_id": r.reader_id,
        "source": "pathogaze", "review_mode": "unaided", "coverage_mode": "gaze",
        "initial_decision": r.decision, "final_decision": r.decision, "seconds": r.seconds} for r in keep.itertuples()])
    con.commit()
    con.close()
    return {"reads_total": len(reads), "reads_ingested": len(keep), "events": len(ev),
            "fixations": int((ev.kind == "fixation").sum()), "viewport_events": int((ev.kind == "viewport").sum())}
