import { CircleCheck, CircleHelp, CircleMinus, Crosshair, GitCompareArrows, Lock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CaseDetail, Evidence, Rect, Region } from '../../types'
import type { Tone } from '../../lib/status'
import { score } from '../../lib/format'
import { Button } from '../ui/Button'

interface Props {
  detail: CaseDetail
  ev: Evidence | null
  disputed: Region[]
  cohortRank: { rank: number; of: number } | null
  evalResult: { disagreement: string; entropy: string | null; status: string } | null
  onJump: (r: Rect, what: string) => void
  disagreementLayer: boolean
  onToggleLayer: (on: boolean) => void
  activeTarget: string | null
}

/** Tile disagreement percentile at which the two models are said to disagree: the same top-15% band the queue uses. */
const DISAGREE_AT = 0.85

interface Verdict { label: string; tone: Tone; icon: LucideIcon; detail: string }

/** Agree / disagree / insufficient / unavailable, from the tile's actual disagreement data (never from the tier). */
function tileVerdict(ev: Evidence): Verdict {
  if (ev.disagreement === null) {
    if (ev.artifacts.length) return { label: 'Insufficient information', tone: 'neutral', icon: CircleHelp, detail: `This tile is flagged as an artifact (${ev.artifacts.join(', ')}), so disagreement is not computed.` }
    return { label: 'Unavailable', tone: 'neutral', icon: CircleMinus, detail: 'No disagreement value for this tile.' }
  }
  const p = Math.round(ev.disagreement * 100)
  if (ev.disagreement >= DISAGREE_AT) return { label: 'Models disagree', tone: 'warning', icon: GitCompareArrows, detail: `More disagreement than ${p}% of reference tiles (top-15% band).` }
  return { label: 'Models broadly agree', tone: 'success', icon: CircleCheck, detail: `Disagreement at the ${p}th percentile of reference tiles (below the top-15% band).` }
}

const models = (src: string | null) => src?.match(/\(([^)]+)\)/)?.[1].split(',').map((m) => m.trim()).map((m) => (m === 'plip' ? 'PLIP' : m === 'quiltnet' ? 'QuiltNet' : m)) ?? []

export default function ModelTab({ detail, ev, disputed, cohortRank, evalResult, onJump, disagreementLayer, onToggleLayer, activeTarget }: Props) {
  if (!ev || ev.hidden) {
    return (
      <div className="locked">
        <Lock size={18} aria-hidden />
        <div><strong>Model comparison hidden until you record your assessment</strong><p className="small">It is AI output, so blind-first hides it too.</p></div>
      </div>
    )
  }
  const v = tileVerdict(ev)
  const names = models(detail.disagreement_source)
  return (
    <div className="tab-stack">
      <section className="sub" aria-labelledby="mc-tile">
        <div className="sub-head"><h3 id="mc-tile">Selected tile <span className="mono muted">{ev.tile_id?.split(':')[1] ?? '—'}</span></h3></div>
        <div className={`verdict tone-${v.tone}`}><v.icon size={16} aria-hidden /><div><strong>{v.label}</strong><div className="small">{v.detail}</div></div></div>
        <p className="xs muted">
          Compares {names.length === 2 ? `${names[0]} and ${names[1]}` : 'two pathology models'} on this tile. The “disagree” band is the same
          top-15% convention the queue uses; it is not a validated threshold.
        </p>
      </section>

      <section className="sub" aria-labelledby="mc-case">
        <div className="sub-head"><h3 id="mc-case">This case</h3></div>
        <dl className="kv">
          <div><dt>Case disagreement (90th-percentile tile rank)</dt><dd className="num">{score(detail.disagreement_score)}{cohortRank && <span className="muted"> · #{cohortRank.rank} of {cohortRank.of}</span>}</dd></div>
          <div><dt>Model uncertainty (routing signal)</dt><dd className="num">{score(detail.uncertainty_score)}</dd></div>
        </dl>
        {evalResult && (
          <p className="xs muted">
            {evalResult.status === 'fail' && evalResult.entropy
              ? <>In evaluation, disagreement found fewer of the model’s errors than single-model uncertainty ({evalResult.disagreement} vs {evalResult.entropy} in the top 15%), so it is shown for context and does not route cases.</>
              : <>Evaluation: {evalResult.disagreement} of model errors in the top 15% most-disputed tiles.</>}
          </p>
        )}
      </section>

      <section className="sub" aria-labelledby="mc-reg">
        <div className="sub-head">
          <h3 id="mc-reg">Most disputed regions</h3>
          <label className="inline-check small"><input type="checkbox" checked={disagreementLayer} onChange={(e) => onToggleLayer(e.target.checked)} /> Show on slide</label>
        </div>
        {disputed.length === 0 ? <p className="small muted">No disputed regions for this case.</p> : (
          <div className="region-list">
            {disputed.slice(0, 5).map((r) => (
              <button type="button" key={r.region_id} className={`region-item disputed ${activeTarget === r.region_id ? 'is-active' : ''}`}
                onClick={() => onJump(r, `disputed:${r.region_id}`)}>
                <span className="num">#{r.rank}</span><span className="num">rank {score(r.disagreement ?? r.risk)}</span><span className="muted num">{r.n_tiles} tiles</span>
              </button>
            ))}
          </div>
        )}
        {disputed[0] && <Button size="sm" variant="ghost" icon={Crosshair} onClick={() => onJump(disputed[0], `disputed:${disputed[0].region_id}`)}>Go to most disputed</Button>}
      </section>
    </div>
  )
}
