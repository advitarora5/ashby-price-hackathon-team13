"""CAMELYON16: download from the AWS open-data bucket, parse expert XML annotations,
and rasterise them onto the tile grid.

Bucket layout (verified 2026-10-17): CAMELYON16/{images,annotations,masks}/,
CAMELYON16/evaluation/reference.csv, CAMELYON16/checksums.md5.
Annotation XML: ASAP format, coordinates in level-0 px. Groups "_0"/"_1" are
tumour, "_2" marks non-tumour holes inside tumour (exclusion).
"""
from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import requests

BUCKET = "https://camelyon-dataset.s3.amazonaws.com/CAMELYON16"


def _download(url: str, dest: Path, chunk: int = 1 << 22) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    have = tmp.stat().st_size if tmp.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with requests.get(url, stream=True, timeout=120, headers=headers) as r:
        if r.status_code == 404:
            raise FileNotFoundError(url)
        r.raise_for_status()
        mode = "ab" if have and r.status_code == 206 else "wb"
        with open(tmp, mode) as f:
            for block in r.iter_content(chunk):
                f.write(block)
    tmp.replace(dest)
    return dest


def checksums(root: Path) -> dict[str, str]:
    path = root / "checksums.md5"
    if not path.exists():
        _download(f"{BUCKET}/checksums.md5", path)
    out = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2:
            out[parts[1].lstrip("*./").replace("CAMELYON16/", "")] = parts[0]
    return out


def md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            h.update(block)
    return h.hexdigest()


def fetch_slide(name: str, root: Path, verify: bool = True) -> dict[str, Path | None]:
    """Download images/{name}.tif and annotations/{name}.xml (if it exists)."""
    root = Path(root)
    img = root / "images" / f"{name}.tif"
    if not img.exists():
        _download(f"{BUCKET}/images/{name}.tif", img)
    if verify:
        sums = checksums(root)
        key = next((k for k in sums if k.endswith(f"images/{name}.tif")), None)
        if key and md5(img) != sums[key]:
            img.unlink()
            raise IOError(f"checksum mismatch for {name}; deleted, re-run to retry")
    xml = root / "annotations" / f"{name}.xml"
    if not xml.exists():
        try:
            _download(f"{BUCKET}/annotations/{name}.xml", xml)
        except FileNotFoundError:
            xml = None
    return {"image": img, "xml": xml if xml and xml.exists() else None}


def fetch_reference(root: Path) -> Path:
    path = Path(root) / "evaluation" / "reference.csv"
    if not path.exists():
        _download(f"{BUCKET}/evaluation/reference.csv", path)
    return path


def parse_annotations(xml_path: Path) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Return (tumour polygons, exclusion polygons) as (N, 2) float arrays in level-0 px."""
    tree = ET.parse(xml_path)
    tumour, exclude = [], []
    for ann in tree.iter("Annotation"):
        group = ann.get("PartOfGroup", "")
        pts = [(float(c.get("X")), float(c.get("Y"))) for c in ann.iter("Coordinate")]
        if len(pts) < 3:
            continue
        poly = np.asarray(pts, dtype=np.float64)
        (exclude if group == "_2" or group.lower() == "exclusion" else tumour).append(poly)
    return tumour, exclude


def tile_overlap_fraction(xml_path: Path | None, grid, supersample: int = 8) -> np.ndarray:
    """Fraction of each tile's area inside the expert tumour mask, on the tile grid.

    Rasterises at `supersample` sub-pixels per tile side then area-averages, so
    the label threshold (config.TUMOR_LABEL_POS_OVERLAP) is applied to a real
    area fraction, not a centre-point test.
    """
    import cv2

    rows, cols = grid.shape
    if xml_path is None:
        return np.zeros((rows, cols), dtype=np.float32)
    tumour, exclude = parse_annotations(xml_path)
    scale = supersample / grid.tile_w0
    canvas = np.zeros((rows * supersample, cols * supersample), dtype=np.uint8)
    for poly in tumour:
        cv2.fillPoly(canvas, [np.round(poly * scale).astype(np.int32)], 1)
    for poly in exclude:
        cv2.fillPoly(canvas, [np.round(poly * scale).astype(np.int32)], 0)
    frac = canvas.reshape(rows, supersample, cols, supersample).mean(axis=(1, 3))
    return frac.astype(np.float32)


def slide_label_from_name(name: str, reference: dict[str, str] | None = None) -> str | None:
    if name.startswith("tumor_"):
        return "tumor"
    if name.startswith("normal_"):
        return "normal"
    if reference is not None:
        return reference.get(name)
    return None


def load_reference(path: Path) -> dict[str, str]:
    import pandas as pd

    """reference.csv on the AWS bucket: image,type,class,center (e.g. test_065.tif,tumor,micro,1)."""
    df = pd.read_csv(path)
    return {str(r.image).replace(".tif", ""): str(r.type).lower() for r in df.itertuples(index=False)}


def load_reference_size(path: Path) -> dict[str, str]:
    import pandas as pd

    df = pd.read_csv(path)
    return {str(r.image).replace(".tif", ""): str(r["class"]).lower() for _, r in df.iterrows()}


if __name__ == "__main__":
    import argparse

    from secondlook.config import RAW_DIR

    ap = argparse.ArgumentParser(description="Download CAMELYON16 slides + annotations")
    ap.add_argument("names", nargs="+", help="e.g. tumor_091 normal_108 test_084")
    ap.add_argument("--root", default=str(RAW_DIR / "camelyon16"))
    ap.add_argument("--no-verify", action="store_true")
    a = ap.parse_args()
    fetch_reference(Path(a.root))
    for n in a.names:
        got = fetch_slide(n, Path(a.root), verify=not a.no_verify)
        print(n, got["image"].stat().st_size, "xml" if got["xml"] else "no-xml", flush=True)
