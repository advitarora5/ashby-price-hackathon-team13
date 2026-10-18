import { TriangleAlert } from 'lucide-react'
import type { CaseRow } from '../../types'
import { href } from '../../lib/router'
import { ARTIFACT_FLAG, REVIEW_STATUS, TIER, routingScore, statusOf } from '../../lib/status'
import { pct, score } from '../../lib/format'

interface Props {
  cases: CaseRow[]; selected: string | null; onSelect: (id: string) => void; error: string | null
  /** Hide model scores for this case (blind read awaiting the initial call). */
  maskScoresFor?: string | null
}

/** Compact case list docked left of the viewer. The routing signal is the primary number; disagreement is secondary. */
export default function CaseQueue({ cases, selected, onSelect, error, maskScoresFor }: Props) {
  const entropy = cases[0]?.routing_signal === 'entropy'
  return (
    <div className="queue">
      <div className="queue-head">
        <h2>Cases <span className="muted num">{cases.length}</span></h2>
        <span className="muted xs">by {entropy ? 'model uncertainty' : 'model disagreement'}</span>
      </div>
      {error && <div className="notice warn"><TriangleAlert size={14} aria-hidden />{error}</div>}
      {!error && cases.length === 0 && <div className="notice">No cases in the bundle yet. Run the pipeline (see README).</div>}
      <ul className="queue-list">
        {cases.map((c) => {
          const st = statusOf(REVIEW_STATUS, c.review_status)
          const tier = statusOf(TIER, c.tier)
          const StIcon = st.icon
          const TierIcon = tier.icon
          const routing = routingScore(c)
          const masked = maskScoresFor === c.case_id
          return (
            <li key={c.case_id}>
              <a href={href({ page: 'review', caseId: c.case_id })} className={`queue-item ${selected === c.case_id ? 'is-selected' : ''}`}
                aria-current={selected === c.case_id ? 'true' : undefined}
                onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onSelect(c.case_id) }}>
                <span className="qi-row">
                  <span className="mono strong">{c.slide_id}</span>
                  <span className={`qi-tier tone-${tier.tone}`}><TierIcon size={12} aria-hidden />{tier.label}</span>
                </span>
                <span className="qi-row qi-meta">
                  <span className={`qi-status tone-${st.tone}`}><StIcon size={12} aria-hidden />{st.label}</span>
                  {masked ? <span className="muted">scores hidden until your call</span> : (
                    <span className="num" title={entropy ? 'Model uncertainty (routing signal), 0–1' : 'Model disagreement, 0–1'}>
                      {entropy ? 'Uncertainty' : 'Disagreement'} {score(routing)}
                    </span>
                  )}
                </span>
                {!masked && <span className="qi-bar" aria-hidden><span style={{ width: `${(routing ?? 0) * 100}%` }} /></span>}
                {entropy && !masked && <span className="qi-row qi-sub num">Disagreement {score(c.disagreement_score)}</span>}
                {c.artifact_share !== null && c.artifact_share > ARTIFACT_FLAG && (
                  <span className="qi-row qi-sub warn-text"><span><TriangleAlert size={12} aria-hidden /> Artifacts on {pct(c.artifact_share)} of tiles</span></span>
                )}
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
