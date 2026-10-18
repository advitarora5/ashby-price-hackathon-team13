import { Crosshair, Lock, TriangleAlert, Info } from 'lucide-react'
import type { Evidence, Rect, Region } from '../types'
import { pct, score } from '../lib/format'
import Exemplars from './Exemplars'
import InfoTip from './ui/InfoTip'

interface Props {
  ev: Evidence | null
  loading: boolean
  evidenceRegions: Region[]
  disputed: Region[]
  onJump: (r: Rect, what: string) => void
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

export default function EvidencePanel({ ev, loading, evidenceRegions, disputed, onJump }: Props) {
  return (
    <section className="side-panel" aria-labelledby="ev-title">
      <div className="side-panel-head">
        <h2 id="ev-title">Evidence</h2>
        <span className="muted xs">what the AI flags, and where</span>
      </div>
      {loading && <p className="muted small">Loading evidence…</p>}
      {ev?.hidden && (
        <div className="locked">
          <Lock size={18} aria-hidden />
          <div>
            <strong>AI evidence hidden</strong>
            <p className="small">{ev.hidden_reason}</p>
          </div>
        </div>
      )}
      {ev && !ev.hidden && (
        <>
          {ev.notes.map((n) => <div key={n} className="notice"><Info size={14} aria-hidden />{n}</div>)}
          <div className="tile-head">
            <span className="small muted">Tile {ev.tile_id?.split(':')[1] ?? '—'} · click the slide to inspect another tile</span>
            {ev.tile_rect && <button type="button" className="link-btn small" onClick={() => onJump(ev.tile_rect!, 'tile')}>Go to tile</button>}
          </div>
          <dl className="kv">
            <div>
              <dt>
                Tumour probe score (tile, smoothed)
                <InfoTip label="About the tumour probe score">
                  Output of a linear probe on foundation-model tile embeddings. It is uncalibrated: a relative 0–1 score, not the
                  probability that the tile contains tumour.{ev.tumor_prob_source ? <><br /><br />Source: {ev.tumor_prob_source}</> : null}
                </InfoTip>
              </dt>
              <dd className="num">{ev.tumor_prob === null ? 'Unavailable' : score(ev.tumor_prob)}</dd>
            </div>
            <div>
              <dt>
                Model disagreement rank
                <InfoTip label="About the disagreement rank">
                  Percentile of this tile's disagreement between two pathology models, compared with reference training tiles.
                  Higher = the models disagree more than usual. Not used for routing.
                </InfoTip>
              </dt>
              <dd className="num">{ev.disagreement === null ? (ev.artifacts.length ? 'Excluded (artifact)' : 'Unavailable') : `${ordinal(Math.round(ev.disagreement * 100))} percentile`}</dd>
            </div>
          </dl>
          {ev.artifacts.length > 0 && (
            <div className="chips">{ev.artifacts.map((a) => <span key={a} className="tag warn-tag"><TriangleAlert size={12} aria-hidden />{a}</span>)}</div>
          )}
          <div className="bars">
            {ev.features.map((f) => (
              <div key={f.id} className="bar-row">
                <div className="bar-label">
                  <span>{f.label}</span>
                  {f.badge && <span className={`tag ${f.calibrated ? 'info-tag' : 'warn-tag'}`}>{f.badge}</span>}
                </div>
                <div className="bar-line">
                  {f.calibrated && f.value !== null ? (
                    <div className="bar-track"><div className="bar-fill" style={{ width: pct(f.value) }} /></div>
                  ) : (
                    <div className="bar-track" title="Text-prompt similarity: not a probability">
                      <div className="bar-fill hatched" style={{ width: pct(f.raw ?? 0) }} />
                    </div>
                  )}
                  <span className="bar-val num">{f.calibrated && f.value !== null ? pct(f.value) : 'text only'}</span>
                  {f.jump_links.length > 0 ? (
                    <button type="button" className="link-btn small" aria-label={`Show strongest tiles for ${f.label}`}
                      onClick={() => onJump(f.jump_links[0], `jump:${f.id}`)}><Crosshair size={12} aria-hidden /> Where</button>
                  ) : <span />}
                </div>
              </div>
            ))}
          </div>
          <p className="xs muted">
            Solid bars are calibrated on labelled tiles (0–100% = how often tiles with this score carry the label).
            Hatched bars are text-prompt similarity only and are not validated.
          </p>
          <Exemplars ex={ev.exemplars} />
          {evidenceRegions.length > 0 && (
            <div className="region-list">
              <div className="xs muted strong">Highest-scoring regions</div>
              {evidenceRegions.slice(0, 5).map((r) => (
                <button type="button" key={r.region_id} className="region-item" onClick={() => onJump(r, `region:${r.region_id}`)}>
                  <span className="num">#{r.rank}</span><span className="num">score {score(r.risk)}</span><span className="muted num">{r.n_tiles} tiles</span>
                </button>
              ))}
            </div>
          )}
          {disputed.length > 0 && (
            <div className="region-list">
              <div className="xs muted strong">Most disputed regions (models disagree)</div>
              {disputed.slice(0, 3).map((r) => (
                <button type="button" key={r.region_id} className="region-item disputed" onClick={() => onJump(r, `disputed:${r.region_id}`)}>
                  <span className="num">#{r.rank}</span><span className="num">rank {score(r.risk)}</span><span className="muted num">{r.n_tiles} tiles</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
