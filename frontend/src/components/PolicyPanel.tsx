import type { Decision, PolicyRec, PolicySummary } from '../types'

interface Props {
  rec: PolicyRec | null
  summary: PolicySummary | null
  tierSlow: boolean
  onSecondRead: (stage: 'second_reader' | 'third_reader', d: Decision) => void
}

const SUGGESTION: Record<string, string> = {
  one_read: 'One human read looks sufficient',
  second_read: 'A second human read is suggested',
  third_read: 'Readers disagree: a third human reader should resolve it',
  complete: 'Human readers have resolved the case',
}

const NAMES: Record<string, string> = {
  single: '1 resident',
  double_arbitrated: '2 residents (+3rd on disagreement)',
  majority_3: 'majority of 3',
  majority_5: 'majority of 5',
  majority_7: 'majority of 7',
  ai_supported: 'AI as supporting reader',
  random_skip: 'random skip (control)',
}

const CHECKS: Record<string, string> = {
  reader_ai_agree: 'Reader and AI agree',
  models_agree: 'AI models agree',
  light_green: 'No risky unviewed tissue',
}

export default function PolicyPanel({ rec, summary, tierSlow, onSecondRead }: Props) {
  const stage = rec?.suggestion === 'third_read' ? 'third_reader' : 'second_reader'
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Review policy</h3>
        <span className="muted small">is a second human read worth it?</span>
      </div>
      {!rec && <p className="small muted">{tierSlow ? 'Slow path: models disagree on this case. ' : ''}A recommendation appears after you record an assessment.</p>}
      {rec && (
        <>
          <div className={`rec ${rec.one_read_enough ? 'ok' : 'more'}`}><strong>{SUGGESTION[rec.suggestion]}</strong></div>
          <ul className="checks">
            {Object.entries(rec.checks).map(([k, v]) => (
              <li key={k} className={v === null ? 'na' : v ? 'pass' : 'fail'}>
                <span>{v === null ? '–' : v ? '✓' : '✕'}</span>{CHECKS[k] ?? k}
              </li>
            ))}
          </ul>
          {rec.reasons.length > 0 && !rec.one_read_enough && <p className="small">{rec.reasons.join('; ')}.</p>}
          <p className="small muted">{rec.ai_flag_source}</p>
          {(rec.suggestion === 'second_read' || rec.suggestion === 'third_read') && (
            <div className="second">
              <span className="small">Record the {stage === 'second_reader' ? 'second' : 'third'} human reader's call:</span>
              <div className="btn-row">
                {(['benign', 'suspicious', 'malignant'] as Decision[]).map((d) => (
                  <button key={d} className="btn small" onClick={() => onSecondRead(stage, d)}>{d}</button>
                ))}
              </div>
              <p className="small muted">The AI never breaks a tie between human readers.</p>
            </div>
          )}
          <p className="small muted">{rec.disclaimer}</p>
        </>
      )}
      <div className="eff">
        <div className="small muted">What each policy costs (CrowdGleason prostate test set, expert reference)</div>
        {!summary?.available && <p className="small muted">{summary?.reason ?? 'Loading…'}</p>}
        {summary?.available && (
          <>
            <table>
              <thead><tr><th>Policy</th><th>Human reads / 100</th><th>Agreement (95% CI)</th></tr></thead>
              <tbody>
                {summary.runs.map((r) => (
                  <tr key={r.run_id} className={r.policy === 'ai_supported' ? 'hl' : ''}>
                    <td>{NAMES[r.policy] ?? r.policy}</td>
                    <td>{r.reads_per_100.toFixed(0)}</td>
                    <td>{(r.agreement * 100).toFixed(1)}% <span className="muted">({(r.ci_low * 100).toFixed(1)}–{(r.ci_high * 100).toFixed(1)})</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              {summary.n_patches} patches, {summary.n_slides} slides, bootstrap by slide. {summary.ai_source?.startsWith('unavailable')
                ? 'AI-supported rows appear once prostate-probe predictions are exported; they are never simulated.'
                : `AI: ${summary.ai_source}.`}
            </p>
          </>
        )}
      </div>
    </section>
  )
}
