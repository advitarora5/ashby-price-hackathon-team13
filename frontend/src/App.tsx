import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from './api'
import CaseQueue from './components/CaseQueue'
import EvalView from './components/EvalView'
import EvidencePanel from './components/EvidencePanel'
import PolicyPanel from './components/PolicyPanel'
import ReplayPanel from './components/ReplayPanel'
import ReviewForm from './components/ReviewForm'
import SlideViewer, { type LayerSpec, type ViewportReport } from './components/SlideViewer'
import Splitter from './components/Splitter'
import UnseenPanel from './components/UnseenPanel'
import type {
  CaseDetail, CaseRow, Coverage, Decision, Evidence, PolicyRec, PolicySummary, Read, Rect, Region,
  ReplayStep, Signout, Verdict, ViewEvent,
} from './types'
import { usePanel } from './usePanel'
import './styles.css'

type Layers = { risk: boolean; disagreement: boolean; artifact: boolean; coverage: boolean; regions: boolean }

const QUEUE = { initial: 250, min: 170, max: 480 }
const SIDE = { initial: 400, min: 300, max: 760 }
const NOTES = { initial: 190, min: 110, max: 640 }

export default function App() {
  const [tab, setTab] = useState<'review' | 'eval'>('review')
  const [queuePanel, setQueuePanel] = usePanel('queue', QUEUE)
  const [sidePanel, setSidePanel] = usePanel('side', SIDE)
  const [notesPanel, setNotesPanel] = usePanel('notes', NOTES)
  const [cases, setCases] = useState<CaseRow[]>([])
  const [casesErr, setCasesErr] = useState<string | null>(null)
  const [health, setHealth] = useState<{ provenance: string } | null>(null)
  const [blindAll, setBlindAll] = useState(false)
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
  const [summary, setSummary] = useState<PolicySummary | null>(null)
  const [layers, setLayers] = useState<Layers>({ risk: true, disagreement: false, artifact: false, coverage: false, regions: true })
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

  const refreshCases = useCallback(() => {
    api.cases().then((c) => { setCases(c); setCasesErr(null) }).catch((e) => setCasesErr(`Backend unreachable: ${e.message}`))
  }, [])

  useEffect(() => {
    refreshCases()
    api.health().then(setHealth).catch(() => undefined)
    api.policySummary().then(setSummary).catch(() => undefined)
  }, [refreshCases])

  const loadEvidence = useCallback(async (caseId: string, r: Read | null, where?: { tile?: string; x?: number; y?: number }) => {
    setEvLoading(true)
    try {
      const e = await api.evidence(caseId, { read_id: r?.read_id, ...where })
      setEv(e)
      if (!e.hidden && !where) {
        const [a, b] = await Promise.all([api.regions(caseId, 'evidence', r?.read_id), api.regions(caseId, 'disputed', r?.read_id)])
        setEvRegions(a.hidden ? [] : a.regions)
        setDisputed(b.hidden ? [] : b.regions)
      }
      if (e.hidden) { setEvRegions([]); setDisputed([]) }
    } catch (err) {
      setError((err as Error).message)
    } finally { setEvLoading(false) }
  }, [])

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
  const replayActive = useRef(false)
  replayActive.current = replay.active

  useEffect(() => {
    const t = window.setInterval(flush, 1500)
    return () => window.clearInterval(t)
  }, [flush])

  const openCase = useCallback(async (id: string) => {
    await flush()
    setSelected(id); setDetail(null); setRead(null); setEv(null); setEvRegions([]); setDisputed([])
    setCoverage(null); setSignout(null); setRec(null); setError(null); setActiveAlert(null)
    setReplay({ active: false, follow: null, fix: null })
    queue.current = []; seq.current = 0; t0.current = performance.now()
    try {
      const d = await api.case(id)
      setDetail(d)
      const r = await api.createRead(id, blindAll)
      // a reopened case continues its earlier read: keep numbering view events after the stored ones
      seq.current = r.next_seq
      t0.current = performance.now() - r.last_t_ms
      setRead(r)
      await loadEvidence(id, r)
      if (r.resumed) {
        api.coverage(r.read_id).then((c) => { liveCoverage.current = c; setCoverage(c) }).catch(() => undefined)
        if (r.initial_decision) api.policy(r.read_id).then(setRec).catch(() => undefined)
      }
      refreshCases()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [blindAll, flush, loadEvidence, refreshCases])

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

  const decide = async (stage: 'initial' | 'final', d: Decision) => {
    if (!read || !selected) return
    try {
      const wasHidden = ev?.hidden
      const r = await api.decision(read.read_id, stage, d)
      setRead(r)
      if (wasHidden && r.evidence_visible) await loadEvidence(selected, r)
      if (stage === 'final' && signout) await doSignout(r, d)
      else if (r.evidence_visible) setRec(await api.policy(r.read_id))
    } catch (e) { setError((e as Error).message) }
  }

  const saveNotes = async (text: string) => {
    if (!read || !selected) return
    try {
      const r = await api.saveNotes(read.read_id, text)
      setRead(r)
      if (ev?.hidden && r.evidence_visible) await loadEvidence(selected, r)
    } catch (e) { setError((e as Error).message) }
  }

  // blind read: save the reader's notes and assessment, which together unlock the AI evidence
  const reveal = async (text: string, d: Decision) => {
    if (!read || !selected) return
    try {
      let r = read
      if (!r.notes_saved_at || text !== (r.notes ?? '')) r = await api.saveNotes(r.read_id, text)
      if (r.initial_decision !== d) r = await api.decision(r.read_id, 'initial', d)
      setRead(r)
      if (r.evidence_visible) {
        await loadEvidence(selected, r)
        setRec(await api.policy(r.read_id))
      }
    } catch (e) { setError((e as Error).message) }
  }

  const reviewFeature = async (feature: string, verdict: Verdict, note: string) => {
    if (!read) return
    try { setRead(await api.reviewFeature(read.read_id, feature, verdict, note)) } catch (e) { setError((e as Error).message) }
  }

  const doSignout = async (r: Read, d: Decision) => {
    await flush()
    const s = await api.signout(r.read_id, d)
    setSignout(s)
    setLayers((l) => ({ ...l, coverage: true }))
    setCoverage(await api.coverage(r.read_id))
    setRec(await api.policy(r.read_id))
    if (s.regions[0]) jump(s.regions[0], `alert:${s.regions[0].region_id}`)
    refreshCases()
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

  const evidenceVisible = !!ev && !ev.hidden
  const layerSpecs = useMemo<LayerSpec[]>(() => {
    if (!detail) return []
    const out: LayerSpec[] = []
    if (layers.artifact) out.push({ key: 'artifact', url: api.overlayUrl(detail.case_id, 'artifact'), opacity: 0.8 })
    if (evidenceVisible && !replay.active && layers.risk && detail.layers.includes('risk'))
      out.push({ key: 'risk', url: api.overlayUrl(detail.case_id, 'risk', read?.read_id), opacity: 0.55 })
    if (evidenceVisible && !replay.active && layers.disagreement && detail.layers.includes('disagreement'))
      out.push({ key: 'disagreement', url: api.overlayUrl(detail.case_id, 'disagreement', read?.read_id), opacity: 0.7 })
    if (layers.coverage && coverage) out.push({ key: 'coverage', url: `${coverage.overlay_url}?v=${coverage.n_events}`, opacity: 0.75 })
    return out
  }, [detail, layers, evidenceVisible, read, coverage, replay.active])

  const boxes = useMemo(() => {
    const out: { region: Region; tone: 'evidence' | 'disputed' | 'unseen' | 'selected'; label: string }[] = []
    if (evidenceVisible && layers.regions && !replay.active) {
      evRegions.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'evidence', label: `risk ${Math.round((r.risk ?? 0) * 100)}%` }))
      if (layers.disagreement) disputed.slice(0, 3).forEach((r) => out.push({ region: r, tone: 'disputed', label: 'disputed' }))
    }
    signout?.regions.forEach((r) => out.push({ region: r, tone: 'unseen', label: `unviewed · ${Math.round((r.risk ?? 0) * 100)}%` }))
    if (ev?.tile_rect && evidenceVisible && !replay.active)
      out.push({ region: { ...ev.tile_rect, region_id: 'tile', kind: 'tile', rank: 0, risk: null, disagreement: null, n_tiles: 1, peak_tile_id: null, source: null }, tone: 'selected', label: '' })
    return out
  }, [evRegions, disputed, signout, ev, evidenceVisible, layers, replay.active])

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo">◐</span> SecondLook</div>
        <nav>
          <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>Review</button>
          <button className={tab === 'eval' ? 'on' : ''} onClick={() => setTab('eval')}>Evaluation</button>
        </nav>
        <label className="toggle" title="Record your own read before any AI evidence is shown, on every case">
          <input type="checkbox" checked={blindAll} onChange={(e) => setBlindAll(e.target.checked)} /> Blind-first for all cases
        </label>
        <div className="disclaimer">Experimental decision support · never a diagnosis{health ? ` · data: ${health.provenance}` : ''}</div>
      </header>
      {tab === 'eval' ? <EvalView /> : (
        <main className="workspace" style={{ gridTemplateColumns:
          `${queuePanel.open ? queuePanel.size : 0}px auto minmax(0, 1fr) auto ${sidePanel.open ? sidePanel.size : 0}px` }}>
          {/* collapsed panels stay mounted (display: none) so drafts and local state survive */}
          <div className={`dock ${queuePanel.open ? '' : 'collapsed'}`}>
            <CaseQueue cases={cases} selected={selected} onSelect={openCase} error={casesErr} />
          </div>
          <Splitter dock="left" panel={queuePanel} setPanel={setQueuePanel} limits={QUEUE} label="case queue" />
          <section className="center">
            {!detail && <div className="empty">{selected ? (error ?? 'Loading slide…') : 'Select a case from the queue.'}</div>}
            {detail && (
              <>
                <div className="toolbar">
                  <b>{detail.slide_id}</b>
                  <span className={`chip tier-${detail.tier}`}>{detail.tier} path</span>
                  {detail.tier_reasons.includes('artifacts') && <span className="chip art">damaged tissue</span>}
                  {read && <span className="chip">{read.review_mode === 'blind' ? 'blind-first' : 'evidence-first'}</span>}
                  {replay.active && <span className="chip replay">replaying recorded read</span>}
                  <span className="spacer" />
                  {(['risk', 'disagreement', 'regions', 'artifact', 'coverage'] as (keyof Layers)[]).map((k) => (
                    <label key={k} className={`layer ${(k === 'risk' || k === 'disagreement' || k === 'regions') && !evidenceVisible ? 'disabled' : ''}`}>
                      <input type="checkbox" checked={layers[k]} onChange={(e) => {
                        setLayers({ ...layers, [k]: e.target.checked })
                        api.audit('layer_toggled', { read_id: read?.read_id, case_id: selected ?? undefined, detail: { layer: k, on: e.target.checked } })
                      }} />{k === 'coverage' ? 'seen / unseen' : k}
                    </label>
                  ))}
                </div>
                {detail.problems.map((p) => <div key={p} className="notice warn">{p}</div>)}
                {!detail.dzi_url && <div className="notice">Whole-slide file not on this machine: showing the thumbnail.</div>}
                {error && <div className="notice warn">{error}</div>}
                <div className="viewer-wrap">
                  <SlideViewer detail={detail} layers={layerSpecs} boxes={boxes} focus={focus} follow={replay.follow}
                    fixation={replay.fix} onViewport={onViewport} onClickPoint={onClickPoint}
                    onBoxClick={(r) => r.kind === 'unseen' ? jump(r, `alert:${r.region_id}`) : selected && loadEvidence(selected, read, { tile: r.peak_tile_id ?? undefined })} />
                  {layers.coverage && coverage && (
                    <div className="legend"><span className="sw seen" />seen <span className="sw unseen" />tissue not yet seen</div>
                  )}
                </div>
                {!replay.active && read && (
                  <>
                    <Splitter dock="bottom" panel={notesPanel} setPanel={setNotesPanel} limits={NOTES} label="notes panel" />
                    <div className={`dock notes-dock ${notesPanel.open ? '' : 'collapsed'}`} style={{ height: notesPanel.size }}>
                      <ReviewForm read={read} evidenceHidden={!read.evidence_visible} signedOutOnce={!!signout}
                        onSaveNotes={saveNotes} onReveal={reveal} onDecide={decide} onSignOut={signOut} />
                    </div>
                  </>
                )}
              </>
            )}
          </section>
          <Splitter dock="right" panel={sidePanel} setPanel={setSidePanel} limits={SIDE} label="evidence panel" />
          <aside className={`side ${sidePanel.open ? '' : 'collapsed'}`}>
            {detail && (
              <>
                <EvidencePanel ev={replay.active ? null : ev} loading={evLoading} evidenceRegions={evRegions} disputed={disputed} onJump={jump}
                  reviews={read && read.source === 'live' && read.evidence_visible ? read.feature_reviews : null}
                  reviewKey={read?.read_id ?? ''} onReview={reviewFeature} />
                <UnseenPanel coverage={coverage} signout={signout} onJump={jump} activeAlert={activeAlert} />
                <PolicyPanel rec={replay.active ? null : rec} summary={summary} tierSlow={detail.tier === 'slow'} onSecondRead={secondRead} />
                <ReplayPanel caseId={detail.case_id} onStep={onReplayStep} onStart={onReplayStart} onStop={onReplayStop} />
              </>
            )}
          </aside>
        </main>
      )}
    </div>
  )
}
