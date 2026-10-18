import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react'
import {
  ArrowLeft, ArrowRight, Eye, EyeOff, FlaskConical, History, Info, ListChecks, Lock, Microscope,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, TriangleAlert,
} from 'lucide-react'
import { api, ApiError } from '../api'
import CaseQueue from '../components/review/CaseQueue'
import EvidenceTab from '../components/review/EvidenceTab'
import UnseenTab from '../components/review/UnseenTab'
import ModelTab from '../components/review/ModelTab'
import DecisionTab from '../components/review/DecisionTab'
import DecisionBar from '../components/review/DecisionBar'
import ReplayPanel from '../components/review/ReplayPanel'
import LayersBar, { ViewControls, type LayerKey, type Layers } from '../components/review/LayersBar'
import ShortcutHelp from '../components/review/ShortcutHelp'
import SlideViewer, { type LayerSpec, type ViewerControls, type ViewerStatus, type ViewportReport } from '../components/review/SlideViewer'
import StatusBadge from '../components/ui/StatusBadge'
import Tabs from '../components/ui/Tabs'
import { Button, ButtonLink } from '../components/ui/Button'
import EmptyState from '../components/ui/EmptyState'
import { href } from '../lib/router'
import { absoluteTime, score, tissueLabel } from '../lib/format'
import InfoTip from '../components/ui/InfoTip'
import { deriveActivity } from '../lib/activity'
import { useRecolouredCoverage } from '../lib/coverageOverlay'
import { disagreementEval } from '../lib/research'
import type { WorkflowState } from '../lib/workflow'
import { routingScore } from '../lib/status'
import type {
  CaseDetail, CaseRow, Coverage, Decision, EvalDoc, Evidence, PolicyRec, Read, Rect, Region,
  ReplayStep, Signout, ViewEvent,
} from '../types'

const DEFAULT_LAYERS: Layers = { risk: true, disagreement: false, artifact: false, coverage: false, regions: true }
type TabId = 'evidence' | 'unseen' | 'model' | 'decision'

/** Everything needed to return to a case in this session without starting a new read. */
interface Snapshot {
  detail: CaseDetail; read: Read | null; ev: Evidence | null; evRegions: Region[]; disputed: Region[]
  coverage: Coverage | null; signout: Signout | null; rec: PolicyRec | null; layers: Layers
  seq: number; t0: number; liveCoverage: Coverage | null; notice: string | null
  confirmed: boolean; extraReads: { stage: string; decision: Decision }[]; tab: TabId
}

interface Target { id: string; rect: Rect; label: string; what: string }

const store = {
  get(k: string) { try { return window.localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v) } catch { /* unavailable */ } },
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
}

