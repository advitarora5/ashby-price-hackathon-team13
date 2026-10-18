import { useState } from 'react'
import { ChevronDown, ChevronRight, Crosshair, Info, Lock, TriangleAlert } from 'lucide-react'
import type { EvalDoc, Evidence, FeatureBar, Rect, Region } from '../../types'
import { pct, score } from '../../lib/format'
import { tumourSignalEval } from '../../lib/research'
import Exemplars from './Exemplars'
import InfoTip from '../ui/InfoTip'
import { Button } from '../ui/Button'

interface Props {
  ev: Evidence | null
  loading: boolean
  replaying: boolean
  evidenceRegions: Region[]
  onJump: (r: Rect, what: string) => void
  activeTarget: string | null
  evalDocs: Record<string, EvalDoc> | null
}

function Bar({ f, onJump }: { f: FeatureBar; onJump: Props['onJump'] }) {
  const calibrated = f.calibrated && f.value !== null
  return (
    <div className="bar-row">
      <div className="bar-label"><span>{f.label}</span></div>
      <div className="bar-line">
        <div className="bar-track" title={calibrated ? undefined : 'Text-prompt similarity: not a probability'}>
          <div className={`bar-fill ${calibrated ? '' : 'hatched'}`} style={{ width: pct(calibrated ? f.value : f.raw ?? 0) }} />
        </div>
        <span className="bar-val num">{calibrated ? pct(f.value) : score(f.raw)}</span>
        {f.jump_links.length > 0 ? (
          <button type="button" className="link-btn small" aria-label={`Where: strongest tiles for ${f.label}`}
            onClick={() => onJump(f.jump_links[0], `jump:${f.id}`)}><Crosshair size={12} aria-hidden /> Where</button>
        ) : <span />}
      </div>
    </div>
  )
}

/**
 * What the AI flags and where. The tumour probe (the stronger ranker in evaluation) leads; the
 * calibrated text-prompt score is secondary and labelled as the weaker ranker. Numbers come from /api/eval.
 */
