import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react'
import {
  ArrowRight, ChevronLeft, ChevronRight, Eye, EyeOff, History, Info, ListChecks, Lock, Microscope, TriangleAlert, X,
} from 'lucide-react'
import { api, ApiError } from '../api'
import CaseQueue from '../components/review/CaseQueue'
import EvidenceTab from '../components/review/EvidenceTab'
import UnseenTab from '../components/review/UnseenTab'
import ModelTab from '../components/review/ModelTab'
import DecisionTab from '../components/review/DecisionTab'
import DecisionBar from '../components/review/DecisionBar'
import NotesSection, { NOTES_ID } from '../components/review/NotesSection'
import ReplayPanel from '../components/review/ReplayPanel'
import ContextPanel from '../components/ContextPanel'
import ClefPanel from '../components/ClefPanel'
import SearchPanel from '../components/SearchPanel'
import ReviewToolbar, { type LayerKey, type Layers } from '../components/review/ReviewToolbar'
import ShortcutHelp from '../components/review/ShortcutHelp'
import SlideViewer, { type LayerSpec, type ViewerControls, type ViewerStatus, type ViewportReport } from '../components/review/SlideViewer'
import StatusBadge from '../components/ui/StatusBadge'
import Tabs from '../components/ui/Tabs'
import InfoTip from '../components/ui/InfoTip'
import { ButtonLink } from '../components/ui/Button'
import EmptyState from '../components/ui/EmptyState'
import { href } from '../lib/router'
import { absoluteTime, pct, score, tissueLabel } from '../lib/format'
import { deriveActivity } from '../lib/activity'
import { useRecolouredCoverage } from '../lib/coverageOverlay'
import { disagreementEval } from '../lib/research'
import type { WorkflowState } from '../lib/workflow'
import { routingScore } from '../lib/status'
import type {
  AuditEvent, CaseDetail, CaseRow, Coverage, Decision, EvalDoc, Evidence, Light, PolicyRec, Read, Rect, Region,
  ReplayStep, Signout, Verdict, ViewEvent,
} from '../types'

const DEFAULT_LAYERS: Layers = { risk: true, disagreement: false, artifact: false, coverage: false, regions: true }
type TabId = 'evidence' | 'search' | 'layout' | 'unseen' | 'model' | 'decision'
const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

/** Everything needed to return to a case in this session without starting a new read. */
interface Snapshot {
  detail: CaseDetail; read: Read | null; ev: Evidence | null; evRegions: Region[]; disputed: Region[]
  coverage: Coverage | null; checks: Signout[]; rec: PolicyRec | null; layers: Layers
  seq: number; t0: number; liveCoverage: Coverage | null; readNote: string | null; priorExposure: string | null
  confirmed: boolean; extraReads: { stage: string; decision: Decision }[]; tab: TabId; readOnly: boolean
  notesDraft: string
}

interface Target { id: string; rect: Rect; label: string; what: string }

const store = {
  get(k: string) { try { return window.localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v) } catch { /* unavailable */ } },
}

/** Rebuild the sign-out check history of a read from the audit log + its alert regions (no API change). */
function checksFromAudit(events: AuditEvent[], readId: string, alertRegions: Region[], mode: string): Signout[] {
  return events.filter((e) => e.read_id === readId && e.action === 'signout_check').map((e) => {
    const d = (e.detail ?? {}) as { light?: Light; unseen_risk?: number | null; alerts?: string[] }
    const ids = new Set(d.alerts ?? [])
    return {
      read_id: readId, light: d.light ?? 'unavailable', unseen_risk: d.unseen_risk ?? null, unseen_tissue_share: null,
      thresholds: {}, regions: alertRegions.filter((r) => r.alert_id && ids.has(r.alert_id)), reason: null, coverage_mode: mode,
    }
  })
}

interface Props {
  caseId: string | null
  visible: boolean
  cases: CaseRow[]
  casesErr: string | null
  blindAll: boolean
  evalDocs: Record<string, EvalDoc> | null
  onCasesChanged: () => void
  onSelectCase: (id: string) => void
  focusMode: boolean
  onFocusMode: (on: boolean) => void
  onCaseListOpened: () => void
}

