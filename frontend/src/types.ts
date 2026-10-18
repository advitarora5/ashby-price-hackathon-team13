export type Tier = 'fast' | 'slow' | 'unavailable'
export type Decision = 'benign' | 'suspicious' | 'malignant'
export type Verdict = 'agree' | 'disagree' | 'unsure'
export type Light = 'green' | 'amber' | 'red' | 'unavailable' | 'not_required'

export interface CaseRow {
  case_id: string
  slide_id: string
  organ: string
  dataset: string
  disagreement_score: number | null
  disagreement_source: string | null
  uncertainty_score: number | null
  routing_signal: 'disagreement' | 'entropy'
  tier: Tier
  tier_rule: string | null
  artifact_share: number | null
  tissue_artifact_share: number | null
  tier_reasons: string[]
  review_status: string
  recorded_reads: number
}

export interface CaseDetail extends CaseRow {
  width: number
  height: number
  mpp: number
  tile_w0: number
  grid_rows: number
  grid_cols: number
  dzi_url: string | null
  thumbnail_url: string
  layers: string[]
  problems: string[]
  requires_blind: boolean
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface JumpLink extends Rect { tile_id: string; value: number }

export interface FeatureBar {
  id: string
  label: string
  value: number | null
  raw: number | null
  calibrated: boolean
  badge: string | null
  calibration_source: string | null
  jump_links: JumpLink[]
}

export interface Exemplar { exemplar_id: string; slide_id: string; label: string; similarity: number; image_url: string }
export interface Exemplars { available: boolean; reason?: string | null; tumor: Exemplar[]; benign: Exemplar[] }

export interface Evidence {
  hidden: boolean
  hidden_reason: string | null
  case_id: string
  tile_id: string | null
  tile_rect: Rect | null
  tumor_prob: number | null
  tumor_prob_source: string | null
  disagreement: number | null
  artifacts: string[]
  features: FeatureBar[]
  exemplars: Exemplars | null
  notes: string[]
}

export interface Region extends Rect {
  region_id: string
  kind: string
  rank: number
  risk: number | null
  disagreement: number | null
  n_tiles: number
  peak_tile_id: string | null
  source: string | null
  exemplars?: Exemplars | null
  alert_id?: string | null
  alert_status?: string | null
}

export interface Regions { hidden: boolean; hidden_reason: string | null; kind: string; regions: Region[] }

export interface Read {
  read_id: string
  case_id: string
  review_mode: 'aided' | 'blind'
  coverage_mode: string
  tier: Tier
  initial_decision: Decision | null
  final_decision: Decision | null
  evidence_visible: boolean
  source: string
  replay_of: string | null
  notes: string | null
  notes_saved_at: string | null
  feature_reviews: FeatureReview[]
  signout_missing: string[]
  signed_out_at: string | null
  next_seq: number
  last_t_ms: number
  resumed: boolean
}

export interface NoteVersion {
  feature_id: string
  version: number
  verdict: Verdict | null
  text: string | null
  saved_at: string
}

export interface FeatureReview {
  feature_id: string
  verdict: Verdict
  note: string | null
}

export interface ViewEvent {
  seq: number
  t_ms: number
  kind: 'viewport'
  x: number
  y: number
  w: number
  h: number
  zoom: number
}

export interface Coverage {
  read_id: string
  mode: string
  params: { radius_deg: number; min_magnification: number; definition: string }
  n_events: number
  tissue_tiles: number
  seen_tiles: number
  seen_share: number
  overlay_url: string
  revisited_alerts: string[]
}

export interface Signout {
  read_id: string
  light: Light
  unseen_risk: number | null
  unseen_tissue_share: number | null
  thresholds: { lo?: number; hi?: number; source?: string }
  regions: Region[]
  reason: string | null
  coverage_mode: string
}

export interface PolicyRec {
  read_id: string
  one_read_enough: boolean
  suggestion: 'one_read' | 'second_read' | 'third_read' | 'complete'
  reasons: string[]
  checks: Record<string, boolean | null>
  ai_flag_source: string
  disclaimer: string
}

export interface PolicyRun {
  run_id: string
  policy: string
  reads_per_100: number
  agreement: number
  kappa: number
  cancer_acc: number
  ci_low: number
  ci_high: number
  noninferior: number | null
  provenance: string
  n_cases: number
}

export interface PolicySummary {
  available: boolean
  reason?: string
  runs: PolicyRun[]
  dataset?: string
  n_patches?: number
  n_slides?: number
  ai_source?: string
  noninferiority_margin?: number
  per_resident?: { resident: number; agreement: number }[]
}

export interface RecordedRead {
  read_id: string
  case_id: string
  reader_id: string
  decision: string
  seconds: number
  experience_level: string | null
}

export interface ReplayStep {
  replay_read_id: string
  cursor: number
  n_events: number
  done: boolean
  t_ms: number | null
  viewport: (Rect & { zoom: number }) | null
  last_fixation: { x: number; y: number; zoom: number } | null
  coverage: Coverage
  signout: Signout | null
  recorded_decision: string | null
}
