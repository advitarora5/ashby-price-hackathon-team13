"""Request / response schemas. Ground-truth fields (slide_label, hit_tumor, tumour
masks) never appear in review responses; they are only in /eval endpoints."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Light = Literal["green", "amber", "red", "unavailable", "not_required"]


class Unavail(BaseModel):
    available: Literal[False] = False
    reason: str


class CaseRow(BaseModel):
    case_id: str
    slide_id: str
    organ: str
    dataset: str
    disagreement_score: Optional[float]
    disagreement_source: Optional[str]
    uncertainty_score: Optional[float] = None
    routing_signal: str = "disagreement"
    tier: str
    tier_rule: Optional[str]
    artifact_share: Optional[float]
    review_status: str
    recorded_reads: int = 0


class CaseDetail(CaseRow):
    width: int
    height: int
    mpp: float
    tile_w0: int
    grid_rows: int
    grid_cols: int
    dzi_url: Optional[str]
    thumbnail_url: str
    layers: list[str]
    problems: list[str]
    requires_blind: bool


class Rect(BaseModel):
    x: int
    y: int
    w: int
    h: int


class JumpLink(Rect):
    tile_id: str
    value: float


class FeatureBar(BaseModel):
    id: str
    label: str
    value: Optional[float] = Field(None, description="calibrated 0..1, null when no calibrator")
    raw: Optional[float] = Field(None, description="text-prior score; not a probability")
    calibrated: bool
    badge: Optional[str] = None
    calibration_source: Optional[str] = None
    jump_links: list[JumpLink] = []


class Exemplar(BaseModel):
    exemplar_id: str
    slide_id: str
    label: str
    similarity: float
    image_url: str


class Exemplars(BaseModel):
    available: bool
    reason: Optional[str] = None
    tumor: list[Exemplar] = []
    benign: list[Exemplar] = []


class Evidence(BaseModel):
    hidden: bool = False
    hidden_reason: Optional[str] = None
    case_id: str
    tile_id: Optional[str] = None
    tile_rect: Optional[Rect] = None
    tumor_prob: Optional[float] = None
    tumor_prob_source: Optional[str] = None
    disagreement: Optional[float] = None
    artifacts: list[str] = []
    features: list[FeatureBar] = []
    exemplars: Optional[Exemplars] = None
    notes: list[str] = []


class RegionOut(Rect):
    region_id: str
    kind: str
    rank: int
    risk: Optional[float]
    disagreement: Optional[float]
    n_tiles: int
    peak_tile_id: Optional[str]
    source: Optional[str]
    exemplars: Optional[Exemplars] = None
    alert_id: Optional[str] = None
    alert_status: Optional[str] = None


class Regions(BaseModel):
    hidden: bool = False
    hidden_reason: Optional[str] = None
    kind: str
    regions: list[RegionOut] = []


class ReadCreate(BaseModel):
    case_id: str
    reader_id: str = "live_reader"
    blind_all: bool = False
    coverage_mode: Literal["viewport", "gaze"] = "viewport"
    session_id: Optional[str] = None


class ReadOut(BaseModel):
    read_id: str
    case_id: str
    review_mode: Literal["aided", "blind"]
    coverage_mode: str
    tier: str
    initial_decision: Optional[str] = None
    final_decision: Optional[str] = None
    evidence_visible: bool
    source: str = "live"
    replay_of: Optional[str] = None


class ViewEvent(BaseModel):
    seq: int
    t_ms: float
    kind: Literal["viewport", "fixation"] = "viewport"
    x: float
    y: float
    w: Optional[float] = None
    h: Optional[float] = None
    zoom: float = Field(..., gt=0, description="screen px per level-0 px")
    duration_ms: Optional[float] = None
    eye_mm: Optional[float] = None


class EventsIn(BaseModel):
    events: list[ViewEvent]


class CoverageOut(BaseModel):
    read_id: str
    mode: str
    params: dict
    n_events: int
    tissue_tiles: int
    seen_tiles: int
    seen_share: float
    overlay_url: str
    revisited_alerts: list[str] = []


class DecisionIn(BaseModel):
    stage: Literal["initial", "final", "second_reader", "third_reader"]
    decision: Literal["benign", "suspicious", "malignant"]
    session_id: Optional[str] = None


class SignoutIn(BaseModel):
    decision: Literal["benign", "suspicious", "malignant"]
    session_id: Optional[str] = None
    max_regions: int = 2


class SignoutOut(BaseModel):
    read_id: str
    light: Light
    unseen_risk: Optional[float]
    unseen_tissue_share: Optional[float]
    thresholds: dict
    regions: list[RegionOut] = []
    reason: Optional[str] = None
    coverage_mode: str


class PolicyOut(BaseModel):
    read_id: str
    one_read_enough: bool
    suggestion: str
    reasons: list[str]
    checks: dict
    ai_flag_source: str
    disclaimer: str = "Experimental decision support. Not a diagnosis; the pathologist signs the report."


class AuditIn(BaseModel):
    action: str
    read_id: Optional[str] = None
    case_id: Optional[str] = None
    session_id: Optional[str] = None
    ai_visible: Optional[bool] = None
    detail: Optional[dict] = None


class ReplayStart(BaseModel):
    source_read_id: str
    coverage_mode: Literal["gaze", "viewport"] = "gaze"


class ReplayStep(BaseModel):
    replay_read_id: str
    cursor: int
    n_events: int
    done: bool
    t_ms: Optional[float]
    viewport: Optional[dict]
    last_fixation: Optional[dict]
    coverage: CoverageOut
    signout: Optional[SignoutOut] = None
    recorded_decision: Optional[str] = None
