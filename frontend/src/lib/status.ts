import type { LucideIcon } from 'lucide-react'
import {
  CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleMinus, ClipboardCheck, Gauge, ScanSearch, TriangleAlert,
  OctagonAlert, ShieldCheck,
} from 'lucide-react'
import type { CaseRow } from '../types'
import type { CaseActivity } from './activity'

/**
 * Central status vocabulary. Every status shows icon + text (never colour alone); tones map to
 * tokens in styles/tokens.css. Wording is deliberately plain and non-alarming.
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export interface StatusDef { label: string; tone: Tone; icon: LucideIcon; description: string }

export const REVIEW_STATUS: Record<string, StatusDef> = {
  unread: { label: 'Not started', tone: 'neutral', icon: CircleDashed, description: 'No read has been opened on this case yet.' },
  in_review: { label: 'Opened', tone: 'info', icon: CircleDot, description: 'A read has been opened; no research sign-out check yet.' },
  opened: { label: 'Opened', tone: 'info', icon: CircleDot, description: 'A read has been opened but no assessment is recorded yet.' },
  assessed: { label: 'Assessed', tone: 'info', icon: ClipboardCheck, description: 'An initial assessment is recorded; the research sign-out check has not been run.' },
  signed_out: { label: 'Completed', tone: 'success', icon: CircleCheck, description: 'A research sign-out check has been recorded. Not a clinical sign-out.' },
}

export const TIER: Record<string, StatusDef> = {
  slow: { label: 'Slow path', tone: 'accent', icon: ScanSearch,
    description: 'Ranked in the top group by the routing signal. Suggests a closer look; blind-first review applies.' },
  fast: { label: 'Fast path', tone: 'neutral', icon: Gauge,
    description: 'Below the routing cut-off. AI evidence is shown from the start.' },
  unavailable: { label: 'No tier', tone: 'neutral', icon: CircleMinus,
    description: 'No routing score is available for this case.' },
}

/** Sign-out light: thresholds come from thresholds.json (served by /api/health). */
export const LIGHT: Record<string, StatusDef> = {
  green: { label: 'No high-risk unviewed tissue', tone: 'success', icon: ShieldCheck, description: 'Unviewed tissue scores below the lower threshold.' },
  amber: { label: 'Unviewed tissue worth a look', tone: 'warning', icon: TriangleAlert, description: 'Some unviewed tissue scores between the thresholds.' },
  red: { label: 'Potentially important tissue not yet inspected', tone: 'danger', icon: OctagonAlert, description: 'Unviewed tissue scores above the upper threshold.' },
  unavailable: { label: 'Coverage check unavailable', tone: 'neutral', icon: CircleHelp, description: 'Not enough data to run the check.' },
  not_required: { label: 'Check not required', tone: 'neutral', icon: CircleMinus, description: 'Not a benign sign-out, so the unseen-tissue check is not required.' },
}

export const statusOf = (map: Record<string, StatusDef>, key: string | null | undefined): StatusDef =>
  (key && map[key]) || { label: key ? key.replace(/_/g, ' ') : 'Unknown', tone: 'neutral', icon: CircleHelp, description: '' }

/** Display status: refines the API's in_review using the audit log (opened vs assessment recorded). */
export function displayStatus(c: CaseRow, act?: CaseActivity): string {
  if (c.review_status !== 'in_review') return c.review_status
  if (!act) return 'in_review'
  return act.assessed ? 'assessed' : 'opened'
}

/** Open slow-path cases (high routing signal, not yet completed). Not a clinical urgency. */
export const needsAttention = (c: CaseRow) => c.tier === 'slow' && c.review_status !== 'signed_out'

/** Share of tiles flagged as artifact above which a case is called out. Matches the original queue. */
export const ARTIFACT_FLAG = 0.05

export const routingScore = (c: CaseRow) => (c.routing_signal === 'entropy' ? c.uncertainty_score : c.disagreement_score)
export const routingLabel = (signal: string | undefined) => (signal === 'entropy' ? 'Model uncertainty' : 'Model disagreement')

export type Segment = 'all' | 'attention' | 'in_review' | 'unread' | 'signed_out' | 'open'
export const SEGMENT_LABEL: Record<Segment, string> = {
  all: 'All', attention: 'Slow path · open', in_review: 'In progress', unread: 'Not started', signed_out: 'Completed', open: 'Open (not completed)',
}

export function matchesSegment(c: CaseRow, s: Segment) {
  if (s === 'all') return true
  if (s === 'attention') return needsAttention(c)
  if (s === 'open') return c.review_status !== 'signed_out'
  return c.review_status === s
}

/** Action wording: Open (new read), Resume (restores the latest read), Reopen (completed; starts a new read). */
export function actionLabel(c: CaseRow, current: boolean) {
  if (current) return 'Return'
  if (c.review_status === 'in_review') return 'Resume'
  if (c.review_status === 'signed_out') return 'Reopen'
  return 'Open'
}
