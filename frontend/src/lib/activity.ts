import type { AuditEvent } from '../types'

/** Per-case activity derived read-only from the existing audit log (GET /api/audit). */
export interface CaseActivity {
  /** Latest event bound to a read (opening, viewing, assessing). API calls without a read are ignored. */
  lastOpened: string | null
  /** An initial (blind or aided) assessment has been recorded on some live read. */
  assessed: boolean
  /** Most recently opened live read. */
  lastReadId: string | null
  lastReadOpenedAt: string | null
  /** AI evidence was shown on some earlier read of this case (aided read or unlocked after an assessment). */
  aiSeenAt: string | null
}

const ASSESS = new Set(['initial_assessment', 'blind_assessment'])
const AI_SHOWN = new Set(['evidence_shown', 'evidence_unlocked'])

export function deriveActivity(events: AuditEvent[]): Record<string, CaseActivity> {
  const out: Record<string, CaseActivity> = {}
  for (const e of events) {
    if (!e.case_id || !e.read_id || e.read_id.startsWith('replay_')) continue
    const a = (out[e.case_id] ??= { lastOpened: null, assessed: false, lastReadId: null, lastReadOpenedAt: null, aiSeenAt: null })
    if (!a.lastOpened || e.ts > a.lastOpened) a.lastOpened = e.ts
    if (ASSESS.has(e.action)) a.assessed = true
    if (e.action === 'case_opened' && (!a.lastReadOpenedAt || e.ts >= a.lastReadOpenedAt)) { a.lastReadId = e.read_id; a.lastReadOpenedAt = e.ts }
    if ((AI_SHOWN.has(e.action) || (e.action === 'case_opened' && e.ai_visible === 1)) && (!a.aiSeenAt || e.ts > a.aiSeenAt)) a.aiSeenAt = e.ts
  }
  return out
}
