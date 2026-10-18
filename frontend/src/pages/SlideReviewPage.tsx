import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Eye, EyeOff, History, ListChecks, Microscope, PanelLeftClose, PanelLeftOpen, TriangleAlert, Info } from 'lucide-react'
import { api, ApiError } from '../api'
import CaseQueue from '../components/CaseQueue'
import EvidencePanel from '../components/EvidencePanel'
import PolicyPanel from '../components/PolicyPanel'
import ReplayPanel from '../components/ReplayPanel'
import SlideViewer, { type LayerSpec, type ViewportReport } from '../components/SlideViewer'
import UnseenPanel from '../components/UnseenPanel'
import StatusBadge from '../components/ui/StatusBadge'
import { Button, ButtonLink } from '../components/ui/Button'
import EmptyState from '../components/ui/EmptyState'
import { href } from '../lib/router'
import { absoluteTime, score } from '../lib/format'
import { deriveActivity } from '../lib/activity'
import { useRecolouredCoverage } from '../lib/coverageOverlay'
import type {
  CaseDetail, CaseRow, Coverage, Decision, Evidence, PolicyRec, PolicySummary, Read, Rect, Region,
  ReplayStep, Signout, ViewEvent,
} from '../types'

type Layers = { risk: boolean; disagreement: boolean; artifact: boolean; coverage: boolean; regions: boolean }
const DEFAULT_LAYERS: Layers = { risk: true, disagreement: false, artifact: false, coverage: false, regions: true }

/** Everything needed to return to a case in this session without starting a new read. */
interface Snapshot {
  detail: CaseDetail; read: Read | null; ev: Evidence | null; evRegions: Region[]; disputed: Region[]
  coverage: Coverage | null; signout: Signout | null; rec: PolicyRec | null; layers: Layers
  seq: number; t0: number; liveCoverage: Coverage | null; notice: string | null
}

const LAYER_LABELS: Record<keyof Layers, string> = {
  risk: 'Tumour score', disagreement: 'Disagreement', regions: 'Flagged regions', artifact: 'Artifacts', coverage: 'Seen / unseen',
}
const AI_LAYERS: (keyof Layers)[] = ['risk', 'disagreement', 'regions']
const DECISIONS: Decision[] = ['benign', 'suspicious', 'malignant']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

interface Props {
  caseId: string | null
  visible: boolean
  cases: CaseRow[]
  casesErr: string | null
  blindAll: boolean
  summary: PolicySummary | null
  onCasesChanged: () => void
  onSelectCase: (id: string) => void
}