export default function SlideReviewPage({ caseId, visible, cases, casesErr, blindAll, evalDocs, onCasesChanged, onSelectCase, focusMode, onFocusMode, onCaseListOpened }: Props) {
  // ---- layout state (per viewer, persisted) ----
  const [navOpen, setNavOpen] = useState(() => (store.get('claripath.review.nav') ?? (window.innerWidth >= 1700 ? '1' : '0')) === '1')
  const [sideOpen, setSideOpen] = useState(() => store.get('claripath.review.side') !== '0')
  const [sideW, setSideW] = useState(() => Math.min(560, Math.max(300, Number(store.get('claripath.review.sideW')) || 380)))
  const [vw, setVw] = useState(() => window.innerWidth)
  const [navigatorOn, setNavigatorOn] = useState(() => window.innerWidth >= 1280 && window.innerHeight > 700)
  const [showHelp, setShowHelp] = useState(false)
  const [hintSeen, setHintSeen] = useState(() => store.get('claripath.review.hintSeen') === '1')
  useEffect(() => { store.set('claripath.review.nav', navOpen ? '1' : '0'); if (navOpen) onCaseListOpened() }, [navOpen, onCaseListOpened])
  useEffect(() => { store.set('claripath.review.side', sideOpen ? '1' : '0') }, [sideOpen])
  useEffect(() => { store.set('claripath.review.sideW', String(sideW)) }, [sideW])
  useEffect(() => { const on = () => setVw(window.innerWidth); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  // the slide gets priority on smaller screens: the panel never takes more than ~27% of the window
  const effSideW = Math.max(300, Math.min(sideW, Math.round(vw * 0.27)))

  // ---- read state ----
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CaseDetail | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [ev, setEv] = useState<Evidence | null>(null)
  const [evLoading, setEvLoading] = useState(false)
  const [evRegions, setEvRegions] = useState<Region[]>([])
  const [disputed, setDisputed] = useState<Region[]>([])
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [checks, setChecks] = useState<Signout[]>([])
  const [replaySignout, setReplaySignout] = useState<Signout | null>(null)
  const [rec, setRec] = useState<PolicyRec | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [extraReads, setExtraReads] = useState<{ stage: string; decision: Decision }[]>([])
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const [allHidden, setAllHidden] = useState(false)
  const [opacity, setOpacity] = useState(0.5)
  const [inspectDim, setInspectDim] = useState(false)
  const [tab, setTab] = useState<TabId>('evidence')
  const [focus, setFocus] = useState<{ rect: Rect; key: number } | null>(null)
  // tiles outlined by the Layout and Notes-check panels; a pending jump from "find similar arrangements"
  const [ctxBoxes, setCtxBoxes] = useState<{ rects: Rect[]; label: string } | null>(null)
  const pendingAt = useRef<{ caseId: string; tile: string; rect: Rect } | null>(null)
  // tissue search: the phrase (kept across cases, so a match in another case opens with it) and the spot in view
  const [searchQ, setSearchQ] = useState<string | null>(null)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchSpot, setSearchSpot] = useState<{ tile_id: string; rect: Rect; rank: number } | null>(null)
  const searchBox = useRef<HTMLInputElement | null>(null)
  const [activeTarget, setActiveTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readNote, setReadNote] = useState<string | null>(null)
  const [priorExposure, setPriorExposure] = useState<string | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'warn'; key: number } | null>(null)
  const [announce, setAnnounce] = useState('')
  const [busy, setBusy] = useState(false)
  const [zoomMag, setZoomMag] = useState<number | null>(null)
  const [vStatus, setVStatus] = useState<ViewerStatus>({ state: 'loading' })
  const [replay, setReplay] = useState<{ active: boolean; follow: (Rect & { key: number }) | null; fix: { x: number; y: number } | null }>({ active: false, follow: null, fix: null })
  const [notesDraft, setNotesDraft] = useState('')
  const draftRef = useRef('')
  draftRef.current = notesDraft
  const readOnlyRef = useRef(false)
  readOnlyRef.current = readOnly
  const controls = useRef<ViewerControls | null>(null)
  const liveCoverage = useRef<Coverage | null>(null)
  const queue = useRef<ViewEvent[]>([])
  const seq = useRef(0)
  const t0 = useRef(0)
  const readRef = useRef<Read | null>(null)
  readRef.current = read
  const replayActive = useRef(false)
  replayActive.current = replay.active
  const requested = useRef<string | null>(null)
  const sessions = useRef(new Map<string, Snapshot>())

  const showToast = useCallback((text: string, tone: 'info' | 'warn' = 'info') => setToast({ text, tone, key: Date.now() }), [])
  useEffect(() => {
    if (!toast || toast.tone === 'warn') return
    const t = window.setTimeout(() => setToast(null), 8000)
    return () => window.clearTimeout(t)
  }, [toast])

  const loadEvidence = useCallback(async (cid: string, r: Read | null, where?: { tile?: string; x?: number; y?: number }) => {
    setEvLoading(true)
    try {
      const e = await api.evidence(cid, { read_id: r?.read_id, ...where })
      if (requested.current !== cid) return
      setEv(e)
      if (!e.hidden && !where) {
        const [a, b] = await Promise.all([api.regions(cid, 'evidence', r?.read_id), api.regions(cid, 'disputed', r?.read_id)])
        setEvRegions(a.hidden ? [] : a.regions)
        setDisputed(b.hidden ? [] : b.regions)
      }
      if (e.hidden) { setEvRegions([]); setDisputed([]) }
    } catch (err) {
      setError((err as Error).message)
    } finally { setEvLoading(false) }
  }, [])

  // viewport/attention events are batched and streamed every 1.5 s
  const flush = useCallback(async () => {
    const r = readRef.current
    if (!r || queue.current.length === 0) return
    const batch = queue.current.splice(0, queue.current.length)
    try {
      const c = await api.postEvents(r.read_id, batch)
      liveCoverage.current = c
      setCoverage((prev) => (replayActive.current ? prev : c))
      if (c.revisited_alerts.length) {
        const mark = (s: Signout) => ({ ...s, regions: s.regions.map((g) => (g.alert_id && c.revisited_alerts.includes(g.alert_id) ? { ...g, alert_status: 'revisited' } : g)) })
        setChecks((cs) => cs.map(mark))
      }
    } catch { queue.current.unshift(...batch) }
  }, [])

  useEffect(() => {
    const t = window.setInterval(flush, 1500)
    return () => window.clearInterval(t)
  }, [flush])

  /** Unsaved notes are saved (as a new version) when the reader switches case, reloads or closes the page. */
  const saveDraftOnLeave = useCallback(() => {
    const r = readRef.current
    const text = draftRef.current
    if (!r || r.source !== 'live' || readOnlyRef.current) return
    if (text.trim() && text !== (r.notes ?? '')) api.saveNotesOnLeave(r.read_id, text)
  }, [])
  useEffect(() => {
    window.addEventListener('pagehide', saveDraftOnLeave)
    return () => window.removeEventListener('pagehide', saveDraftOnLeave)
  }, [saveDraftOnLeave])

  // keep a live snapshot of the open case so switching cases never discards a read
  const snap = useRef<Snapshot | null>(null)
  snap.current = detail ? {
    detail, read, ev, evRegions, disputed, coverage, checks, rec, layers, confirmed, extraReads, tab, readOnly,
    seq: seq.current, t0: t0.current, liveCoverage: liveCoverage.current, readNote, priorExposure, notesDraft,
  } : null

  const resetFor = (id: string) => {
    setSelected(id); setDetail(null); setRead(null); setEv(null); setEvRegions([]); setDisputed([])
    setCoverage(null); setChecks([]); setRec(null); setLayers(DEFAULT_LAYERS); setReadNote(null); setPriorExposure(null)
    setConfirmed(false); setExtraReads([]); setTab('evidence'); setReadOnly(false); setNotesDraft('')
    liveCoverage.current = null
    seq.current = 0; t0.current = performance.now()
  }

  /** Continue a read's view-event numbering and clock after the events already stored for it. */
  const continueRead = (r: Read) => {
    seq.current = r.next_seq
    t0.current = performance.now() - r.last_t_ms
    setNotesDraft(r.notes ?? '')
    // blind and still hidden: the reader's notes come first
    if (r.review_mode === 'blind' && !r.evidence_visible) setTab('decision')
  }

  /**
   * Open a read: by default the server resumes this reader's latest live read of the case; `fresh` starts a
   * separate one. A new blind read flags (and audits) any earlier AI exposure.
   */
  const startRead = useCallback(async (id: string, aiSeenAt: string | null, prevAt: string | null, fresh = false) => {
    const r = await api.createRead(id, blindAll, !fresh)
    if (requested.current !== id) return null
    continueRead(r)
    setRead(r)
    if (r.resumed) {
      const msg = `Resumed your earlier read of this case${r.initial_decision ? ` (your call: ${r.initial_decision})` : ''}.`
      setReadNote(msg); showToast(msg)
      api.coverage(r.read_id).then((c) => { if (requested.current === id) { liveCoverage.current = c; setCoverage(c) } }).catch(() => undefined)
      if (r.initial_decision) api.policy(r.read_id).then((p) => { if (requested.current === id) setRec(p) }).catch(() => undefined)
    } else if (r.review_mode === 'blind' && aiSeenAt) {
      const msg = `AI evidence for this case was shown in an earlier read (${absoluteTime(aiSeenAt)}). This read is logged as blind-first, but your call may not be independent; this is noted in the audit log.`
      setPriorExposure(msg); setReadNote(msg); showToast(msg, 'warn')
      api.audit('note', { read_id: r.read_id, case_id: id, detail: { prior_ai_exposure: true, ai_seen_at: aiSeenAt } })
    } else if (prevAt) {
      setReadNote(`New read started. A previous read of this case exists (${absoluteTime(prevAt)}).`)
    }
    await loadEvidence(id, r)
    return r
  }, [blindAll, loadEvidence, showToast])

  const openCase = useCallback(async (id: string) => {
    await flush()
    saveDraftOnLeave()
    if (snap.current) sessions.current.set(snap.current.detail.case_id, snap.current)
    setActiveTarget(null); setFocus(null); setError(null); setZoomMag(null); setAllHidden(false); setInspectDim(false); setCtxBoxes(null)
    setReplay({ active: false, follow: null, fix: null }); setReplaySignout(null); setToast(null)
    queue.current = []
    const saved = sessions.current.get(id)
    if (saved) {
      setSelected(id); setDetail(saved.detail); setRead(saved.read); setEv(saved.ev); setEvRegions(saved.evRegions)
      setDisputed(saved.disputed); setCoverage(saved.coverage); setChecks(saved.checks); setRec(saved.rec)
      setLayers(saved.layers); setReadNote(saved.readNote); setPriorExposure(saved.priorExposure); setConfirmed(saved.confirmed)
      setExtraReads(saved.extraReads); setTab(saved.tab); setReadOnly(saved.readOnly); setNotesDraft(saved.notesDraft)
      seq.current = saved.seq; t0.current = saved.t0; liveCoverage.current = saved.liveCoverage
      // notes may have been saved on leaving: refresh what the server holds for this read
      if (saved.read?.source === 'live' && !saved.readOnly) {
        api.read(saved.read.read_id).then((r) => { if (requested.current === id) setRead(r) }).catch(() => undefined)
      }
      return
    }
    resetFor(id)
    try {
      const [d, events] = await Promise.all([api.case(id), api.caseAudit(id).catch(() => [] as AuditEvent[])])
      if (requested.current !== id) return
      setDetail(d)
      const act = deriveActivity(events)[id]
      let prev: Read | null = null
      if (act?.lastReadId && d.review_status !== 'unread') {
        try { const r = await api.read(act.lastReadId); if (r.source === 'live' && r.case_id === id) prev = r } catch { /* not restorable */ }
      }
      if (prev && d.review_status === 'in_review') {
        // another session or a reload: resume the latest read of a case still in progress
        const cov = await api.coverage(prev.read_id).catch(() => null)
        if (requested.current !== id) return
        continueRead(prev)
        setRead(prev); setCoverage(cov); liveCoverage.current = cov
        const msg = `Resumed the read opened ${act?.lastReadOpenedAt ? absoluteTime(act.lastReadOpenedAt) : 'earlier'}${prev.initial_decision ? ` (your call: ${prev.initial_decision})` : ''}.`
        setReadNote(msg); showToast(msg)
        await loadEvidence(id, prev)
        if (prev.initial_decision) setRec(await api.policy(prev.read_id).catch(() => null))
      } else if (prev && d.review_status === 'signed_out') {
        // completed: show the recorded outcome read-only; a new read is an explicit choice
        const [cov, unseen] = await Promise.all([api.coverage(prev.read_id).catch(() => null), api.regions(id, 'unseen', prev.read_id).catch(() => null)])
        if (requested.current !== id) return
        setRead(prev); setCoverage(cov); liveCoverage.current = cov; setReadOnly(true); setConfirmed(!!prev.final_decision); setNotesDraft(prev.notes ?? '')
        setChecks(checksFromAudit(events, prev.read_id, unseen?.regions ?? [], cov?.mode ?? 'viewport'))
        const msg = `Completed case: showing the recorded read from ${act?.lastReadOpenedAt ? absoluteTime(act.lastReadOpenedAt) : 'earlier'} (read-only).`
        setReadNote(msg); showToast(msg)
        await loadEvidence(id, prev)
        if (prev.initial_decision || prev.final_decision) setRec(await api.policy(prev.read_id).catch(() => null))
        setTab('decision')
      } else {
        await startRead(id, act?.aiSeenAt ?? null, act?.lastReadOpenedAt ?? null)
      }
      onCasesChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [flush, loadEvidence, onCasesChanged, startRead, showToast, saveDraftOnLeave])

  const startNewRead = () => guard(async () => {
    if (!selected) return
    const events = await api.caseAudit(selected).catch(() => [] as AuditEvent[])
    const act = deriveActivity(events)[selected]
    resetFor(selected)
    setDetail(snap.current?.detail ?? (await api.case(selected)))
    await startRead(selected, act?.aiSeenAt ?? null, act?.lastReadOpenedAt ?? null, true)
    onCasesChanged()
  })

  const openNotes = useCallback(() => {
    setTab('decision'); setSideOpen(true)
    window.setTimeout(() => document.getElementById(NOTES_ID)?.focus(), 50)
  }, [])

  // route-driven: #/review/<id> opens that case once (guard survives StrictMode double effects)
  useEffect(() => {
    if (!caseId || requested.current === caseId) return
    requested.current = caseId
    openCase(caseId)
  }, [caseId, openCase])

  // open a matched case at the matching tile once its read is in place
  useEffect(() => {
    const at = pendingAt.current
    if (!at || !read || detail?.case_id !== at.caseId) return
    pendingAt.current = null
    if (at.tile) loadEvidence(at.caseId, read, { tile: at.tile }).then(() => setFocus({ rect: at.rect, key: Date.now() }))
    else setFocus({ rect: at.rect, key: Date.now() })
  }, [read, detail, loadEvidence])

  const onViewport = useCallback((v: ViewportReport) => {
    if (detail) setZoomMag((10 * v.zoom) / detail.mpp)
    if (!readRef.current || replayActive.current || readOnly) return
    queue.current.push({ seq: seq.current++, t_ms: performance.now() - t0.current, kind: 'viewport', ...v })
  }, [detail, readOnly])

  const jump = useCallback((r: Rect, what: string) => {
    setFocus({ rect: r, key: Date.now() })
    setInspectDim(true) // let the morphology, not the colour, be judged
    const id = what.includes(':') ? what.slice(what.indexOf(':') + 1) : what
    setActiveTarget(id)
    const action = what.startsWith('alert') ? 'alert_clicked' : what.startsWith('jump') ? 'jump_link_clicked' : 'region_clicked'
    if (selected) api.audit(action, { read_id: read?.read_id, case_id: selected, detail: { what, rect: r } })
  }, [read, selected])

  const onClickPoint = useCallback((x: number, y: number) => {
    if (!selected || ev?.hidden) return
    loadEvidence(selected, read, { x, y })
  }, [selected, read, ev, loadEvidence])

  const doSignout = async (r: Read, d: Decision) => {
    await flush()
    const s = await api.signout(r.read_id, d)
    setChecks((cs) => [...cs, s])
    setLayers((l) => ({ ...l, coverage: true }))
    setAllHidden(false)
    setCoverage(await api.coverage(r.read_id))
    setRec(await api.policy(r.read_id))
    api.read(r.read_id).then((x) => { if (readRef.current?.read_id === x.read_id) setRead(x) }).catch(() => undefined) // signed_out_at
    setTab(s.regions.length || d === 'benign' ? 'unseen' : 'decision'); setSideOpen(true)
    if (s.regions[0]) jump(s.regions[0], `alert:${s.regions[0].region_id}`)
    onCasesChanged()
  }

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  /** Save the typed notes when they differ from the server's copy (or were never saved). */
  const saveDraft = async (r: Read) => {
    const text = draftRef.current
    if (!text.trim() || (text === (r.notes ?? '') && r.notes_saved_at)) return r
    const out = await api.saveNotes(r.read_id, text)
    setRead(out)
    return out
  }

  const revealIfUnlocked = async (wasHidden: boolean | undefined, r: Read, what: string) => {
    if (!selected) return
    if (wasHidden && r.evidence_visible) {
      await loadEvidence(selected, r); setTab('evidence'); setSideOpen(true)
      setAnnounce(`${what} AI evidence is now shown in the Evidence tab.`)
      window.setTimeout(() => document.getElementById('rv-tab-evidence')?.focus(), 50)
    } else setAnnounce(what)
  }

  // blind read: the notes and the call together unlock the AI evidence, so recording the call saves the notes first
  const recordInitial = (d: Decision) => guard(async () => {
    if (!read || !selected) return
    const wasHidden = ev?.hidden
    const saved = await saveDraft(read)
    const r = await api.decision(saved.read_id, 'initial', d)
    setRead(r)
    await revealIfUnlocked(wasHidden, r, `Your call, ${d}, is recorded.`)
    setRec(await api.policy(r.read_id))
    onCasesChanged()
  })

  const saveNotes = () => guard(async () => {
    if (!read) return
    const wasHidden = ev?.hidden
    const r = await saveDraft(read)
    await revealIfUnlocked(wasHidden, r, 'Notes saved.')
    if (wasHidden && r.evidence_visible) setRec(await api.policy(r.read_id))
  })

  const reviewFeature = useCallback(async (feature: string, verdict: Verdict, note: string) => {
    const r = readRef.current
    if (!r) return
    try { setRead(await api.reviewFeature(r.read_id, feature, verdict, note)) } catch (e) { setError((e as Error).message) }
  }, [])

  const runCheck = () => guard(async () => {
    if (!read) return
    const r = await saveDraft(read)
    const d = r.final_decision ?? r.initial_decision
    if (d) await doSignout(r, d)
  })

  const recordFinal = (d: Decision) => guard(async () => {
    if (!read) return
    const r = await api.decision(read.read_id, 'final', d)
    setRead(r); setConfirmed(true)
    if (checks.length) await doSignout(r, d)
    else setRec(await api.policy(r.read_id))
    setTab('decision')
    setAnnounce(`Final call ${d} recorded.`)
  })

  const secondRead = async (stage: 'second_reader' | 'third_reader', d: Decision) => guard(async () => {
    if (!read) return
    await api.decision(read.read_id, stage, d)
    setExtraReads((x) => [...x.filter((y) => y.stage !== stage), { stage, decision: d }])
    setRec(await api.policy(read.read_id))
  })

  const onReplayStep = useCallback((s: ReplayStep) => {
    setCoverage(s.coverage)
    setReplay({ active: true, follow: s.viewport ? { ...s.viewport, key: s.cursor } : null,
      fix: s.last_fixation ? { x: s.last_fixation.x, y: s.last_fixation.y } : null })
    if (s.signout) {
      setReplaySignout(s.signout)
      if (s.signout.regions[0]) setActiveTarget(s.signout.regions[0].region_id)
    }
  }, [])
  const onReplayStart = useCallback(() => {
    setReplaySignout(null); setActiveTarget(null)
    setLayers((l) => ({ ...l, coverage: true }))
    setReplay({ active: true, follow: null, fix: null })
  }, [])
  const onReplayStop = useCallback(() => {
    setReplay({ active: false, follow: null, fix: null })
    setCoverage(liveCoverage.current); setReplaySignout(null)
  }, [])

  // ---- derived ----
  const evidenceVisible = !!ev && !ev.hidden
  const latestCheck = replay.active ? replaySignout : checks[checks.length - 1] ?? null
  /** Alerts persist once shown: a later re-check on a revised (positive) call doesn't erase them. */
  const alertCheck = useMemo(() => (replay.active ? replaySignout : [...checks].reverse().find((c) => c.regions.length > 0) ?? null), [replay.active, replaySignout, checks])
  const alerts = useMemo(() => alertCheck?.regions ?? [], [alertCheck])
  const unrevisited = alerts.filter((r) => r.alert_status !== 'revisited')
  const coverageUrl = useRecolouredCoverage(layers.coverage && !allHidden && coverage ? `${coverage.overlay_url}?v=${coverage.n_events}` : null)
  const heatOpacity = inspectDim ? 0.12 : opacity
  const layerSpecs = useMemo<LayerSpec[]>(() => {
    if (!detail || allHidden) return []
    const out: LayerSpec[] = []
    if (layers.artifact) out.push({ key: 'artifact', url: api.overlayUrl(detail.case_id, 'artifact'), opacity: inspectDim ? 0.3 : 0.8 })
    if (evidenceVisible && !replay.active && layers.risk && detail.layers.includes('risk'))
      out.push({ key: 'risk', url: api.overlayUrl(detail.case_id, 'risk', read?.read_id), opacity: heatOpacity })
    if (evidenceVisible && !replay.active && layers.disagreement && detail.layers.includes('disagreement'))
      out.push({ key: 'disagreement', url: api.overlayUrl(detail.case_id, 'disagreement', read?.read_id), opacity: Math.min(1, heatOpacity + 0.15) })
    if (layers.coverage && coverageUrl) out.push({ key: 'coverage', url: coverageUrl, opacity: inspectDim ? 0.35 : 1 })
    if (searchQ && evidenceVisible && !replay.active)
      out.push({ key: `search:${searchQ}`, url: `/api/cases/${detail.case_id}/search/overlay.png?q=${encodeURIComponent(searchQ)}${read ? `&read_id=${read.read_id}` : ''}`, opacity: inspectDim ? 0.3 : 0.7 })
    return out
  }, [detail, layers, evidenceVisible, read, coverageUrl, replay.active, heatOpacity, allHidden, inspectDim, searchQ])

  const boxes = useMemo(() => {
    const out: { region: Region; tone: 'evidence' | 'disputed' | 'unseen' | 'selected' | 'context' | 'search'; label: string }[] = []
    if (allHidden) return out
    const quiet = alerts.length > 0
    if (evidenceVisible && layers.regions && !replay.active) {
      evRegions.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'evidence', label: quiet ? '' : `#${r.rank} probe score ${score(r.risk)}` }))
      if (layers.disagreement) disputed.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'disputed', label: `#${r.rank} models disagree` }))
    }
    alerts.forEach((r) => out.push({ region: r, tone: 'unseen', label: r.alert_status === 'revisited' ? `Region ${r.rank} · revisited` : `Not yet viewed · ${r.rank}` }))
    if (searchSpot && searchQ && evidenceVisible && !replay.active)
      out.push({ region: { ...searchSpot.rect, region_id: 'search', kind: 'search', rank: searchSpot.rank, risk: null, disagreement: null, n_tiles: 1, peak_tile_id: null, source: null }, tone: 'search', label: `spot ${searchSpot.rank}` })
    if (ctxBoxes && evidenceVisible && !replay.active)
      ctxBoxes.rects.forEach((r, i) => out.push({ region: { ...r, region_id: `ctx${i}`, kind: 'context', rank: i, risk: null, disagreement: null, n_tiles: 1, peak_tile_id: null, source: null }, tone: 'context', label: i ? '' : ctxBoxes.label }))
    if (ev?.tile_rect && evidenceVisible && !replay.active)
      out.push({ region: { ...ev.tile_rect, region_id: 'tile', kind: 'tile', rank: 0, risk: null, disagreement: null, n_tiles: 1, peak_tile_id: null, source: null }, tone: 'selected', label: '' })
    return out
  }, [evRegions, disputed, alerts, ev, evidenceVisible, layers, replay.active, allHidden, ctxBoxes, searchSpot, searchQ])

  /** Highlighted regions to step through with J/K: unseen alerts first, then AI regions. */
  const targets = useMemo<Target[]>(() => {
    const t: Target[] = []
    alerts.forEach((r) => t.push({ id: r.region_id, rect: r, label: r.alert_status === 'revisited' ? `Region ${r.rank} (revisited)` : `Not yet viewed ${r.rank}`, what: `alert:${r.region_id}` }))
    if (evidenceVisible && !replay.active) {
      evRegions.slice(0, 5).forEach((r) => t.push({ id: r.region_id, rect: r, label: `AI region #${r.rank}`, what: `region:${r.region_id}` }))
      if (layers.disagreement) disputed.slice(0, 3).forEach((r) => t.push({ id: r.region_id, rect: r, label: `Disputed #${r.rank}`, what: `disputed:${r.region_id}` }))
    }
    return t
  }, [alerts, evRegions, disputed, evidenceVisible, replay.active, layers.disagreement])
  const targetIdx = targets.findIndex((t) => t.id === activeTarget)
  const stepTarget = useCallback((dir: 1 | -1) => {
    if (!targets.length) return
    const i = targetIdx < 0 ? (dir === 1 ? 0 : targets.length - 1) : (targetIdx + dir + targets.length) % targets.length
    jump(targets[i].rect, targets[i].what)
  }, [targets, targetIdx, jump])

  const wf: WorkflowState = { read, signout: latestCheck, rec, evidenceVisible, confirmed }
  const idx = cases.findIndex((c) => c.case_id === selected)
  const prevCase = idx > 0 ? cases[idx - 1] : null
  const nextCase = idx >= 0 && idx < cases.length - 1 ? cases[idx + 1] : null
  const nextOpen = cases.find((c, i) => i > idx && c.review_status !== 'signed_out') ?? null
  const fallbackNext = cases.find((c) => c.review_status === 'unread')
  const cohort = useMemo(() => {
    const r = [...cases].filter((c) => c.disagreement_score !== null).sort((a, b) => (b.disagreement_score ?? 0) - (a.disagreement_score ?? 0))
    const i = r.findIndex((c) => c.case_id === selected)
    return i >= 0 ? { rank: i + 1, of: r.length } : null
  }, [cases, selected])
  const routing = detail ? routingScore(detail) : null
  const evalResult = disagreementEval(evalDocs)
  const minMag = coverage?.params.min_magnification ?? 10
  const blindPending = !!read && read.review_mode === 'blind' && !read.evidence_visible
  const hasNotes = notesDraft.trim().length > 0
  // typed notes count: they are saved automatically before the check runs
  const checkTodo = read && !readOnly ? read.signout_missing.filter((m) => m !== 'assessment' && !(m === 'notes' && hasNotes)) : []

  const toggleLayer = useCallback((k: LayerKey, on: boolean) => {
    setLayers((l) => ({ ...l, [k]: on }))
    if (on) setAllHidden(false)
    setInspectDim(false)
    api.audit('layer_toggled', { read_id: readRef.current?.read_id, case_id: selected ?? undefined, detail: { layer: k, on } })
  }, [selected])
  const toggleAll = useCallback(() => {
    setInspectDim(false)
    setAllHidden((h) => {
      api.audit('layer_toggled', { read_id: readRef.current?.read_id, case_id: selected ?? undefined, detail: { layer: 'all', on: h } })
      return !h
    })
  }, [selected])
  const toggleNavigator = useCallback(() => setNavigatorOn((n) => { controls.current?.setNavigator(!n); return !n }), [])
  useEffect(() => { if (vStatus.state === 'ready') controls.current?.setNavigator(navigatorOn) }, [vStatus, navigatorOn])
  const openHelp = useCallback(() => { setShowHelp((s) => !s); setHintSeen(true); store.set('claripath.review.hintSeen', '1') }, [])

  // ---- keyboard shortcuts (never while typing, never with modifiers) ----
  useEffect(() => {
    if (!visible || !detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (t?.closest('[role="dialog"]') && e.key !== 'Escape') return
      const k = e.key
      const ai = (key: LayerKey) => { if (evidenceVisible) toggleLayer(key, !layers[key]) }
      const map: Record<string, () => void> = {
        j: () => stepTarget(1), k: () => stepTarget(-1),
        r: () => ai('risk'), g: () => ai('regions'), d: () => ai('disagreement'),
        c: () => toggleLayer('coverage', !layers.coverage), a: () => toggleLayer('artifact', !layers.artifact),
        h: toggleAll, n: toggleNavigator,
        '+': () => controls.current?.zoomBy(1.6), '=': () => controls.current?.zoomBy(1.6), '-': () => controls.current?.zoomBy(1 / 1.6),
        '0': () => { setInspectDim(false); controls.current?.home() },
        f: () => onFocusMode(!focusMode),
        '[': () => setNavOpen((o) => !o), ']': () => setSideOpen((o) => !o),
        '1': () => { setTab('evidence'); setSideOpen(true) }, '2': () => { setTab('unseen'); setSideOpen(true) },
        '3': () => { setTab('model'); setSideOpen(true) }, '4': () => { setTab('decision'); setSideOpen(true) },
        '?': openHelp,
        Escape: () => { if (showHelp) setShowHelp(false); else if (focusMode) onFocusMode(false) },
      }
      const fn = map[k] ?? map[k.toLowerCase()]
      if (!fn) return
      if (t?.closest('.osd') && /^[0+=-]$/.test(k)) return // OpenSeadragon handles these on the canvas
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, detail, evidenceVisible, layers, toggleLayer, toggleAll, toggleNavigator, stepTarget, focusMode, onFocusMode, showHelp, openHelp])

  const runSearch = useCallback((q: string) => {
    const v = q.trim()
    setSearchDraft(v); setSearchQ(v || null); setSearchSpot(null)
    if (v) { setTab('search'); setSideOpen(true) }
  }, [])
  // Cmd/Ctrl+F focuses the search box (separate listener: the shortcut map above ignores modifier keys)
  useEffect(() => {
    if (!visible || !detail) return
    const onFind = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && searchBox.current && !searchBox.current.disabled) {
        e.preventDefault(); searchBox.current.focus(); searchBox.current.select()
      }
    }
    window.addEventListener('keydown', onFind)
    return () => window.removeEventListener('keydown', onFind)
  }, [visible, detail])

  // ---- side panel resize (pointer drag, or arrow keys on the handle) ----
  const dragging = useRef<{ x: number; w: number } | null>(null)
  const onResizeDown = (e: RPointerEvent<HTMLDivElement>) => { dragging.current = { x: e.clientX, w: effSideW }; e.currentTarget.setPointerCapture(e.pointerId) }
  const onResizeMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    setSideW(Math.min(560, Math.max(300, dragging.current.w + (dragging.current.x - e.clientX))))
  }
  const onResizeKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSideW(Math.min(560, effSideW + 20)) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSideW(Math.max(300, effSideW - 20)) }
  }

  const showNav = navOpen && !focusMode
  const showSide = sideOpen && !focusMode

  const tabs = [
    { id: 'evidence', label: 'Evidence', icon: evidenceVisible ? undefined : <Lock size={12} aria-label="locked" /> },
    { id: 'search', label: 'Search', icon: evidenceVisible ? undefined : <Lock size={12} aria-label="locked" /> },
    { id: 'layout', label: 'Layout', icon: evidenceVisible ? undefined : <Lock size={12} aria-label="locked" /> },
    { id: 'unseen', label: 'Unseen', count: alertCheck ? unrevisited.length : undefined },
    { id: 'model', label: 'Models' },
    { id: 'decision', label: 'Decision' },
  ]

  // mode chip reflects what happened, not only what was planned
  const modeChip = !read ? null : read.review_mode === 'blind'
    ? (read.initial_decision
      ? <span className="badge tone-info" title="Your blind call was recorded before AI evidence was shown">
          <EyeOff size={13} aria-hidden />Blind call: {cap(read.initial_decision)}{read.final_decision && confirmed && read.final_decision !== read.initial_decision ? ` → ${cap(read.final_decision)}` : ''}
        </span>
      : <span className="badge tone-info" title="Your call is recorded before AI evidence is shown"><EyeOff size={13} aria-hidden />Blind-first</span>)
    : <span className="badge tone-neutral" title="AI evidence is shown from the start"><Eye size={13} aria-hidden />Evidence-first</span>

  const title = detail ? (
    <>
      <h1 className="mono">{detail.slide_id}</h1>
      <StatusBadge kind="tier" value={detail.tier} />
      {detail.tier_reasons.includes('artifacts') && (
        <span className="badge tone-warning" title={`Slow path because of damaged tissue: blur, ink or folds on ${pct(detail.tissue_artifact_share)} of the tissue`}>
          <TriangleAlert size={13} aria-hidden /><span className="tb-label">Damaged tissue</span>
        </span>
      )}
      {modeChip}
      {priorExposure && <span className="badge tone-warning" title={priorExposure}><TriangleAlert size={13} aria-hidden /><span className="tb-label">AI seen earlier</span></span>}
      {readOnly && <span className="badge tone-success" title="Completed case shown read-only">Completed · read-only</span>}
      {replay.active && <span className="badge tone-accent"><History size={13} aria-hidden /><span className="tb-label">Replay</span></span>}
      <InfoTip label="Case and read details">
        {tissueLabel(detail.organ)} · {detail.dataset.toUpperCase()}.{' '}
        {blindPending ? 'Model scores are hidden until your call.' : <>Model uncertainty (routing signal, normalised entropy 0–1): {score(routing)}.</>}{' '}
        Slide {detail.width.toLocaleString()} × {detail.height.toLocaleString()} px at {detail.mpp.toFixed(3)} µm/px.
        {readNote && <><br /><br />{readNote}</>}
      </InfoTip>
    </>
  ) : <h1>Slide Review</h1>

  return (
    <div className={`review ${showNav ? 'has-nav' : ''} ${showSide ? 'has-side' : ''}`} style={{ ['--side-w' as string]: `${effSideW}px` }}>
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
      {showNav && (
        <aside className="review-nav" aria-label="Case list">
          <CaseQueue cases={cases} selected={selected} onSelect={onSelectCase} error={casesErr} maskScoresFor={blindPending ? selected : null} />
        </aside>
      )}

      <section className="review-center" aria-label="Slide viewer">
        <ReviewToolbar title={title} navOpen={showNav} onToggleNav={() => setNavOpen(!navOpen)} sideOpen={showSide} onToggleSide={() => setSideOpen(!sideOpen)}
          focusMode={focusMode} onFocusMode={() => onFocusMode(!focusMode)} hasCase={!!detail}
          layers={layers} onToggleLayer={toggleLayer} allHidden={allHidden} onToggleAll={toggleAll} evidenceVisible={evidenceVisible && !replay.active}
          opacity={opacity} onOpacity={(v) => { setOpacity(v); setInspectDim(false) }}
          zoomMag={zoomMag} minMag={minMag} onZoom={(f) => controls.current?.zoomBy(f)} onHome={() => { setInspectDim(false); controls.current?.home() }}
          navigator={navigatorOn} onNavigator={toggleNavigator} onShortcuts={openHelp}
          search={
            <form className="tb-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch(searchDraft) }}>
              <input ref={searchBox} value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)}
                placeholder={evidenceVisible ? 'Search tissue…' : 'Search unlocks after your call'} disabled={!evidenceVisible || replay.active}
                aria-label="Search this slide for tissue described in words (Cmd or Ctrl+F)" title="Search this slide in words (⌘F)" />
              <kbd className="tb-search-k">⌘F</kbd>
            </form>
          }
          prevCase={prevCase ? { href: href({ page: 'review', caseId: prevCase.case_id }), label: prevCase.slide_id } : null}
          nextCase={nextCase ? { href: href({ page: 'review', caseId: nextCase.case_id }), label: nextCase.slide_id } : null} />

        {!detail ? (
          <div className="review-empty">
            {selected ? (
              error ? <EmptyState icon={TriangleAlert} tone="warning" title="This case could not be opened"
                action={<ButtonLink href={href({ page: 'cases' })} icon={ListChecks}>Back to cases</ButtonLink>}>{error}</EmptyState>
                : <EmptyState icon={Microscope} title="Loading slide…">Opening <span className="mono">{selected.replace('case_', '')}</span>.</EmptyState>
            ) : (
              <EmptyState icon={Microscope} title="No case open"
                action={<div className="btn-row">
                  {fallbackNext && <ButtonLink variant="primary" href={href({ page: 'review', caseId: fallbackNext.case_id })} iconRight={ArrowRight}>Open next priority case · {fallbackNext.slide_id}</ButtonLink>}
                  <ButtonLink href={href({ page: 'cases' })} icon={ListChecks}>Browse cases</ButtonLink>
                </div>}>
                Pick a case from the worklist. Your viewing is tracked to build the seen / unseen map.
              </EmptyState>
            )}
          </div>
        ) : (
          <>
            <div className="viewer-wrap">
              <SlideViewer detail={detail} layers={layerSpecs} boxes={boxes} focus={focus} follow={replay.follow} minMag={minMag}
                fixation={replay.fix} onViewport={onViewport} onClickPoint={onClickPoint} onStatus={setVStatus} controls={controls}
                onBoxClick={(r) => r.kind === 'unseen' ? jump(r, `alert:${r.region_id}`) : selected && loadEvidence(selected, read, { tile: r.peak_tile_id ?? undefined })} />
              {targets.length > 0 && (
                <div className="region-pill" role="group" aria-label="Highlighted regions">
                  <button type="button" className="pill-btn" aria-label="Previous highlighted region (K)" title="Previous (K)" onClick={() => stepTarget(-1)}><ChevronLeft size={14} aria-hidden /></button>
                  <span className="pill-text num" aria-live="polite">
                    {targetIdx >= 0 ? targets[targetIdx].label : 'Highlighted regions'} <span className="muted">{targetIdx >= 0 ? targetIdx + 1 : '–'}/{targets.length}</span>
                  </span>
                  <button type="button" className="pill-btn" aria-label="Next highlighted region (J)" title="Next (J)" onClick={() => stepTarget(1)}><ChevronRight size={14} aria-hidden /></button>
                  {inspectDim && <button type="button" className="pill-link" onClick={() => setInspectDim(false)} title="Overlays are dimmed so you can judge the tissue">Overlays dimmed · restore</button>}
                </div>
              )}
              {toast && (
                <div className={`toast ${toast.tone === 'warn' ? 'is-warn' : ''}`} role={toast.tone === 'warn' ? 'alert' : 'status'}>
                  {toast.tone === 'warn' ? <TriangleAlert size={14} aria-hidden /> : <Info size={14} aria-hidden />}
                  <span>{toast.text}</span>
                  <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => setToast(null)}><X size={14} aria-hidden /></button>
                </div>
              )}
              {error && <div className="viewer-status is-error" role="alert"><TriangleAlert size={14} aria-hidden /> {error}</div>}
              {detail.problems.length > 0 && <div className="viewer-status is-warn" role="status"><TriangleAlert size={14} aria-hidden /> {detail.problems[0]}</div>}
              {!detail.dzi_url && <div className="viewer-status" role="status"><Info size={14} aria-hidden /> Whole-slide file not on this machine: showing the thumbnail.</div>}
              {vStatus.state === 'loading' && <div className="viewer-status" role="status"><span className="spinner" aria-hidden /> Loading slide…</div>}
              {vStatus.state === 'error' && <div className="viewer-status is-error" role="alert"><TriangleAlert size={16} aria-hidden /> {vStatus.message}</div>}
              {vStatus.state === 'ready' && vStatus.tileErrors > 0 && (
                <div className="viewer-status is-warn" role="status"><TriangleAlert size={14} aria-hidden /> {vStatus.tileErrors} image tile{vStatus.tileErrors === 1 ? '' : 's'} failed to load; some areas may look blank.</div>
              )}
              {!allHidden && ((layers.coverage && coverage) || (evidenceVisible && layers.risk && !replay.active)) ? (
                <div className="legend" aria-label="Overlay legend">
                  {evidenceVisible && layers.risk && !replay.active && <span><span className="sw sw-risk" />Probe score</span>}
                  {layers.coverage && coverage && <span><span className="sw sw-cov" />Not yet viewed</span>}
                </div>
              ) : null}
              {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
              {!showHelp && !hintSeen && <button type="button" className="shortcut-hint xs" onClick={openHelp}>Press <kbd>?</kbd> for shortcuts</button>}
            </div>
            {!replay.active && read && (
              <DecisionBar wf={wf} read={read} busy={busy} readOnly={readOnly} unrevisited={unrevisited}
                onInitial={recordInitial} onRunCheck={runCheck} onFinal={recordFinal} onNewRead={startNewRead}
                onGoRegion={(r) => jump(r, `alert:${r.region_id}`)}
                nextHref={nextOpen ? href({ page: 'review', caseId: nextOpen.case_id }) : null}
                hasNotes={hasNotes} checkTodo={checkTodo} onOpenNotes={openNotes} />
            )}
          </>
        )}
      </section>

      {showSide && (
        <aside className="review-side" aria-label="AI evidence and review">
          <div className="resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize AI panel"
            aria-valuemin={300} aria-valuemax={560} aria-valuenow={effSideW} tabIndex={0}
            onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={() => { dragging.current = null }} onKeyDown={onResizeKey} />
          {detail ? (
            <>
              <Tabs tabs={tabs} value={tab} onChange={(t) => setTab(t as TabId)} label="AI evidence and review" idPrefix="rv" />
              <div className="side-body" role="tabpanel" id="rv-panel" aria-labelledby={`rv-tab-${tab}`} tabIndex={0}>
                {tab === 'evidence' && (
                  <EvidenceTab ev={ev} loading={evLoading} replaying={replay.active} evidenceRegions={evRegions} onJump={jump}
                    activeTarget={activeTarget} evalDocs={evalDocs}
                    reviews={read && read.source === 'live' && read.evidence_visible && !readOnly ? read.feature_reviews : null}
                    reviewKey={read?.read_id ?? ''} onReview={reviewFeature} onOpenNotes={openNotes} />
                )}
                {tab === 'search' && (
                  <SearchPanel caseId={detail.case_id} readId={read?.read_id} query={searchQ} hidden={!evidenceVisible || replay.active}
                    onSearch={runSearch}
                    onSpot={(s) => { setSearchSpot(s); if (s) setFocus({ rect: { x: s.rect.x - 4 * s.rect.w, y: s.rect.y - 4 * s.rect.h, w: 9 * s.rect.w, h: 9 * s.rect.h }, key: Date.now() }) }}
                    onOpenCase={(c, r) => {
                      pendingAt.current = { caseId: c, tile: '', rect: { x: r.x - 4 * r.w, y: r.y - 4 * r.h, w: 9 * r.w, h: 9 * r.h } }
                      onSelectCase(c)
                    }} />
                )}
                {tab === 'layout' && !evidenceVisible && (
                  <p className="small muted side-empty">The tissue layout is AI evidence: it unlocks once your blind call is recorded.</p>
                )}
                {tab === 'layout' && (
                  <ContextPanel caseId={detail.case_id} readId={read?.read_id} tileId={ev?.tile_id ?? null} hidden={!evidenceVisible || replay.active}
                    onShowTiles={(rects, label) => {
                      setCtxBoxes({ rects, label })
                      if (!rects.length) return
                      const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y))
                      setFocus({ rect: { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y }, key: Date.now() })
                    }}
                    onOpenMatch={(c, tile, r) => {
                      pendingAt.current = { caseId: c, tile, rect: { x: r.x - 6 * r.w, y: r.y - 6 * r.h, w: 13 * r.w, h: 13 * r.h } }
                      onSelectCase(c)
                    }} />
                )}
                {tab === 'unseen' && (
                  <UnseenTab coverage={coverage} latest={latestCheck} alertCheck={alertCheck} onJump={jump} activeAlert={activeTarget} zoomMag={zoomMag}
                    canRunCheck={!!read?.initial_decision && !busy && !replay.active && !readOnly} checkTodo={checkTodo} onRunCheck={runCheck} replayActive={replay.active}
                    finalDecision={confirmed ? read?.final_decision ?? null : null}
                    replay={<ReplayPanel caseId={detail.case_id} onStep={onReplayStep} onStart={onReplayStart} onStop={onReplayStop}
                      locked={!read || !read.initial_decision} />} />
                )}
                {tab === 'model' && (
                  <ModelTab detail={detail} ev={replay.active ? null : ev} disputed={disputed} cohortRank={cohort} evalResult={evalResult}
                    onJump={jump} disagreementLayer={layers.disagreement} onToggleLayer={(on) => toggleLayer('disagreement', on)} activeTarget={activeTarget} />
                )}
                {tab === 'decision' && (
                  <DecisionTab wf={wf} read={read} latest={latestCheck} alertCheck={alertCheck} rec={replay.active ? null : rec} tierSlow={detail.tier === 'slow'}
                    routingSignal={detail.routing_signal} extraReads={extraReads} onSecondRead={secondRead} confirmed={confirmed}
                    priorExposure={priorExposure} readOnly={readOnly}
                    notes={read && read.source === 'live' && !replay.active ? (
                      <NotesSection read={read} draft={notesDraft} onDraft={setNotesDraft} onSave={saveNotes} busy={busy}
                        readOnly={readOnly} evidenceHidden={!read.evidence_visible} />
                    ) : null} />
                )}
                {tab === 'decision' && !replay.active && (
                  <ClefPanel caseId={detail.case_id} read={read} regions={[...disputed, ...evRegions]} onJump={jump}
                    onShowTiles={(rects, label) => setCtxBoxes({ rects, label })} />
                )}
              </div>
            </>
          ) : <p className="small muted side-empty">Evidence, unseen areas, model comparison and the review decision appear here once a case is open.</p>}
        </aside>
      )}
    </div>
  )
}
