import type {
  CaseDetail, CaseRow, Coverage, Decision, Evidence, PolicyRec, PolicySummary, Read, RecordedRead,
  Regions, ReplayStep, Signout, ViewEvent,
} from './types'

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : (detail as { reason?: string })?.reason ?? `HTTP ${status}`)
    this.status = status
    this.detail = detail
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let detail: unknown = res.statusText
    try { detail = (await res.json()).detail } catch { /* not json */ }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const q = (o: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams()
  Object.entries(o).forEach(([k, v]) => { if (v !== null && v !== undefined) s.set(k, String(v)) })
  const t = s.toString()
  return t ? `?${t}` : ''
}

export const SESSION_ID = `sess_${Math.random().toString(36).slice(2, 10)}`

export const api = {
  health: () => req<{ ok: boolean; cases: number; provenance: string; thresholds: Record<string, unknown> }>('/health'),
  cases: () => req<CaseRow[]>('/cases'),
  case: (id: string) => req<CaseDetail>(`/cases/${id}`),
  evidence: (caseId: string, p: { read_id?: string; tile?: string; x?: number; y?: number }) =>
    req<Evidence>(`/cases/${caseId}/evidence${q(p)}`),
  regions: (caseId: string, kind: string, read_id?: string) =>
    req<Regions>(`/cases/${caseId}/regions${q({ kind, read_id })}`),
  overlayUrl: (caseId: string, layer: string, read_id?: string, v = 0) =>
    `/api/cases/${caseId}/overlay/${layer}.png${q({ read_id, v })}`,
  createRead: (case_id: string, blind_all: boolean) =>
    post<Read>('/reads', { case_id, blind_all, coverage_mode: 'viewport', session_id: SESSION_ID }),
  read: (id: string) => req<Read>(`/reads/${id}`),
  postEvents: (id: string, events: ViewEvent[]) => post<Coverage>(`/reads/${id}/events`, { events }),
  coverage: (id: string) => req<Coverage>(`/reads/${id}/coverage`),
  decision: (id: string, stage: string, decision: Decision) =>
    post<Read>(`/reads/${id}/decision`, { stage, decision, session_id: SESSION_ID }),
  signout: (id: string, decision: Decision) =>
    post<Signout>(`/reads/${id}/signout`, { decision, session_id: SESSION_ID }),
  policy: (id: string) => req<PolicyRec>(`/reads/${id}/policy`),
  policySummary: () => req<PolicySummary>('/policy/summary'),
  audit: (action: string, p: { read_id?: string; case_id?: string; detail?: unknown; ai_visible?: boolean }) =>
    post('/audit', { action, session_id: SESSION_ID, ...p }).catch(() => undefined),
  recordedReads: (case_id: string) => req<RecordedRead[]>(`/replay/reads${q({ case_id })}`),
  replayStart: (source_read_id: string, coverage_mode: 'gaze' | 'viewport') =>
    post<{ replay_read_id: string; n_events: number; recorded_decision: string }>('/replay/start',
      { source_read_id, coverage_mode }),
  replayStep: (id: string, n: number) => post<ReplayStep>(`/replay/${id}/step${q({ n })}`),
  replayTally: () => req<Record<string, unknown>>('/replay/tally'),
  evalSummary: () => req<Record<string, unknown>>('/eval/summary'),
}
