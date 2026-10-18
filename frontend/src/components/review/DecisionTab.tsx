import { useState } from 'react'
import { Check, CircleCheck, CircleMinus, CircleX, UserCheck, Users } from 'lucide-react'
import type { Decision, PolicyRec, Read, Signout } from '../../types'
import { STEPS, currentStep, type WorkflowState } from '../../lib/workflow'
import { LIGHT, statusOf } from '../../lib/status'
import { Button } from '../ui/Button'

interface Props {
  wf: WorkflowState
  read: Read | null
  signout: Signout | null
  rec: PolicyRec | null
  tierSlow: boolean
  routingSignal: string
  extraReads: { stage: string; decision: Decision }[]
  onSecondRead: (stage: 'second_reader' | 'third_reader', d: Decision) => Promise<void>
}

const SUGGESTION: Record<string, string> = {
  one_read: 'One human read looks sufficient',
  second_read: 'A second human read is suggested',
  third_read: 'Readers disagree: a third human reader should resolve it',
  complete: 'Human readers have resolved the case',
}

/** models_agree is derived server-side from the routing tier (fast path), so it is worded that way. */
const CHECKS: Record<string, string> = {
  reader_ai_agree: 'Your call and the AI flag agree',
  models_agree: 'Fast-path case (routing signal below the cut-off)',
  light_green: 'No high-scoring unviewed tissue',
}
/**
 * The backend's model-agreement check is derived from the routing tier, and the tier now comes from
 * model uncertainty, so reword that one reason honestly. Other reasons are shown as returned.
 */
const reword = (r: string, signal: string) =>
  r === 'the AI models disagree on this case (slow path)' && signal === 'entropy' ? 'slow-path case (high model uncertainty)'
    : r.replace(/\(light (\w+)\)/, (_, l) => `(sign-out check: ${l})`)

const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—')
const DECISIONS: Decision[] = ['benign', 'suspicious', 'malignant']

export default function DecisionTab({ wf, read, signout, rec, tierSlow, routingSignal, extraReads, onSecondRead }: Props) {
  const cur = currentStep(wf)
  const stage = rec?.suggestion === 'third_read' ? 'third_reader' : 'second_reader'
  const [pick, setPick] = useState<Decision | null>(null)
  const light = signout ? statusOf(LIGHT, signout.light) : null
  return (
    <div className="tab-stack">
      <section className="sub" aria-labelledby="dc-steps">
        <div className="sub-head"><h3 id="dc-steps">Review workflow</h3></div>
        <ol className="stepper">
          {STEPS.map((s, i) => {
            const state = i < cur || (i === 5 && cur === 5) ? 'done' : i === cur ? 'current' : 'todo'
            return (
              <li key={s.id} className={`step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="step-dot" aria-hidden>{state === 'done' ? <Check size={12} /> : i + 1}</span>
                <span className="step-label">{s.label}</span>
                <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="sub" aria-labelledby="dc-outcome">
        <div className="sub-head"><h3 id="dc-outcome">Research outcome so far</h3></div>
        <dl className="kv">
          <div><dt>Review mode</dt><dd>{read ? (read.review_mode === 'blind' ? 'Blind-first' : 'Evidence-first') : '—'}</dd></div>
          <div><dt>Initial assessment</dt><dd>{cap(read?.initial_decision)}</dd></div>
          <div><dt>Unseen-tissue check</dt><dd>{light ? light.label : 'Not run'}</dd></div>
          <div><dt>Final call</dt><dd>{read?.final_decision ? <>{cap(read.final_decision)}{read.initial_decision && read.initial_decision !== read.final_decision ? <span className="muted"> (revised)</span> : null}</> : '—'}</dd></div>
          {extraReads.map((x) => <div key={x.stage}><dt>{x.stage === 'second_reader' ? 'Second reader' : 'Third reader'}</dt><dd>{cap(x.decision)}</dd></div>)}
        </dl>
        <p className="xs muted">A research record only. This is not a clinical sign-out and is not part of any patient report.</p>
      </section>

      <section className="sub" aria-labelledby="dc-reader">
        <div className="sub-head"><h3 id="dc-reader">Additional reader</h3></div>
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
                    <Icon size={14} aria-hidden /><span>{CHECKS[k] ?? k}</span>
                    <span className="check-val">{v === null ? 'n/a' : v ? 'yes' : 'no'}</span>
                  </li>
                )
              })}
            </ul>
            {rec.reasons.length > 0 && !rec.one_read_enough && <p className="small">Why: {rec.reasons.map((r) => reword(r, routingSignal)).join('; ')}.</p>}
            <p className="xs muted">AI case flag: {rec.ai_flag_source.replace('max smoothed tumour risk >=', 'highest smoothed probe score ≥').replace('(default_unvalidated)', '(default cut-off, not validated)')}</p>
            {(rec.suggestion === 'second_read' || rec.suggestion === 'third_read') && (
              <div className="second">
                <span className="small">Record the {stage === 'second_reader' ? 'second' : 'third'} human reader’s call:</span>
                <div className="btn-row" role="group" aria-label="Additional reader's call">
                  {DECISIONS.map((d) => (
                    <Button key={d} size="sm" aria-pressed={pick === d} onClick={() => setPick(d)}>{cap(d)}</Button>
                  ))}
                </div>
                <Button size="sm" variant="primary" disabled={!pick} onClick={async () => { if (pick) { await onSecondRead(stage, pick); setPick(null) } }}>
                  Record {stage === 'second_reader' ? 'second' : 'third'} reader{pick ? `: ${cap(pick)}` : ''}
                </Button>
                <p className="xs muted">The AI never breaks a tie between human readers.</p>
              </div>
            )}
            <p className="xs muted">{rec.disclaimer} Reader-policy costs: <a href="#/research">Research Insights</a>.</p>
          </>
        )}
      </section>
    </div>
  )
}
