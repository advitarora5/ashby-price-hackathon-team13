import { useState } from 'react'
import type { Evidence, FeatureReview, Rect, Region, Verdict } from '../types'
import Exemplars from './Exemplars'

interface Props {
  ev: Evidence | null
  loading: boolean
  evidenceRegions: Region[]
  disputed: Region[]
  onJump: (r: Rect, what: string) => void
  reviews: FeatureReview[] | null   // null: this read cannot record verdicts (no live read, or AI still hidden)
  reviewKey: string
  onReview: (feature: string, verdict: Verdict, note: string) => void
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const VERDICTS: Verdict[] = ['agree', 'disagree', 'unsure']

function FeatureVerdict({ feature, review, onReview }: { feature: string; review?: FeatureReview; onReview: Props['onReview'] }) {
  const [note, setNote] = useState(review?.note ?? '')
  const saveNote = () => { if (review && note.trim() !== (review.note ?? '')) onReview(feature, review.verdict, note) }
  return (
    <div className="verdict-row">
      <div className="seg" role="group" aria-label="your verdict">
        {VERDICTS.map((v) => (
          <button key={v} className={`seg-btn v-${v} ${review?.verdict === v ? 'on' : ''}`} aria-pressed={review?.verdict === v}
            onClick={() => onReview(feature, v, note)}>{v}</button>
        ))}
      </div>
      <input className="verdict-note" value={note} placeholder={review ? 'note (optional)' : 'pick a verdict, then add a note'}
        onChange={(e) => setNote(e.target.value)} onBlur={saveNote}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </div>
  )
}

export default function EvidencePanel({ ev, loading, evidenceRegions, disputed, onJump, reviews, reviewKey, onReview }: Props) {
  const byFeature = new Map((reviews ?? []).map((r) => [r.feature_id, r]))
  const left = reviews ? (ev?.features ?? []).filter((f) => !byFeature.has(f.id)).length : 0
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Evidence</h3>
        <span className="muted small">what the AI sees, and where</span>
      </div>
      {loading && <p className="muted small">Loading…</p>}
      {ev?.hidden && (
        <div className="locked">
          <div className="lock-icon" aria-hidden>🔒</div>
          <div>
            <strong>AI evidence hidden</strong>
            <p className="small">{ev.hidden_reason}</p>
          </div>
        </div>
      )}
      {ev && !ev.hidden && (
        <>
          {ev.notes.map((n) => <div key={n} className="notice">{n}</div>)}
          <div className="tile-head">
            <span className="small muted">Tile {ev.tile_id?.split(':')[1] ?? '—'} · click the slide to inspect another tile</span>
            {ev.tile_rect && <button className="link" onClick={() => onJump(ev.tile_rect!, 'tile')}>go to tile</button>}
          </div>
          <div className="kv">
            <span>Tumour risk (smoothed, tile)</span>
            <b>{ev.tumor_prob === null ? 'unavailable' : pct(ev.tumor_prob)}</b>
          </div>
          {ev.tumor_prob_source && <div className="small muted src">{ev.tumor_prob_source}</div>}
          <div className="kv"><span>Model disagreement (percentile)</span>
            <b>{ev.disagreement === null ? (ev.artifacts.length ? 'excluded (artifact)' : 'unavailable') : pct(ev.disagreement)}</b></div>
          {ev.artifacts.length > 0 && (
            <div className="chips">{ev.artifacts.map((a) => <span key={a} className={`chip art art-${a}`}>⚠ {a}</span>)}</div>
          )}
          {reviews && ev.features.length > 0 && (
            <div className={`small ${left ? 'warn-text' : 'ok-text'} verdict-head`}>
              {left ? `Your verdict on each feature for the whole slide: ${left} of ${ev.features.length} left` : 'All features reviewed'}
              <span className="muted"> · bars show the selected tile</span>
            </div>
          )}
          <div className="bars">
            {ev.features.map((f) => (
              <div key={f.id} className="bar-row">
                <div className="bar-label">
                  <span>{f.label}</span>
                  {f.badge && <span className={`badge ${f.calibrated ? 'cross' : 'unval'}`}>{f.badge}</span>}
                </div>
                <div className="bar-line">
                  {f.calibrated && f.value !== null ? (
                    <div className="bar-track"><div className="bar-fill" style={{ width: pct(f.value) }} /></div>
                  ) : (
                    <div className="bar-track text-only" title="text prior: not a probability">
                      <div className="bar-fill hatched" style={{ width: pct(f.raw ?? 0) }} />
                    </div>
                  )}
                  <span className="bar-val">{f.calibrated && f.value !== null ? pct(f.value) : 'text'}</span>
                  {f.jump_links.length > 0 && (
                    <button className="link small" title="jump to the strongest tiles for this feature"
                      onClick={() => onJump(f.jump_links[0], `jump:${f.id}`)}>where ↗</button>
                  )}
                </div>
                {reviews && <FeatureVerdict key={`${reviewKey}:${f.id}`} feature={f.id} review={byFeature.get(f.id)} onReview={onReview} />}
              </div>
            ))}
          </div>
          <p className="small muted">
            Solid bars are calibrated on labelled tiles (0–100% = how often tiles with this score carry the label).
            Hatched bars are text-prompt similarity only and are not validated.
          </p>
          <Exemplars ex={ev.exemplars} />
          {evidenceRegions.length > 0 && (
            <div className="region-list">
              <div className="small muted">Highest-risk regions</div>
              {evidenceRegions.slice(0, 5).map((r) => (
                <button key={r.region_id} className="region-item" onClick={() => onJump(r, `region:${r.region_id}`)}>
                  <span>#{r.rank}</span><span>risk {pct(r.risk ?? 0)}</span><span className="muted">{r.n_tiles} tiles</span>
                </button>
              ))}
            </div>
          )}
          {disputed.length > 0 && (
            <div className="region-list">
              <div className="small muted">Most disputed regions (models disagree)</div>
              {disputed.slice(0, 3).map((r) => (
                <button key={r.region_id} className="region-item disputed" onClick={() => onJump(r, `disputed:${r.region_id}`)}>
                  <span>#{r.rank}</span><span>disagreement {pct(r.risk ?? 0)}</span><span className="muted">{r.n_tiles} tiles</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
