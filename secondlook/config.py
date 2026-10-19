"""Paths and frozen constants shared by the pipeline, services and evaluation.

Everything that changes a result (tile size, thresholds, recipe versions) lives
here so the manifest can record it. Thresholds that are *learned* (sign-out
light cutoffs, tier cutoff) are not here: they come from bundle/thresholds.json,
written by evaluation code from validation data only.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env = REPO_ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

DATA_ROOT = Path(os.environ.get("SECONDLOOK_DATA", REPO_ROOT / "data")).expanduser()
RAW_DIR = DATA_ROOT / "raw"
BUNDLE_DIR = Path(os.environ.get("SECONDLOOK_BUNDLE", DATA_ROOT / "bundle")).expanduser()
WORK_DIR = DATA_ROOT / "work"  # embeddings and intermediate arrays that are not shipped to the laptop


def bundle_paths(bundle: Path | None = None) -> "BundlePaths":
    return BundlePaths(Path(bundle) if bundle else BUNDLE_DIR)


@dataclass(frozen=True)
class BundlePaths:
    root: Path

    @property
    def db(self) -> Path:
        return self.root / "secondlook.db"

    @property
    def manifest(self) -> Path:
        return self.root / "manifest.json"

    @property
    def thresholds(self) -> Path:
        return self.root / "thresholds.json"

    def slide_dir(self, slide_id: str) -> Path:
        return self.root / "slides" / slide_id

    def tiles(self, slide_id: str) -> Path:
        return self.slide_dir(slide_id) / "tiles.parquet"

    def scores(self, slide_id: str) -> Path:
        return self.slide_dir(slide_id) / "scores.parquet"

    def embedding(self, slide_id: str, model: str) -> Path:
        return self.slide_dir(slide_id) / f"emb_{model}.npy"

    def thumbnail(self, slide_id: str) -> Path:
        return self.slide_dir(slide_id) / "thumb.jpg"

    def dzi(self, slide_id: str) -> Path:
        return self.slide_dir(slide_id) / "dzi" / "slide.dzi"

    @property
    def exemplar_dir(self) -> Path:
        return self.root / "exemplars"

    @property
    def coverage_dir(self) -> Path:
        return self.root / "coverage"

    def coverage(self, read_id: str) -> Path:
        return self.coverage_dir / f"coverage_{read_id}.npy"

    @property
    def events_dir(self) -> Path:
        return self.root / "events"

    def events(self, dataset: str) -> Path:
        return self.events_dir / f"events_{dataset}.parquet"

    @property
    def eval_dir(self) -> Path:
        return self.root / "eval"

    @property
    def models_dir(self) -> Path:
        return self.root / "models"


# ---- Tiling -----------------------------------------------------------------
TILE_PX = 224
TARGET_MPP = 0.5          # micrometres per pixel of the extracted tile
COARSE_MPP = 1.0          # optional coarse mode (~4x fewer tiles)
MIN_TISSUE_FRACTION = 0.10
DEFAULT_MPP_IF_MISSING = None  # refuse to guess; slides without mpp are rejected

# ---- Artifact gate (rules) ----------------------------------------------------


@dataclass(frozen=True)
class ArtifactRules:
    blank_frac: float = 0.80        # share of near-white low-saturation pixels => mostly glass
    blur_laplacian_var: float = 60.0  # variance of Laplacian below this (on tissue) => out of focus
    ink_frac: float = 0.08          # share of pixels with ink-like hue/darkness
    fold_frac: float = 0.35         # share of dark, highly saturated pixels (heuristic, weak)
    version: str = "artifact_rules_v1"


ARTIFACT_RULES = ArtifactRules()

# ---- Models ------------------------------------------------------------------
# The two models compared for disagreement. Set both in .env to match the bundle being served
# (e.g. SECONDLOOK_PRIMARY_MODEL=conch, SECONDLOOK_SECONDARY_MODEL=musk).
PRIMARY_MODEL = os.environ.get("SECONDLOOK_PRIMARY_MODEL", "quiltnet")
SECONDARY_MODEL = os.environ.get("SECONDLOOK_SECONDARY_MODEL", "plip")
PATHOLOGY_MODELS = ("quiltnet", "plip", "pathgen", "conch", "musk")  # vision-language: also embed text
CONTROL_MODELS = ("imagenet", "colorhist")

# ---- Tumor regions -------------------------------------------------------------
TUMOR_LABEL_POS_OVERLAP = 0.50   # tile positive if >= 50% of its area is inside the expert mask
TUMOR_LABEL_NEG_OVERLAP = 0.0    # tile negative only if it does not touch the mask at all
REGION_RISK_THRESHOLD = 0.50     # smoothed tumor probability that seeds a region
SMOOTH_KERNEL = 3

# ---- Coverage ("seen") -----------------------------------------------------------


@dataclass(frozen=True)
class CoverageParams:
    mode: str = "gaze"              # "gaze" or "viewport" -- never mixed
    radius_deg: float = 5.0          # visual angle radius around a fixation
    min_magnification: float = 10.0  # objective-equivalent magnification (10x ~= 1.0 um/px on screen)
    eye_distance_mm: float = 650.0   # used when the eye tracker gives no distance
    screen_mm_per_px: float = 0.2331  # 27" 2560x1440 panel (PathoGaze setup); override per site
    viewport_max_dwell_ms: float = 5000.0  # cap dwell attributed to one viewport state
    recognition_ms: float = 300.0    # miss typology: looked < 300 ms => recognition miss

    def key(self) -> str:
        return f"{self.mode}_r{self.radius_deg:g}_m{self.min_magnification:g}"


DEFAULT_COVERAGE = CoverageParams()

# ---- Disagreement / routing -------------------------------------------------------
DISAGREEMENT_RECIPE = "disagreement_v1"  # frozen before evaluation; see pipeline/disagreement.py
CASE_SCORE_PERCENTILE = 90.0             # case score = 90th percentile of tile disagreement
SLOW_PATH_SHARE = 0.15                    # fallback when no validation-derived cutoff exists
ARTIFACT_SLOW_SHARE = 0.10                # blur/ink/fold on >= this share of tissue tiles -> slow path too

# ---- Policy -----------------------------------------------------------------------------
NONINFERIORITY_MARGIN = 0.02
BOOTSTRAP_REPS = 1000
RNG_SEED = 20261017

PROSTATE_CLASSES = ("non-cancer", "G3", "G4", "G5")
NCT_CLASSES = ("ADI", "BACK", "DEB", "LYM", "MUC", "MUS", "NORM", "STR", "TUM")
NCT_CLASS_NAMES = {
    "ADI": "adipose", "BACK": "background", "DEB": "debris", "LYM": "lymphocytes",
    "MUC": "mucus", "MUS": "smooth muscle", "NORM": "normal colon mucosa",
    "STR": "cancer-associated stroma", "TUM": "colorectal adenocarcinoma epithelium",
}