export default function SlideReviewPage({ caseId, visible, cases, casesErr, blindAll, summary, onCasesChanged, onSelectCase }: Props) {
  const [navOpen, setNavOpen] = useState(() => window.innerWidth >= 1600)
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
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const [notice, setNotice] = useState<string | null>(null)
  const sessions = useRef(new Map<string, Snapshot>())
  const [focus, setFocus] = useState<{ rect: Rect; key: number } | null>(null)
  const [activeAlert, setActiveAlert] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [replay, setReplay] = useState<{ active: boolean; follow: (Rect & { key: number }) | null; fix: { x: number; y: number } | null }>({ active: false, follow: null, fix: null })
  const liveCoverage = useRef<Coverage | null>(null)
  const queue = useRef<ViewEvent[]>([])
  const seq = useRef(0)
  const t0 = useRef(0)
  const readRef = useRef<Read | null>(null)
  readRef.current = read
  const replayActive = useRef(false)
  replayActive.current = replay.active
  const requested = useRef<string | null>(null)

  const loadEvidence = useCallback(async (cid: string, r: Read | null, where?: { tile?: string; x?: number; y?: number }) => {
    setEvLoading(true)
    try {
      const e = await api.evidence(cid, { read_id: r?.read_id, ...where })
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
    detail, read, ev, evRegions, disputed, coverage, signout, rec, layers,
    seq: seq.current, t0: t0.current, liveCoverage: liveCoverage.current, notice,
  } : null

  const openCase = useCallback(async (id: string) => {
    await flush()
    if (snap.current) sessions.current.set(snap.current.detail.case_id, snap.current)
    setActiveAlert(null); setFocus(null); setError(null)
    setReplay({ active: false, follow: null, fix: null })
    queue.current = []
    const saved = sessions.current.get(id)
    if (saved) {
      // same session: restore exactly, no new read
      setSelected(id); setDetail(saved.detail); setRead(saved.read); setEv(saved.ev); setEvRegions(saved.evRegions)
      setDisputed(saved.disputed); setCoverage(saved.coverage); setSignout(saved.signout); setRec(saved.rec)
      setLayers(saved.layers); setNotice(saved.notice)
      seq.current = saved.seq; t0.current = saved.t0; liveCoverage.current = saved.liveCoverage
      return
    }
    setSelected(id); setDetail(null); setRead(null); setEv(null); setEvRegions([]); setDisputed([])
    setCoverage(null); setSignout(null); setRec(null); setLayers(DEFAULT_LAYERS); setNotice(null)
    liveCoverage.current = null
    seq.current = 0; t0.current = performance.now()
    try {
      const [d, events] = await Promise.all([api.case(id), api.caseAudit(id).catch(() => [])])
      if (requested.current !== id) return
      setDetail(d)
      const act = deriveActivity(events)[id]
      // another session (or a reload): resume the latest live read if the case is still in progress
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
        setNotice(`Resumed the most recent read of this case, opened ${act?.lastReadOpenedAt ? absoluteTime(act.lastReadOpenedAt) : 'earlier'}${r.initial_decision ? ` (assessment: ${r.initial_decision})` : ''}.`)
        await loadEvidence(id, r)
        if (r.initial_decision) setRec(await api.policy(r.read_id).catch(() => null))
      } else {
        r = await api.createRead(id, blindAll)
        if (requested.current !== id) return
        setRead(r)
        if (r.review_mode === 'blind' && act?.aiSeenAt) {
          // protect the blind-vs-aided record: say so, and note it in the audit log
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
    if (!readRef.current || replayActive.current) return
    queue.current.push({ seq: seq.current++, t_ms: performance.now() - t0.current, kind: 'viewport', ...v })
  }, [])

  const jump = useCallback((r: Rect, what: string) => {
    setFocus({ rect: r, key: Date.now() })
    if (what.startsWith('alert:')) setActiveAlert(what.slice(6))
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
    setCoverage(await api.coverage(r.read_id))
    setRec(await api.policy(r.read_id))
    if (s.regions[0]) jump(s.regions[0], `alert:${s.regions[0].region_id}`)
    onCasesChanged()
  }

  const decide = async (stage: 'initial' | 'final', d: Decision) => {
    if (!read || !selected) return
    try {
      const wasHidden = ev?.hidden
      const r = await api.decision(read.read_id, stage, d)
      setRead(r)
      if (wasHidden && r.evidence_visible) await loadEvidence(selected, r)
      if (stage === 'final' && signout) await doSignout(r, d)
      else setRec(await api.policy(r.read_id))
      onCasesChanged()
    } catch (e) { setError((e as Error).message) }
  }

  const signOut = async () => {
    if (!read) return
    const d = read.final_decision ?? read.initial_decision
    if (!d) return
    try { await doSignout(read, d) } catch (e) { setError((e as Error).message) }
  }

  const secondRead = async (stage: 'second_reader' | 'third_reader', d: Decision) => {
    if (!read) return
    await api.decision(read.read_id, stage, d)
    setRec(await api.policy(read.read_id))
  }

  const onReplayStep = useCallback((s: ReplayStep) => {
    setCoverage(s.coverage)
    setReplay({ active: true, follow: s.viewport ? { ...s.viewport, key: s.cursor } : null,
      fix: s.last_fixation ? { x: s.last_fixation.x, y: s.last_fixation.y } : null })
    if (s.signout) {
      setSignout(s.signout)
      if (s.signout.regions[0]) setActiveAlert(s.signout.regions[0].region_id)
    }
  }, [])
  const onReplayStart = useCallback(() => {
    setSignout(null); setActiveAlert(null)
    setLayers((l) => ({ ...l, coverage: true }))
    setReplay({ active: true, follow: null, fix: null })
  }, [])
  const onReplayStop = useCallback(() => {
    setReplay({ active: false, follow: null, fix: null })
    setCoverage(liveCoverage.current); setSignout(null)
  }, [])

  const coverageUrl = useRecolouredCoverage(layers.coverage && coverage ? `${coverage.overlay_url}?v=${coverage.n_events}` : null)
  const evidenceVisible = !!ev && !ev.hidden
  const layerSpecs = useMemo<LayerSpec[]>(() => {
    if (!detail) return []
    const out: LayerSpec[] = []
    if (layers.artifact) out.push({ key: 'artifact', url: api.overlayUrl(detail.case_id, 'artifact'), opacity: 0.8 })
    if (evidenceVisible && !replay.active && layers.risk && detail.layers.includes('risk'))
      out.push({ key: 'risk', url: api.overlayUrl(detail.case_id, 'risk', read?.read_id), opacity: 0.55 })
    if (evidenceVisible && !replay.active && layers.disagreement && detail.layers.includes('disagreement'))
      out.push({ key: 'disagreement', url: api.overlayUrl(detail.case_id, 'disagreement', read?.read_id), opacity: 0.7 })
    if (layers.coverage && coverageUrl) out.push({ key: 'coverage', url: coverageUrl, opacity: 1 })
    return out
  }, [detail, layers, evidenceVisible, read, coverageUrl, replay.active])

  const boxes = useMemo(() => {
    const out: { region: Region; tone: 'evidence' | 'disputed' | 'unseen' | 'selected'; label: string }[] = []
    if (evidenceVisible && layers.regions && !replay.active) {
      evRegions.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'evidence', label: `#${r.rank} score ${score(r.risk)}` }))
      if (layers.disagreement) disputed.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'disputed', label: `#${r.rank} disputed` }))
    }
    signout?.regions.forEach((r) => out.push({ region: r, tone: 'unseen', label: `Not yet viewed · score ${score(r.risk)}` }))
    if (ev?.tile_rect && evidenceVisible && !replay.active)
      out.push({ region: { ...ev.tile_rect, region_id: 'tile', kind: 'tile', rank: 0, risk: null, disagreement: null, n_tiles: 1, peak_tile_id: null, source: null }, tone: 'selected', label: '' })
    return out
  }, [evRegions, disputed, signout, ev, evidenceVisible, layers, replay.active])

  const decision = read?.final_decision ?? read?.initial_decision ?? null
  const nextCase = cases.find((c) => c.review_status === 'unread')

  const toggleLayer = (k: keyof Layers, on: boolean) => {
    setLayers((l) => ({ ...l, [k]: on }))
    api.audit('layer_toggled', { read_id: read?.read_id, case_id: selected ?? undefined, detail: { layer: k, on } })
  }

  return (
    <div className={`review ${navOpen ? '' : 'nav-closed'}`} aria-hidden={!visible || undefined}>
      <aside className="review-nav" aria-label="Case list" hidden={!navOpen}>
        <CaseQueue cases={cases} selected={selected} onSelect={onSelectCase} error={casesErr} />
      </aside>

      <section className="review-center" aria-label="Slide viewer">
        <div className="review-toolbar">
          <Button variant="ghost" size="sm" icon={navOpen ? PanelLeftClose : PanelLeftOpen} onClick={() => setNavOpen(!navOpen)}
            aria-expanded={navOpen} aria-label={navOpen ? 'Hide case list' : 'Show case list'} title={navOpen ? 'Hide case list' : 'Show case list'} />
          {detail ? (
            <div className="case-title">
              <h1 className="mono">{detail.slide_id}</h1>
              <StatusBadge kind="tier" value={detail.tier} />
              {read && (read.review_mode === 'blind'
                ? <span className="badge tone-info" title="Your assessment is recorded before AI evidence is shown"><EyeOff size={13} aria-hidden />Blind-first</span>
                : <span className="badge tone-neutral" title="AI evidence is shown from the start"><Eye size={13} aria-hidden />Evidence-first</span>)}
              {replay.active && <span className="badge tone-accent"><History size={13} aria-hidden />Replaying recorded read</span>}
            </div>
          ) : <div className="case-title"><h1>Slide Review</h1></div>}
          <span className="toolbar-spacer" />
          {detail && (
            <fieldset className="layer-group">
              <legend className="sr-only">Overlays</legend>
              {(['risk', 'disagreement', 'regions', 'artifact', 'coverage'] as (keyof Layers)[]).map((k) => {
                const locked = AI_LAYERS.includes(k) && !evidenceVisible
                return (
                  <label key={k} className={`layer-toggle ${locked ? 'is-locked' : ''} ${layers[k] && !locked ? 'is-on' : ''}`}
                    title={locked ? 'AI layer: hidden until you record your assessment' : undefined}>
                    <input type="checkbox" checked={layers[k]} disabled={locked} onChange={(e) => toggleLayer(k, e.target.checked)} />
                    <span>{LAYER_LABELS[k]}</span>
                  </label>
                )
              })}
            </fieldset>
          )}
        </div>

        {detail && (detail.problems.length > 0 || !detail.dzi_url || error || notice) && (
          <div className="review-notices">
            {notice && <div className="notice" role="status"><Info size={14} aria-hidden /><span>{notice}</span></div>}
            {detail.problems.map((p) => <div key={p} className="notice warn"><TriangleAlert size={14} aria-hidden />{p}</div>)}
            {!detail.dzi_url && <div className="notice"><Info size={14} aria-hidden />Whole-slide file not on this machine: showing the thumbnail.</div>}
            {error && <div className="notice warn" role="alert"><TriangleAlert size={14} aria-hidden />{error}</div>}
          </div>
        )}

        {!detail ? (
          <div className="review-empty">
            {selected ? (
              error ? <EmptyState icon={TriangleAlert} tone="warning" title="This case could not be opened">{error}</EmptyState>
                : <EmptyState icon={Microscope} title="Loading slide…">Opening a new read on <span className="mono">{selected.replace('case_', '')}</span>.</EmptyState>
            ) : (
              <EmptyState icon={Microscope} title="No case open"
                action={<div className="btn-row">
                  {nextCase && <ButtonLink variant="primary" href={href({ page: 'review', caseId: nextCase.case_id })} iconRight={ArrowRight}>Open next priority case · {nextCase.slide_id}</ButtonLink>}
                  <ButtonLink href={href({ page: 'cases' })} icon={ListChecks}>Browse cases</ButtonLink>
                </div>}>
                Pick a case from the worklist. Opening a case starts a new read; your viewing is tracked to build the seen / unseen map.
              </EmptyState>
            )}
          </div>
        ) : (
          <>
            <div className="viewer-wrap">
              <SlideViewer detail={detail} layers={layerSpecs} boxes={boxes} focus={focus} follow={replay.follow}
                fixation={replay.fix} onViewport={onViewport} onClickPoint={onClickPoint}
                onBoxClick={(r) => r.kind === 'unseen' ? jump(r, `alert:${r.region_id}`) : selected && loadEvidence(selected, read, { tile: r.peak_tile_id ?? undefined })} />
              {layers.coverage && coverage && (
                <div className="legend" aria-label="Coverage legend"><span className="sw unseen" />Not yet viewed (shaded) <span className="sw seen" />Viewed (clear)</div>
              )}
            </div>
            {!replay.active && read && (
              <div className="decision-bar" role="region" aria-label="Your assessment">
                {!read.initial_decision ? (
                  <>
                    <span className="decision-prompt">
                      {read.review_mode === 'blind'
                        ? <><EyeOff size={15} aria-hidden /> <span><strong>Record your own assessment first.</strong> AI evidence stays hidden until you do.</span></>
                        : <strong>Your assessment</strong>}
                    </span>
                    <div className="btn-row">
                      {DECISIONS.map((d) => <Button key={d} onClick={() => decide('initial', d)}>{cap(d)}</Button>)}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="decision-prompt">
                      Your assessment: <strong>{cap(decision ?? '')}</strong>
                      {read.final_decision && read.initial_decision !== read.final_decision && <span className="muted"> (revised from {read.initial_decision})</span>}
                    </span>
                    <Button variant="primary" onClick={signOut}>{signout ? 'Re-run sign-out check' : 'Run sign-out check'}</Button>
                    {signout && (
                      <span className="final">
                        <span className="small muted">After re-inspection, confirm:</span>
                        {DECISIONS.map((d) => <Button key={d} size="sm" onClick={() => decide('final', d)} aria-pressed={read.final_decision === d}>{cap(d)}</Button>)}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <aside className="review-side" aria-label="AI evidence and review">
        {detail ? (
          <>
            <EvidencePanel ev={replay.active ? null : ev} loading={evLoading} evidenceRegions={evRegions} disputed={disputed} onJump={jump} />
            <UnseenPanel coverage={coverage} signout={signout} onJump={jump} activeAlert={activeAlert} />
            <PolicyPanel rec={replay.active ? null : rec} summary={summary} tierSlow={detail.tier === 'slow'} routingSignal={detail.routing_signal} onSecondRead={secondRead} />
            <ReplayPanel caseId={detail.case_id} onStep={onReplayStep} onStart={onReplayStart} onStop={onReplayStop}
              locked={!!read && read.review_mode === 'blind' && !read.initial_decision} />
          </>
        ) : <p className="small muted side-empty">Evidence, unseen tissue and the review recommendation appear here once a case is open.</p>}
      </aside>
    </div>
  )
}
