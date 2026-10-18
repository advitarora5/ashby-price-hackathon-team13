import { useState } from 'react'
import { Check, CircleCheck, CircleMinus, CircleX, Info, TriangleAlert, UserCheck, Users } from 'lucide-react'
import type { Decision, PolicyRec, Read, Signout } from '../../types'
import { STEPS, currentStep, type WorkflowState } from '../../lib/workflow'
import { LIGHT, statusOf } from '../../lib/status'
import { Button } from '../ui/Button'

interface Props {
  wf: WorkflowState
  read: Read | null
  latest: Signout | null
  alertCheck: Signout | null
  rec: PolicyRec | null
  tierSlow: boolean
  routingSignal: string
  confirmed: boolean
  priorExposure: string | null
  readOnly: boolean
  extraReads: { stage: string; decision: Decision }[]
  onSecondRead: (stage: 'second_reader' | 'third_reader', d: Decision) => Promise<void>
}

const SUGGESTION: Record<string, string> = {
  one_read: 'Policy rule: one human read is sufficient',
  second_read: 'A second human read is suggested',
  third_read: 'Readers disagree: a third human reader should resolve it',
  complete: 'Human readers have resolved the case',
}

/** models_agree is derived server-side from the routing tier (fast path), so it is worded that way. */
const CHECKS: Record<string, string> = {
  reader_ai_agree: 'Your final call and the AI case flag agree',
  models_agree: 'Fast-path case (routing signal below the cut-off)',
  light_green: 'No high-scoring unviewed tissue',
}

/**
 * The backend's reasons are shown, but the one derived from the routing tier is reworded because the
 * tier now comes from model uncertainty, not disagreement.
 */
const reword = (r: string, signal: string) =>
  r === 'the AI models disagree on this case (slow path)' && signal === 'entropy' ? 'slow-path case (high model uncertainty)'
    : r.replace(/\(light (\w+)\)/, (_, l) => `(sign-out check: ${l})`)

const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—')
const DECISIONS: Decision[] = ['benign', 'suspicious', 'malignant']

export default function DecisionTab({ wf, read, latest, alertCheck, rec, tierSlow, routingSignal, confirmed, priorExposure, readOnly, extraReads, onSecondRead }: Props) {
  const cur = readOnly ? 5 : currentStep(wf)
  const [pick, setPick] = useState<Decision | null>(null)
  const finalCall = confirmed || readOnly ? read?.final_decision ?? null : null
  const revised = !!(read?.initial_decision && finalCall && finalCall !== read.initial_decision)
  // the read became aided once the call was recorded, so any revision happened after viewing AI evidence
  const revisedAfterAI = revised && !!read
  const aiAgreeNow = rec?.checks.reader_ai_agree === true
  const towardAI = revisedAfterAI && aiAgreeNow
  const policyOne = rec?.suggestion === 'one_read'
  const showSecondReader = rec && (rec.suggestion === 'second_read' || rec.suggestion === 'third_read' || towardAI)
  const stage = rec?.suggestion === 'third_read' ? 'third_reader' : 'second_reader'
  // the policy ignores this gate for positive calls (core/policy.recommend), so show it as n/a, never as a failure
  const usedCall = finalCall ?? read?.initial_decision ?? null
  const lightNA = latest?.light === 'not_required' || (!!usedCall && usedCall !== 'benign')
  const revisitCount = alertCheck?.regions.filter((r) => r.alert_status === 'revisited').length ?? 0

  const checkSummary = alertCheck
    ? `${statusOf(LIGHT, alertCheck.light).label} (${alertCheck.regions.length} region${alertCheck.regions.length === 1 ? '' : 's'}; ${revisitCount} revisited)${revised ? ` → call revised to ${cap(finalCall)}` : ''}${latest && latest !== alertCheck && latest.light === 'not_required' ? '; re-check not required for a positive call' : ''}`
    : latest ? statusOf(LIGHT, latest.light).label : 'Not run'

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
        <div className="sub-head"><h3 id="dc-outcome">{cur === 5 ? 'Research outcome' : 'Research outcome so far'}</h3></div>
        {priorExposure && <div className="notice warn"><TriangleAlert size={14} aria-hidden /><span>{priorExposure}</span></div>}
        <dl className="kv">
          <div><dt>Review mode</dt><dd>{read ? (read.review_mode === 'blind' ? 'Blind-first' : 'Evidence-first') : '—'}</dd></div>
          <div><dt>{read?.review_mode === 'blind' ? 'Blind call' : 'Initial call'}</dt><dd>{cap(read?.initial_decision)}</dd></div>
          <div><dt>Unseen-tissue check</dt><dd className="dd-wrap">{checkSummary}</dd></div>
          <div><dt>Final call</dt><dd>{finalCall ? <>{cap(finalCall)}{revised ? <span className="muted"> (revised after viewing AI evidence)</span> : null}</> : '—'}</dd></div>
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
            {towardAI && policyOne ? (
              <div className="rec more">
                <Users size={16} aria-hidden />
                <div>
                  <strong>A second read is advisable</strong>
                  <div className="small">Your {read?.review_mode === 'blind' ? 'blind' : 'initial'} call ({read?.initial_decision}) differed from the AI flag and was revised to {finalCall} after viewing AI evidence. The policy rule counts the agreement, but it no longer reflects an independent read.</div>
                </div>
              </div>
            ) : (
              <div className={`rec ${rec.one_read_enough ? 'neutral' : 'more'}`}>
                {rec.one_read_enough ? <UserCheck size={16} aria-hidden /> : <Users size={16} aria-hidden />}
                <strong>{SUGGESTION[rec.suggestion] ?? rec.suggestion}</strong>
              </div>
            )}
            <ul className="checks">
              {Object.entries(rec.checks).map(([k, v]) => {
                const na = v === null || (k === 'light_green' && lightNA)
                const Icon = na ? CircleMinus : v ? CircleCheck : CircleX
                return (
                  <li key={k} className={na ? 'na' : v ? 'pass' : 'fail'}>
                    <Icon size={14} aria-hidden /><span>{CHECKS[k] ?? k}</span>
                    <span className="check-val">{na ? 'n/a' : v ? 'yes' : 'no'}</span>
                    {k === 'light_green' && lightNA && <span className="check-note xs muted">Not applicable: this gate only applies to benign calls.</span>}
                    {k === 'reader_ai_agree' && towardAI && <span className="check-note xs muted">Agreement reached by revising after viewing AI evidence.</span>}
                  </li>
                )
              })}
            </ul>
            <p className="small"><Info size={13} aria-hidden className="inline-icon" /> Why: {rec.reasons.length ? rec.reasons.map((r) => reword(r, routingSignal)).join('; ') : 'every applicable check passed'}.</p>
            <p className="xs muted">AI case flag: {rec.ai_flag_source.replace('max smoothed tumour risk >=', 'highest smoothed probe score ≥').replace('(default_unvalidated)', '(default cut-off, not validated)')}</p>
            {showSecondReader && !readOnly && (
              <div className="second">
                <span className="small">Record the {stage === 'second_reader' ? 'second' : 'third'} human reader’s call:</span>
                <div className="segmented" role="group" aria-label="Additional reader's call">
                  {DECISIONS.map((d) => <button key={d} type="button" className="seg" aria-pressed={pick === d} onClick={() => setPick(d)}>{cap(d)}</button>)}
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
