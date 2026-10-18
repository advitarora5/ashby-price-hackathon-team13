import { CircleCheck, CircleMinus, CircleX, UserCheck, Users } from 'lucide-react'
import type { Decision, PolicyRec, PolicySummary } from '../types'
import { Button } from './ui/Button'

interface Props {
  rec: PolicyRec | null
  summary: PolicySummary | null
  tierSlow: boolean
  routingSignal: string
  onSecondRead: (stage: 'second_reader' | 'third_reader', d: Decision) => void
}

const SUGGESTION: Record<string, string> = {
  one_read: 'One human read looks sufficient',
  second_read: 'A second human read is suggested',
  third_read: 'Readers disagree: a third human reader should resolve it',
  complete: 'Human readers have resolved the case',
}

/** Check labels. models_agree is derived server-side from the routing tier (fast path), so it is worded that way. */
const CHECKS: Record<string, string> = {
  reader_ai_agree: 'Your call and the AI flag agree',
  models_agree: 'Fast-path case (routing signal below cut-off)',
  light_green: 'No high-scoring unviewed tissue',
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default function PolicyPanel({ rec, summary, tierSlow, routingSignal, onSecondRead }: Props) {
  const stage = rec?.suggestion === 'third_read' ? 'third_reader' : 'second_reader'
  return (
    <section className="side-panel" aria-labelledby="pol-title">
      <div className="side-panel-head">
        <h2 id="pol-title">Additional reader</h2>
        <span className="muted xs">is another human read worth it?</span>
      </div>
      {!rec && (
        <p className="small muted">
          {tierSlow ? `Slow path: this case ranks high on ${routingSignal === 'entropy' ? 'model uncertainty' : 'model disagreement'}. ` : ''}
          A recommendation appears after you record an assessment.
        </p>
      )}
      {rec && (
        <>
          <div className={`rec ${rec.one_read_enough ? 'ok' : 'more'}`}>
            {rec.one_read_enough ? <UserCheck size={16} aria-hidden /> : <Users size={16} aria-hidden />}
            <strong>{SUGGESTION[rec.suggestion] ?? rec.suggestion}</strong>
          </div>
          <ul className="checks">
            {Object.entries(rec.checks).map(([k, v]) => {
              const Icon = v === null ? CircleMinus : v ? CircleCheck : CircleX
              return (
                <li key={k} className={v === null ? 'na' : v ? 'pass' : 'fail'}>
                  <Icon size={14} aria-hidden />
                  <span>{CHECKS[k] ?? k}</span>
                  <span className="sr-only">: {v === null ? 'not available' : v ? 'yes' : 'no'}</span>
                </li>
              )
            })}
          </ul>
          {rec.reasons.length > 0 && !rec.one_read_enough && <p className="small">{rec.reasons.join('; ')}.</p>}
          <p className="xs muted">AI flag: {rec.ai_flag_source}</p>
          {(rec.suggestion === 'second_read' || rec.suggestion === 'third_read') && (
            <div className="second">
              <span className="small">Record the {stage === 'second_reader' ? 'second' : 'third'} human reader's call:</span>
              <div className="btn-row">
                {(['benign', 'suspicious', 'malignant'] as Decision[]).map((d) => (
                  <Button key={d} size="sm" onClick={() => onSecondRead(stage, d)}>{cap(d)}</Button>
                ))}
              </div>
              <p className="xs muted">The AI never breaks a tie between human readers.</p>
            </div>
          )}
          <p className="xs muted">{rec.disclaimer}</p>
        </>
      )}
      <p className="xs muted">
        {summary?.available ? `What each reader policy costs (${summary.dataset ?? 'CrowdGleason'}, ${summary.runs.length} policies): ` : ''}
        <a href="#/research">see Research Insights</a>.
      </p>
    </section>
  )
}
