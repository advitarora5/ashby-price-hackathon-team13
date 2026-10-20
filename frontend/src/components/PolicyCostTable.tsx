import type { PolicySummary } from '../types'

const POLICY_NAMES: Record<string, string> = {
  single: '1 resident',
  double_arbitrated: '2 residents (+3rd on disagreement)',
  majority_3: 'Majority of 3',
  majority_5: 'Majority of 5',
  majority_7: 'Majority of 7',
  ai_supported: 'AI as supporting reader',
  random_skip: 'Random skip (control)',
}

/** What each reader policy costs vs. how well it agrees with the expert reference (real saved runs only). */
export default function PolicyCostTable({ summary, compact }: { summary: PolicySummary | null; compact?: boolean }) {
  if (!summary) return <p className="small muted">Loading policy results…</p>
  if (!summary.available) return <p className="small muted">{summary.reason ?? 'Policy results unavailable.'}</p>
  return (
    <>
      <div className="table-scroll">
        <table className={`data-table wrap-head ${compact ? "dense" : ""}`}>
          <caption className="sr-only">Human reads per 100 cases and agreement with the expert reference, by reader policy</caption>
          <thead>
            <tr>
              <th scope="col">Policy</th>
              <th scope="col" className="align-right">Human reads / 100 cases</th>
              <th scope="col" className="align-right">Agreement (95% CI)</th>
              {!compact && <th scope="col" className="align-right">QWK</th>}
              {!compact && <th scope="col" className="align-right">Non-inferior to double reading</th>}
            </tr>
          </thead>
          <tbody>
            {summary.runs.map((r) => (
              <tr key={r.run_id} className={r.policy === 'ai_supported' ? 'is-selected' : ''}>
                <td>{POLICY_NAMES[r.policy] ?? r.policy}</td>
                <td className="align-right num">{r.reads_per_100.toFixed(0)}</td>
                <td className="align-right num">{(r.agreement * 100).toFixed(1)}% <span className="muted">({(r.ci_low * 100).toFixed(1)}–{(r.ci_high * 100).toFixed(1)})</span></td>
                {!compact && <td className="align-right num">{r.kappa.toFixed(3)}</td>}
                {!compact && <td className="align-right">{r.noninferior === null ? '—' : r.noninferior ? 'Yes' : 'No'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted table-note">
        {summary.dataset}: {summary.n_patches} patches, {summary.n_slides} slides, bootstrap by slide.{' '}
        {summary.ai_source?.startsWith('unavailable')
          ? 'AI-supported rows appear once prostate-probe predictions are exported; they are never simulated.'
          : summary.ai_source ? `AI: ${summary.ai_source}.` : ''}
        {!compact && ' QWK = quadratic-weighted Cohen’s kappa.'}
      </p>
    </>
  )
}
