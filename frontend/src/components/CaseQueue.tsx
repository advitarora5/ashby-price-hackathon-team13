import type { CaseRow } from '../types'

interface Props { cases: CaseRow[]; selected: string | null; onSelect: (id: string) => void; error: string | null }

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}`)

export default function CaseQueue({ cases, selected, onSelect, error }: Props) {
  return (
    <aside className="queue">
      <div className="panel-head">
        <h2>Case queue</h2>
        <span className="muted small">sorted by {cases[0]?.routing_signal === 'entropy' ? 'model uncertainty' : 'model disagreement'}</span>
      </div>
      {error && <div className="notice warn">{error}</div>}
      {!error && cases.length === 0 && <div className="notice">No cases in the bundle yet. Run the pipeline (see README).</div>}
      <ul>
        {cases.map((c) => (
          <li key={c.case_id}>
            <button className={`case ${selected === c.case_id ? 'sel' : ''}`} onClick={() => onSelect(c.case_id)}>
              <div className="case-top">
                <span className="case-id">{c.slide_id}</span>
                <span className={`chip tier-${c.tier}`}>{c.tier === 'unavailable' ? 'no tier' : `${c.tier} path`}</span>
              </div>
              <div className="case-meta">
                <span>{c.organ.replace('_', ' ')}</span>
                <span className={`status st-${c.review_status}`}>{c.review_status.replace('_', ' ')}</span>
              </div>
              <div className="dis" title={c.disagreement_source ?? 'disagreement unavailable'}>
                <div className="dis-track"><div className="dis-fill" style={{ width: `${(c.disagreement_score ?? 0) * 100}%` }} /></div>
                <span className="small muted">disagreement {pct(c.disagreement_score)}{c.routing_signal === 'entropy' ? ` · uncertainty ${pct(c.uncertainty_score)}` : ''}</span>
              </div>
              {c.tier_reasons.includes('artifacts') ? (
                <div className="small warn-text">slow path: damaged tissue ({pct(c.tissue_artifact_share)}% of tissue)</div>
              ) : c.artifact_share !== null && c.artifact_share > 0.05 && (
                <div className="small warn-text">artifacts on {pct(c.artifact_share)}% of tiles</div>
              )}
            </button>
          </li>
        ))}
      </ul>
      {cases[0]?.routing_signal === 'entropy' && (
        <p className="foot muted small">Model disagreement did not beat single-model uncertainty in evaluation, so tiers use uncertainty (disagreement still shown).</p>
      )}
      {cases.some((c) => c.tier_reasons.includes('artifacts')) && (
        <p className="foot muted small">Cases with blur, ink or folds on 10% or more of their tissue also go to the slow path.</p>
      )}
      {cases.some((c) => c.tier_rule === 'rank_top15') && (
        <p className="foot muted small">Tier cut-off: top 15% by rank (no validation-derived cut-off yet).</p>
      )}
    </aside>
  )
}