export default function SlideReviewPage({ caseId, visible, cases, casesErr, blindAll, evalDocs, onCasesChanged, onSelectCase, focusMode, onFocusMode }: Props) {
  // ---- layout state (per viewer, persisted) ----
  const [navOpen, setNavOpen] = useState(() => (store.get('claripath.review.nav') ?? (window.innerWidth >= 1700 ? '1' : '0')) === '1')
  const [sideOpen, setSideOpen] = useState(() => store.get('claripath.review.side') !== '0')
  const [sideW, setSideW] = useState(() => Math.min(560, Math.max(300, Number(store.get('claripath.review.sideW')) || 380)))
  const [navigatorOn, setNavigatorOn] = useState(() => window.innerWidth >= 1280)
  const [showHelp, setShowHelp] = useState(false)
  useEffect(() => { store.set('claripath.review.nav', navOpen ? '1' : '0') }, [navOpen])
  useEffect(() => { store.set('claripath.review.side', sideOpen ? '1' : '0') }, [sideOpen])
  useEffect(() => { store.set('claripath.review.sideW', String(sideW)) }, [sideW])

  // ---- read state ----
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<CaseDetail | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [ev, setEv] = useState<Evidence | null>(null)
  const [evLoading, setEvLoading] = useState(false)
  const [evRegions, setEvRegions] = useState<Region[]>([])
  const [disputed, setDisputed] = useState<Region[]>([])
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [signout, setSignout] = useState<Signout | null>(null)
  const [rec, setRec] = useState<PolicyRec | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [extraReads, setExtraReads] = useState<{ stage: string; decision: Decision }[]>([])
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const [allHidden, setAllHidden] = useState(false)
  const [opacity, setOpacity] = useState(0.55)
  const [tab, setTab] = useState<TabId>('evidence')
  const [focus, setFocus] = useState<{ rect: Rect; key: number } | null>(null)
  const [activeTarget, setActiveTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [zoomMag, setZoomMag] = useState<number | null>(null)
  const [vStatus, setVStatus] = useState<ViewerStatus>({ state: 'loading' })
  const [replay, setReplay] = useState<{ active: boolean; follow: (Rect & { key: number }) | null; fix: { x: number; y: number } | null }>({ active: false, follow: null, fix: null })
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
        setSignout((s) => s && ({ ...s, regions: s.regions.map((g) => (g.alert_id && c.revisited_alerts.includes(g.alert_id) ? { ...g, alert_status: 'revisited' } : g)) }))
      }
    } catch { queue.current.unshift(...batch) }
  }, [])

  useEffect(() => {
    const t = window.setInterval(flush, 1500)
    return () => window.clearInterval(t)
  }, [flush])

  // keep a live snapshot of the open case so switching cases never discards a read
  const snap = useRef<Snapshot | null>(null)
  snap.current = detail ? {
    detail, read, ev, evRegions, disputed, coverage, signout, rec, layers, confirmed, extraReads, tab,
    seq: seq.current, t0: t0.current, liveCoverage: liveCoverage.current, notice,
  } : null

  const openCase = useCallback(async (id: string) => {
    await flush()
    if (snap.current) sessions.current.set(snap.current.detail.case_id, snap.current)
    setActiveTarget(null); setFocus(null); setError(null); setZoomMag(null); setAllHidden(false)
    setReplay({ active: false, follow: null, fix: null })
    queue.current = []
    const saved = sessions.current.get(id)
    if (saved) {
      setSelected(id); setDetail(saved.detail); setRead(saved.read); setEv(saved.ev); setEvRegions(saved.evRegions)
      setDisputed(saved.disputed); setCoverage(saved.coverage); setSignout(saved.signout); setRec(saved.rec)
      setLayers(saved.layers); setNotice(saved.notice); setConfirmed(saved.confirmed); setExtraReads(saved.extraReads); setTab(saved.tab)
      seq.current = saved.seq; t0.current = saved.t0; liveCoverage.current = saved.liveCoverage
      return
    }
    setSelected(id); setDetail(null); setRead(null); setEv(null); setEvRegions([]); setDisputed([])
    setCoverage(null); setSignout(null); setRec(null); setLayers(DEFAULT_LAYERS); setNotice(null)
    setConfirmed(false); setExtraReads([]); setTab('evidence')
    liveCoverage.current = null
    seq.current = 0; t0.current = performance.now()
    try {
      const [d, events] = await Promise.all([api.case(id), api.caseAudit(id).catch(() => [])])
      if (requested.current !== id) return
      setDetail(d)
      const act = deriveActivity(events)[id]
      // another session or a reload: resume the latest live read if the case is still in progress
      let r: Read | null = null
      if (d.review_status === 'in_review' && act?.lastReadId) {
        try {
          const prev = await api.read(act.lastReadId)
          if (prev.source === 'live' && prev.case_id === id) r = prev
        } catch { /* not restorable: fall through to a new read */ }
      }
      if (r) {
        const cov = await api.coverage(r.read_id).catch(() => null)
        if (requested.current !== id) return
        setRead(r); setCoverage(cov); liveCoverage.current = cov
        seq.current = (cov?.n_events ?? 0) + 1
        setNotice(`Resumed the most recent read of this case, opened ${act?.lastReadOpenedAt ? absoluteTime(act.lastReadOpenedAt) : 'earlier'}${r.initial_decision ? ` (your call: ${r.initial_decision})` : ''}.`)
        await loadEvidence(id, r)
        if (r.initial_decision) setRec(await api.policy(r.read_id).catch(() => null))
      } else {
        r = await api.createRead(id, blindAll)
        if (requested.current !== id) return
        setRead(r)
        if (r.review_mode === 'blind' && act?.aiSeenAt) {
          setNotice(`AI evidence for this case was shown in an earlier read (${absoluteTime(act.aiSeenAt)}). This read is logged as blind-first, but your assessment may not be independent; this has been noted in the audit log.`)
          api.audit('note', { read_id: r.read_id, case_id: id, detail: { prior_ai_exposure: true, ai_seen_at: act.aiSeenAt } })
        } else if (act?.lastReadId) {
          setNotice(`Started a new read. A previous read of this case exists (${act.lastReadOpenedAt ? absoluteTime(act.lastReadOpenedAt) : 'earlier'}).`)
        }
        await loadEvidence(id, r)
      }
      onCasesChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [blindAll, flush, loadEvidence, onCasesChanged])

  // route-driven: #/review/<id> opens that case once (guard survives StrictMode double effects)
  useEffect(() => {
    if (!caseId || requested.current === caseId) return
    requested.current = caseId
    openCase(caseId)
  }, [caseId, openCase])

  const onViewport = useCallback((v: ViewportReport) => {
    if (detail) setZoomMag((10 * v.zoom) / detail.mpp)
    if (!readRef.current || replayActive.current) return
    queue.current.push({ seq: seq.current++, t_ms: performance.now() - t0.current, kind: 'viewport', ...v })
  }, [detail])

  const jump = useCallback((r: Rect, what: string) => {
    setFocus({ rect: r, key: Date.now() })
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
    setSignout(s)
    setLayers((l) => ({ ...l, coverage: true }))
    setAllHidden(false)
    setCoverage(await api.coverage(r.read_id))
    setRec(await api.policy(r.read_id))
    setTab('unseen'); setSideOpen(true)
    if (s.regions[0]) jump(s.regions[0], `alert:${s.regions[0].region_id}`)
    onCasesChanged()
  }

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const recordInitial = (d: Decision) => guard(async () => {
    if (!read || !selected) return
    const wasHidden = ev?.hidden
    const r = await api.decision(read.read_id, 'initial', d)
    setRead(r)
    if (wasHidden && r.evidence_visible) { await loadEvidence(selected, r); setTab('evidence'); setSideOpen(true) }
    setRec(await api.policy(r.read_id))
    onCasesChanged()
  })

  const runCheck = () => guard(async () => {
    if (!read) return
    const d = read.final_decision ?? read.initial_decision
    if (d) await doSignout(read, d)
  })

  const recordFinal = (d: Decision) => guard(async () => {
    if (!read) return
    const r = await api.decision(read.read_id, 'final', d)
    setRead(r); setConfirmed(true)
    if (signout) await doSignout(r, d)
    else setRec(await api.policy(r.read_id))
    setTab('decision')
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
      setSignout(s.signout)
      if (s.signout.regions[0]) setActiveTarget(s.signout.regions[0].region_id)
    }
  }, [])
  const onReplayStart = useCallback(() => {
    setSignout(null); setActiveTarget(null)
    setLayers((l) => ({ ...l, coverage: true }))
    setReplay({ active: true, follow: null, fix: null })
  }, [])
  const onReplayStop = useCallback(() => {
    setReplay({ active: false, follow: null, fix: null })
    setCoverage(liveCoverage.current); setSignout(null)
  }, [])

  // ---- derived ----
  const evidenceVisible = !!ev && !ev.hidden
  const coverageUrl = useRecolouredCoverage(layers.coverage && !allHidden && coverage ? `${coverage.overlay_url}?v=${coverage.n_events}` : null)
  const layerSpecs = useMemo<LayerSpec[]>(() => {
    if (!detail || allHidden) return []
    const out: LayerSpec[] = []
    if (layers.artifact) out.push({ key: 'artifact', url: api.overlayUrl(detail.case_id, 'artifact'), opacity: 0.8 })
    if (evidenceVisible && !replay.active && layers.risk && detail.layers.includes('risk'))
      out.push({ key: 'risk', url: api.overlayUrl(detail.case_id, 'risk', read?.read_id), opacity })
    if (evidenceVisible && !replay.active && layers.disagreement && detail.layers.includes('disagreement'))
      out.push({ key: 'disagreement', url: api.overlayUrl(detail.case_id, 'disagreement', read?.read_id), opacity: Math.min(1, opacity + 0.15) })
    if (layers.coverage && coverageUrl) out.push({ key: 'coverage', url: coverageUrl, opacity: 1 })
    return out
  }, [detail, layers, evidenceVisible, read, coverageUrl, replay.active, opacity, allHidden])

  const boxes = useMemo(() => {
    const out: { region: Region; tone: 'evidence' | 'disputed' | 'unseen' | 'selected'; label: string }[] = []
    if (allHidden) return out
    if (evidenceVisible && layers.regions && !replay.active) {
      // once unseen alerts exist, AI region labels step back so the alert labels stay legible
      const quiet = !!signout?.regions.length
      evRegions.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'evidence', label: quiet ? '' : `#${r.rank} probe score ${score(r.risk)}` }))
      if (layers.disagreement) disputed.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'disputed', label: `#${r.rank} models disagree` }))
    }
    signout?.regions.forEach((r) => out.push({ region: r, tone: 'unseen', label: `Not yet viewed · ${r.rank}` }))
    if (ev?.tile_rect && evidenceVisible && !replay.active)
      out.push({ region: { ...ev.tile_rect, region_id: 'tile', kind: 'tile', rank: 0, risk: null, disagreement: null, n_tiles: 1, peak_tile_id: null, source: null }, tone: 'selected', label: '' })
    return out
  }, [evRegions, disputed, signout, ev, evidenceVisible, layers, replay.active, allHidden])

  /** Highlighted regions to step through with J/K: unseen alerts first, then AI regions. */
  const targets = useMemo<Target[]>(() => {
    const t: Target[] = []
    signout?.regions.forEach((r) => t.push({ id: r.region_id, rect: r, label: `Not yet viewed ${r.rank}`, what: `alert:${r.region_id}` }))
    if (evidenceVisible && !replay.active) {
      evRegions.slice(0, 5).forEach((r) => t.push({ id: r.region_id, rect: r, label: `Region #${r.rank}`, what: `region:${r.region_id}` }))
      if (layers.disagreement) disputed.slice(0, 3).forEach((r) => t.push({ id: r.region_id, rect: r, label: `Disputed #${r.rank}`, what: `disputed:${r.region_id}` }))
    }
    return t
  }, [signout, evRegions, disputed, evidenceVisible, replay.active, layers.disagreement])
  const targetIdx = targets.findIndex((t) => t.id === activeTarget)
  const stepTarget = useCallback((dir: 1 | -1) => {
    if (!targets.length) return
    const i = targetIdx < 0 ? (dir === 1 ? 0 : targets.length - 1) : (targetIdx + dir + targets.length) % targets.length
    jump(targets[i].rect, targets[i].what)
  }, [targets, targetIdx, jump])

  const wf: WorkflowState = { read, signout, rec, evidenceVisible, confirmed }
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

  const toggleLayer = useCallback((k: LayerKey, on: boolean) => {
    setLayers((l) => ({ ...l, [k]: on }))
    if (on) setAllHidden(false)
    api.audit('layer_toggled', { read_id: readRef.current?.read_id, case_id: selected ?? undefined, detail: { layer: k, on } })
  }, [selected])
  const toggleAll = useCallback(() => {
    setAllHidden((h) => {
      api.audit('layer_toggled', { read_id: readRef.current?.read_id, case_id: selected ?? undefined, detail: { layer: 'all', on: h } })
      return !h
    })
  }, [selected])
  const toggleNavigator = useCallback(() => setNavigatorOn((n) => { controls.current?.setNavigator(!n); return !n }), [])
  useEffect(() => { if (vStatus.state === 'ready') controls.current?.setNavigator(navigatorOn) }, [vStatus, navigatorOn])

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
        '0': () => controls.current?.home(),
        f: () => onFocusMode(!focusMode),
        '[': () => setNavOpen((o) => !o), ']': () => setSideOpen((o) => !o),
        '1': () => { setTab('evidence'); setSideOpen(true) }, '2': () => { setTab('unseen'); setSideOpen(true) },
        '3': () => { setTab('model'); setSideOpen(true) }, '4': () => { setTab('decision'); setSideOpen(true) },
        '?': () => setShowHelp((s) => !s),
        Escape: () => { if (showHelp) setShowHelp(false); else if (focusMode) onFocusMode(false) },
      }
      const fn = map[k] ?? map[k.toLowerCase()]
      if (!fn) return
      // 0 and +/- inside the viewer canvas are handled by OpenSeadragon itself
      if (t?.closest('.osd') && /^[0+=-]$/.test(k)) return
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, detail, evidenceVisible, layers, toggleLayer, toggleAll, toggleNavigator, stepTarget, focusMode, onFocusMode, showHelp])

  // ---- side panel resize (pointer drag, or arrow keys on the handle) ----
  const dragging = useRef<{ x: number; w: number } | null>(null)
  const onResizeDown = (e: RPointerEvent<HTMLDivElement>) => { dragging.current = { x: e.clientX, w: sideW }; e.currentTarget.setPointerCapture(e.pointerId) }
  const onResizeMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    setSideW(Math.min(560, Math.max(300, dragging.current.w + (dragging.current.x - e.clientX))))
  }
  const onResizeKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSideW((w) => Math.min(560, w + 20)) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSideW((w) => Math.max(300, w - 20)) }
  }

  const showNav = navOpen && !focusMode
  const showSide = sideOpen && !focusMode
  const alertsOpen = signout?.regions.filter((r) => r.alert_status !== 'revisited').length ?? 0

  const tabs = [
    { id: 'evidence', label: 'Evidence', icon: evidenceVisible ? undefined : <Lock size={12} aria-label="locked" /> },
    { id: 'unseen', label: 'Unseen', count: signout ? alertsOpen : undefined },
    { id: 'model', label: 'Models', icon: evidenceVisible ? undefined : <Lock size={12} aria-label="locked" /> },
    { id: 'decision', label: 'Decision' },
  ]

  return (
    <div className={`review ${showNav ? 'has-nav' : ''} ${showSide ? 'has-side' : ''}`} style={{ ['--side-w' as string]: `${sideW}px` }}>
      {showNav && (
        <aside className="review-nav" aria-label="Case list">
          <CaseQueue cases={cases} selected={selected} onSelect={onSelectCase} error={casesErr} />
        </aside>
      )}

      <section className="review-center" aria-label="Slide viewer">
        <div className="review-toolbar">
          {!focusMode && (
            <Button variant="ghost" size="sm" icon={showNav ? PanelLeftClose : PanelLeftOpen} onClick={() => setNavOpen(!navOpen)}
              aria-expanded={showNav} aria-label={showNav ? 'Hide case list ([)' : 'Show case list ([)'} title={showNav ? 'Hide case list ([)' : 'Show case list ([)'} />
          )}
          {detail ? (
            <div className="case-title">
              <h1 className="mono">{detail.slide_id}</h1>
              <StatusBadge kind="tier" value={detail.tier} />
              {read && (read.review_mode === 'blind'
                ? <span className="badge tone-info" title="Your assessment is recorded before AI evidence is shown"><EyeOff size={13} aria-hidden />Blind-first</span>
                : <span className="badge tone-neutral" title="AI evidence is shown from the start"><Eye size={13} aria-hidden />Evidence-first</span>)}
              {replay.active && <span className="badge tone-accent"><History size={13} aria-hidden />Replaying recorded read</span>}
              <InfoTip label="Case details">
                {tissueLabel(detail.organ)} · {detail.dataset.toUpperCase()}. Model uncertainty (routing signal, normalised entropy 0–1): {score(routing)}.
                Slide {detail.width.toLocaleString()} × {detail.height.toLocaleString()} px at {detail.mpp.toFixed(3)} µm/px.
              </InfoTip>
            </div>
          ) : <div className="case-title"><h1>Slide Review</h1></div>}
          <span className="toolbar-spacer" />
          {detail && (
            <ViewControls zoomMag={zoomMag} minMag={minMag} onZoom={(f) => controls.current?.zoomBy(f)} onHome={() => controls.current?.home()}
              navigator={navigatorOn} onNavigator={toggleNavigator} focusMode={focusMode} onFocusMode={() => onFocusMode(!focusMode)}
              onShortcuts={() => setShowHelp((s) => !s)} />
          )}
          <span className="ruo-chip xs" title="Research use only. Not for clinical diagnosis."><FlaskConical size={12} aria-hidden /> RUO</span>
          <div className="btn-row nowrap">
            <ButtonLink size="sm" variant="ghost" icon={ArrowLeft} href={prevCase ? href({ page: 'review', caseId: prevCase.case_id }) : undefined}
              aria-disabled={!prevCase} aria-label="Previous case in queue" title={prevCase ? `Previous: ${prevCase.slide_id}` : 'No previous case'} />
            <ButtonLink size="sm" variant="ghost" icon={ArrowRight} href={nextCase ? href({ page: 'review', caseId: nextCase.case_id }) : undefined}
              aria-disabled={!nextCase} aria-label="Next case in queue" title={nextCase ? `Next: ${nextCase.slide_id}` : 'No next case'} />
          </div>
          {!focusMode && (
            <Button variant="ghost" size="sm" icon={showSide ? PanelRightClose : PanelRightOpen} onClick={() => setSideOpen(!sideOpen)}
              aria-expanded={showSide} aria-label={showSide ? 'Hide AI panel (])' : 'Show AI panel (])'} title={showSide ? 'Hide AI panel (])' : 'Show AI panel (])'} />
          )}
        </div>

        {detail && (
          <LayersBar layers={layers} onToggle={toggleLayer} allHidden={allHidden} onToggleAll={toggleAll} evidenceVisible={evidenceVisible && !replay.active}
            opacity={opacity} onOpacity={setOpacity}
            target={targets.length ? { index: Math.max(0, targetIdx), total: targets.length, label: targetIdx >= 0 ? targets[targetIdx].label : 'Highlighted regions' } : null}
            onPrevTarget={() => stepTarget(-1)} onNextTarget={() => stepTarget(1)} />
        )}

        {detail && (detail.problems.length > 0 || !detail.dzi_url || error || notice) && (
          <div className="review-notices">
            {notice && <div className="notice" role="status"><Info size={14} aria-hidden /><span>{notice}</span>
              <button type="button" className="link-btn xs notice-x" onClick={() => setNotice(null)}>Dismiss</button></div>}
            {detail.problems.map((p) => <div key={p} className="notice warn"><TriangleAlert size={14} aria-hidden />{p}</div>)}
            {!detail.dzi_url && <div className="notice"><Info size={14} aria-hidden />Whole-slide file not on this machine: showing the thumbnail.</div>}
            {error && <div className="notice warn" role="alert"><TriangleAlert size={14} aria-hidden />{error}</div>}
          </div>
        )}

        {!detail ? (
          <div className="review-empty">
            {selected ? (
              error ? <EmptyState icon={TriangleAlert} tone="warning" title="This case could not be opened">{error}</EmptyState>
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
              <SlideViewer detail={detail} layers={layerSpecs} boxes={boxes} focus={focus} follow={replay.follow}
                fixation={replay.fix} onViewport={onViewport} onClickPoint={onClickPoint} onStatus={setVStatus} controls={controls}
                onBoxClick={(r) => r.kind === 'unseen' ? jump(r, `alert:${r.region_id}`) : selected && loadEvidence(selected, read, { tile: r.peak_tile_id ?? undefined })} />
              {vStatus.state === 'loading' && <div className="viewer-status" role="status"><span className="spinner" aria-hidden /> Loading slide…</div>}
              {vStatus.state === 'error' && <div className="viewer-status is-error" role="alert"><TriangleAlert size={16} aria-hidden /> {vStatus.message}</div>}
              {vStatus.state === 'ready' && vStatus.tileErrors > 0 && (
                <div className="viewer-status is-warn" role="status"><TriangleAlert size={14} aria-hidden /> {vStatus.tileErrors} image tile{vStatus.tileErrors === 1 ? '' : 's'} failed to load; some areas may look blank.</div>
              )}
              {(layers.coverage && coverage && !allHidden) || (evidenceVisible && layers.risk && !allHidden && !replay.active) ? (
                <div className="legend" aria-label="Overlay legend">
                  {evidenceVisible && layers.risk && !replay.active && <span><span className="sw sw-risk" />Tumour probe score (low→high)</span>}
                  {layers.coverage && coverage && <span><span className="sw sw-cov" />Not yet viewed (shaded)</span>}
                </div>
              ) : null}
              {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
              {!showHelp && <button type="button" className="shortcut-hint xs" onClick={() => setShowHelp(true)}>Press <kbd>?</kbd> for shortcuts</button>}
            </div>
            {!replay.active && read && (
              <DecisionBar wf={wf} read={read} signout={signout} busy={busy}
                onInitial={recordInitial} onRunCheck={runCheck} onFinal={recordFinal}
                nextHref={nextOpen ? href({ page: 'review', caseId: nextOpen.case_id }) : null} />
            )}
          </>
        )}
      </section>

      {showSide && (
        <aside className="review-side" aria-label="AI evidence and review">
          <div className="resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize AI panel"
            aria-valuemin={300} aria-valuemax={560} aria-valuenow={sideW} tabIndex={0}
            onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={() => { dragging.current = null }} onKeyDown={onResizeKey} />
          {detail ? (
            <>
              <Tabs tabs={tabs} value={tab} onChange={(t) => setTab(t as TabId)} label="AI evidence and review" idPrefix="rv" />
              <div className="side-body" role="tabpanel" id="rv-panel" aria-labelledby={`rv-tab-${tab}`} tabIndex={0}>
                {tab === 'evidence' && (
                  <EvidenceTab ev={ev} loading={evLoading} replaying={replay.active} evidenceRegions={evRegions} onJump={jump} activeTarget={activeTarget} />
                )}
                {tab === 'unseen' && (
                  <UnseenTab coverage={coverage} signout={signout} onJump={jump} activeAlert={activeTarget} zoomMag={zoomMag}
                    canRunCheck={!!read?.initial_decision && !busy && !replay.active} onRunCheck={runCheck} replayActive={replay.active}
                    replay={<ReplayPanel caseId={detail.case_id} onStep={onReplayStep} onStart={onReplayStart} onStop={onReplayStop}
                      locked={!read || (read.review_mode === 'blind' && !read.initial_decision)} />} />
                )}
                {tab === 'model' && (
                  <ModelTab detail={detail} ev={replay.active ? null : ev} disputed={disputed} cohortRank={cohort} evalResult={evalResult}
                    onJump={jump} disagreementLayer={layers.disagreement} onToggleLayer={(on) => toggleLayer('disagreement', on)} activeTarget={activeTarget} />
                )}
                {tab === 'decision' && (
                  <DecisionTab wf={wf} read={read} signout={signout} rec={replay.active ? null : rec} tierSlow={detail.tier === 'slow'}
                    routingSignal={detail.routing_signal} extraReads={extraReads} onSecondRead={secondRead} />
                )}
              </div>
            </>
          ) : <p className="small muted side-empty">Evidence, unseen areas, model comparison and the review decision appear here once a case is open.</p>}
        </aside>
      )}
    </div>
  )
}

