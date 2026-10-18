import { useEffect, useState } from 'react'
import { ArrowRight, Check, EyeOff, RotateCcw, ShieldCheck } from 'lucide-react'
import type { Decision, Read, Signout } from '../../types'
import { STEPS, currentStep, type WorkflowState } from '../../lib/workflow'
import { Button, ButtonLink } from '../ui/Button'

interface Props {
  wf: WorkflowState
  read: Read
  signout: Signout | null
  busy: boolean
  onInitial: (d: Decision) => void
  onRunCheck: () => void
  onFinal: (d: Decision) => void
  nextHref: string | null
}

const DECISIONS: Decision[] = ['benign', 'suspicious', 'malignant']
const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

/**
 * One step at a time. Every consequential action is two-step (choose, then record), so a stray
 * click never records a call or unlocks AI evidence.
 */
export default function DecisionBar({ wf, read, signout, busy, onInitial, onRunCheck, onFinal, nextHref }: Props) {
  const step = currentStep(wf)
  const decision = read.final_decision ?? read.initial_decision
  const [pick, setPick] = useState<Decision | null>(null)
  useEffect(() => { setPick(step === 3 ? (decision as Decision | null) : null) }, [step, read.read_id, decision])

  return (
    <div className="decision-bar" role="region" aria-label="Review workflow">
      <span className="db-step small">
        <span className="db-step-n num">Step {Math.min(step + 1, STEPS.length)} of {STEPS.length}</span>
        <strong>{STEPS[Math.min(step, STEPS.length - 1)].label}</strong>
      </span>

      {step === 0 && (
        <>
          <span className="db-prompt small">
            {read.review_mode === 'blind'
              ? <><EyeOff size={14} aria-hidden /> <span>Your call first<span className="db-long">; AI evidence stays hidden until you record it</span>.</span></>
              : 'Your call:'}
          </span>
          <div className="btn-row" role="group" aria-label="Initial assessment">
            {DECISIONS.map((d) => <Button key={d} size="sm" aria-pressed={pick === d} onClick={() => setPick(d)}>{cap(d)}</Button>)}
          </div>
          <Button variant="primary" size="sm" icon={Check} disabled={!pick || busy} onClick={() => pick && onInitial(pick)}>
            {pick ? `Record ${cap(pick)}` : 'Record assessment'}
          </Button>
          {read.review_mode === 'blind' && pick && <span className="xs muted">Recording reveals AI evidence; it cannot be undone.</span>}
        </>
      )}

      {(step === 1 || step === 2) && (
        <>
          <span className="db-prompt small"><span>Your call: <strong>{cap(decision)}</strong>.<span className="db-long"> Review the evidence and unseen areas, then run the check.</span></span></span>
          <Button variant="primary" size="sm" icon={ShieldCheck} disabled={busy} onClick={onRunCheck}>Run research sign-out check</Button>
        </>
      )}

      {step === 3 && (
        <>
          <span className="db-prompt small"><span><span className="db-long">Re-inspect the flagged regions. </span>Confirm or revise your call:</span></span>
          <div className="btn-row" role="group" aria-label="Final call">
            {DECISIONS.map((d) => <Button key={d} size="sm" aria-pressed={pick === d} onClick={() => setPick(d)}>{cap(d)}</Button>)}
          </div>
          <Button variant="primary" size="sm" icon={Check} disabled={!pick || busy} onClick={() => pick && onFinal(pick)}
            title="Records your final call and re-runs the unseen-tissue check on it">
            {pick && pick !== read.initial_decision ? `Revise to ${cap(pick)}` : `Confirm ${cap(pick ?? decision)}`}
          </Button>
          <Button variant="ghost" size="sm" icon={RotateCcw} disabled={busy} onClick={onRunCheck}>Re-run check</Button>
        </>
      )}

      {step >= 4 && (
        <>
          <span className="db-prompt small">
            <span>Final call: <strong>{cap(decision)}</strong>{read.initial_decision && read.initial_decision !== decision ? ` (revised from ${read.initial_decision})` : ''}.{signout ? ' Research sign-out check recorded.' : ''}{step === 4 ? ' An additional reader is suggested (Decision tab).' : ''}</span>
          </span>
          {nextHref && <ButtonLink size="sm" variant="secondary" href={nextHref} iconRight={ArrowRight}>Next case</ButtonLink>}
        </>
      )}
    </div>
  )
}
