import { useState } from 'react'
import { ChevronDown, ChevronRight, Crosshair, Info, Lock, TriangleAlert } from 'lucide-react'
import type { Evidence, FeatureBar, Rect, Region } from '../../types'
import { pct, score } from '../../lib/format'
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

/** What the AI flags and where. Calibrated evidence first; unvalidated text-prompt bars are disclosed on request. */
export default function EvidenceTab({ ev, loading, replaying, evidenceRegions, onJump, activeTarget }: Props) {
  const [showText, setShowText] = useState(false)
  if (replaying) return <p className="small muted">AI evidence is hidden while a recorded read is replayed.</p>
  if (loading && !ev) return <p className="small muted">Loading evidence…</p>
  if (!ev) return null
  if (ev.hidden) {
    return (
      <div className="locked">
        <Lock size={18} aria-hidden />
        <div>
          <strong>AI evidence hidden until you record your assessment</strong>
          <p className="small">{ev.hidden_reason} This keeps your first read independent of the AI.</p>
        </div>
      </div>
    )
  }
  const calibrated = ev.features.filter((f) => f.calibrated && f.value !== null)
  const textOnly = ev.features.filter((f) => !(f.calibrated && f.value !== null))
  return (
    <div className="tab-stack">
      {ev.notes.map((n) => <div key={n} className="notice"><Info size={14} aria-hidden />{n}</div>)}

      <section className="sub" aria-labelledby="ev-tile">
        <div className="sub-head">
          <h3 id="ev-tile">Selected tile <span className="mono muted">{ev.tile_id?.split(':')[1] ?? '—'}</span></h3>
          {ev.tile_rect && <Button size="sm" variant="ghost" icon={Crosshair} onClick={() => onJump(ev.tile_rect!, 'tile')}>Go to tile</Button>}
        </div>
        <p className="xs muted">Click anywhere on the slide to inspect another tile.</p>
        <dl className="kv">
          <div>
            <dt>
              Tumour probe score <span className="muted">(uncalibrated)</span>
              <InfoTip label="About the tumour probe score">
                Output of a linear probe on foundation-model tile embeddings{ev.tumor_prob_source ? ` (${ev.tumor_prob_source})` : ''},
                smoothed over neighbouring tiles. A 0–1 score that ranks tiles; it is not the probability that the tile contains tumour,
                which is why it can read high while the calibrated “Metastatic carcinoma” bar reads lower.
              </InfoTip>
            </dt>
            <dd className="num">{ev.tumor_prob === null ? 'Unavailable' : score(ev.tumor_prob)}</dd>
          </div>
        </dl>
        {ev.artifacts.length > 0 && (
          <div className="chips">{ev.artifacts.map((a) => <span key={a} className="tag warn-tag"><TriangleAlert size={12} aria-hidden />Artifact: {a}</span>)}</div>
        )}
      </section>

      {calibrated.length > 0 && (
        <section className="sub" aria-labelledby="ev-cal">
          <div className="sub-head">
            <h3 id="ev-cal">Calibrated tissue evidence</h3>
            <InfoTip label="About calibrated bars">
              Calibrated on labelled tiles: 0–100% is how often tiles with this score carried the label in the calibration set.
            </InfoTip>
          </div>
          <div className="bars">{calibrated.map((f) => <Bar key={f.id} f={f} onJump={onJump} />)}</div>
        </section>
      )}

      {textOnly.length > 0 && (
        <section className="sub">
          <button type="button" className="disclosure" aria-expanded={showText} onClick={() => setShowText(!showText)}>
            {showText ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            Text-prompt similarity <span className="tag warn-tag">unvalidated</span> <span className="muted num">({textOnly.length})</span>
          </button>
          {showText && (
            <>
              <p className="xs muted">
                Similarity between the tile and a text description. Not calibrated and not a probability; some prompts
                (e.g. mucus, glands, smooth muscle) describe colon tissue and are not specific to lymph node.
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
