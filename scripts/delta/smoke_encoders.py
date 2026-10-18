"""First-contact check for the CONCH and MUSK encoders (never run on a GPU before this).

    python scripts/delta/smoke_encoders.py                      # conch + musk, random tiles
    python scripts/delta/smoke_encoders.py --models conch       # one model
    python scripts/delta/smoke_encoders.py --tiles DIR          # also a tumour-vs-normal text check on real tiles

Pass criteria per model: it loads, image and text embeddings have the same width, every row is unit length
and finite. With --tiles, the tile closer to the text prompt for its own class should win most of the time.
Random-noise cosines mean nothing; they only have to be finite.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

EXPECT_DIM = {"conch": 512, "musk": 1024}
PROMPTS = ["an H&E image of metastatic tumor in a lymph node", "an H&E image of normal lymph node tissue"]


def load_tiles(folder: Path, n: int) -> np.ndarray:
    from PIL import Image

    files = sorted(p for p in folder.rglob("*") if p.suffix.lower() in {".tif", ".tiff", ".png", ".jpg", ".jpeg"})[:n]
    return np.stack([np.asarray(Image.open(f).convert("RGB").resize((224, 224))) for f in files]) if files else None


def check(name: str, tiles_dir: Path | None) -> bool:
    from secondlook.pipeline.embed import get_encoder

    rng = np.random.default_rng(0)
    t = time.time()
    enc = get_encoder(name)
    print(f"[{name}] loaded in {time.time() - t:.1f}s on {enc.device}", flush=True)
    noise = rng.integers(0, 256, (8, 224, 224, 3), dtype=np.uint8)
    x, y = enc.encode_images(noise), enc.encode_text(PROMPTS)
    ok = x.shape == (8, EXPECT_DIM[name]) and y.shape == (2, EXPECT_DIM[name])
    ok &= bool(np.isfinite(x).all() and np.isfinite(y).all())
    ok &= bool(np.allclose(np.linalg.norm(x, axis=1), 1, atol=1e-3) and np.allclose(np.linalg.norm(y, axis=1), 1, atol=1e-3))
    print(f"[{name}] img {x.shape} txt {y.shape} logit_scale {enc.logit_scale:.1f} "
          f"img norms {np.linalg.norm(x, axis=1).round(3)[:3]} txt norms {np.linalg.norm(y, axis=1).round(3)}", flush=True)
    print(f"[{name}] cos(txt0, txt1) = {float(y[0] @ y[1]):.3f}  (identical prompts' embeddings would be 1.0)", flush=True)
    ok &= float(y[0] @ y[1]) < 0.999
    big = rng.integers(0, 256, (256, 224, 224, 3), dtype=np.uint8)
    enc.encode_images(big[:32])
    t = time.time()
    enc.encode_images(big)
    print(f"[{name}] throughput {256 / (time.time() - t):.0f} tiles/s", flush=True)
    if tiles_dir is not None:
        tiles = load_tiles(tiles_dir, 16)
        if tiles is None:
            print(f"[{name}] no images found under {tiles_dir}")
        else:
            sims = enc.encode_images(tiles) @ y.T
            print(f"[{name}] real tiles: mean cos to 'tumor' {sims[:, 0].mean():.3f}, to 'normal' {sims[:, 1].mean():.3f}")
    print(f"[{name}] {'PASS' if ok else 'FAIL'}", flush=True)
    return bool(ok)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["conch", "musk"], choices=list(EXPECT_DIM))
    ap.add_argument("--tiles", type=Path, default=None)
    a = ap.parse_args()
    results = {}
    for m in a.models:
        try:
            results[m] = check(m, a.tiles)
        except Exception as e:  # report every model's failure, not just the first
            import traceback

            traceback.print_exc()
            results[m] = False
            print(f"[{m}] FAIL: {type(e).__name__}: {e}", flush=True)
    print("SUMMARY", results)
    raise SystemExit(0 if all(results.values()) else 1)