export default function EvidenceTab({ ev, loading, replaying, evidenceRegions, onJump, activeTarget, evalDocs }: Props) {
  const [showText, setShowText] = useState(false)
  if (replaying) return <p className="small muted">AI evidence is hidden while a recorded read is replayed.</p>
  if (loading && !ev) return <p className="small muted">Loading evidence…</p>
  if (!ev) return null
  if (ev.hidden) {
    const why = ev.hidden_reason ? ev.hidden_reason.replace(/\.?$/, '.') : ''
    return (
      <div className="locked">
        <Lock size={18} aria-hidden />
        <div>
          <strong>AI evidence hidden until you record your assessment</strong>
          <p className="small">{why} This keeps your first read independent of the AI.</p>
        </div>
      </div>
    )
  }
  const sig = tumourSignalEval(evalDocs)
  const meta = ev.features.find((f) => f.id === 'metastasis' && f.calibrated && f.value !== null) ?? null
  const otherCal = ev.features.filter((f) => f.calibrated && f.value !== null && f.id !== 'metastasis')
  const textOnly = ev.features.filter((f) => !(f.calibrated && f.value !== null))
  const conflict = meta && ev.tumor_prob !== null && Math.abs(ev.tumor_prob - (meta.value ?? 0)) > 0.4
  return (
    <div className="tab-stack">
      {ev.notes.map((n) => <div key={n} className="notice"><Info size={14} aria-hidden />{n}</div>)}

      <section className="sub" aria-labelledby="ev-tile">
        <div className="sub-head">
          <h3 id="ev-tile" tabIndex={-1}>Selected tile <span className="mono muted">{ev.tile_id?.split(':')[1] ?? '—'}</span></h3>
          {ev.tile_rect && <Button size="sm" variant="ghost" icon={Crosshair} onClick={() => onJump(ev.tile_rect!, 'tile')}>Go to tile</Button>}
        </div>
        <p className="xs muted">Click anywhere on the slide to inspect another tile.</p>

        <div className="signal primary">
          <div className="signal-head">
            <span className="signal-name">Tumour probe score</span>
            <span className="signal-val num">{ev.tumor_prob === null ? 'Unavailable' : score(ev.tumor_prob)}</span>
          </div>
          <div className="xs muted">
            Primary tumour signal: ranks tiles well{sig.probe ? <> (tile AUROC {sig.probe.auroc}{sig.probe.ci ? `, CI ${sig.probe.ci}` : ''}{sig.slides ? `, ${sig.slides} test slides` : ''})</> : null}.
            Uncalibrated: the value is a 0–1 score, not a probability.
            <InfoTip label="About the tumour probe score">
              A linear probe on QuiltNet tile embeddings{ev.tumor_prob_source ? ` (${ev.tumor_prob_source})` : ''}, trained on 12 CAMELYON16
              slides and smoothed over neighbouring tiles. In evaluation it separated tumour from benign tiles better than the text-prompt score.
              AUROC (area under the ROC curve) = how well a score ranks positive tiles above negative ones; 0.5 is chance, 1.0 is perfect.
            </InfoTip>
          </div>
        </div>

        {meta && (
          <div className="signal">
            <div className="signal-head">
              <span className="signal-name">Text prompt “metastasis” (calibrated)</span>
              <span className="signal-val num">{pct(meta.value)}</span>
            </div>
            <div className="xs muted">
              Secondary: calibrated scale (share of similar-scoring labelled tiles that carried the label), but a weaker ranker
              {sig.text ? <> (tile AUROC {sig.text.auroc}{sig.text.ci ? `, CI ${sig.text.ci}` : ''})</> : null}.
              {meta.jump_links.length > 0 && <> <button type="button" className="link-btn" onClick={() => onJump(meta.jump_links[0], `jump:${meta.id}`)}>Where</button></>}
            </div>
          </div>
        )}
        {conflict && (
          <p className="small conflict-note"><Info size={13} aria-hidden className="inline-icon" /> These two signals disagree on this tile. In evaluation the probe separated tumour from benign tiles better; judge the tissue.</p>
        )}
        {ev.artifacts.length > 0 && (
          <div className="chips">{ev.artifacts.map((a) => <span key={a} className="tag warn-tag"><TriangleAlert size={12} aria-hidden />Artifact: {a}</span>)}</div>
        )}
      </section>

      {otherCal.length > 0 && (
        <section className="sub" aria-labelledby="ev-cal">
          <div className="sub-head"><h3 id="ev-cal">Calibrated text-prompt evidence</h3></div>
          <div className="bars">{otherCal.map((f) => <Bar key={f.id} f={f} onJump={onJump} />)}</div>
        </section>
      )}

      {textOnly.length > 0 && (
        <section className="sub">
          <button type="button" className="disclosure" aria-expanded={showText} onClick={() => setShowText(!showText)}>
            {showText ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            Other text prompts <span className="tag">uncalibrated</span> <span className="muted num">({textOnly.length})</span>
          </button>
          {showText && (
            <>
              <p className="xs muted">
                Raw similarity between the tile and a text description. Not calibrated, not validated and not a probability; several prompts
                (mucus, glands, smooth muscle) describe colon tissue and are not specific to lymph node.
              </p>
              <div className="bars">{textOnly.map((f) => <Bar key={f.id} f={f} onJump={onJump} />)}</div>
            </>
          )}
        </section>
      )}

      {ev.exemplars && (
        <section className="sub" aria-labelledby="ev-ex">
          <div className="sub-head"><h3 id="ev-ex">Labelled examples</h3></div>
          <Exemplars ex={ev.exemplars} title="Most similar labelled tiles from other slides" />
        </section>
      )}

      {evidenceRegions.length > 0 && (
        <section className="sub" aria-labelledby="ev-reg">
          <div className="sub-head">
            <h3 id="ev-reg">Highest-scoring regions</h3>
            <span className="xs muted"><kbd>J</kbd> / <kbd>K</kbd> to step</span>
          </div>
          <div className="region-list">
            {evidenceRegions.slice(0, 5).map((r) => (
              <button type="button" key={r.region_id} className={`region-item ${activeTarget === r.region_id ? 'is-active' : ''}`}
                onClick={() => onJump(r, `region:${r.region_id}`)}>
                <span className="num">#{r.rank}</span><span className="num">probe score {score(r.risk)}</span><span className="muted num">{r.n_tiles} tiles</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
