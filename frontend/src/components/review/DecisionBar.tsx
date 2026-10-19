import { useEffect, useState } from 'react'
import { ArrowRight, Check, Crosshair, EyeOff, Lock, NotebookPen, RotateCcw, ShieldCheck } from 'lucide-react'
import type { Decision, Read, Region } from '../../types'
import { STEPS, currentStep, type WorkflowState } from '../../lib/workflow'
import { Button, ButtonLink } from '../ui/Button'

interface Props {
  wf: WorkflowState
  read: Read
  busy: boolean
  readOnly: boolean
  unrevisited: Region[]
  onInitial: (d: Decision) => void
  onRunCheck: () => void
  onFinal: (d: Decision) => void
  onNewRead: () => void
  onGoRegion: (r: Region) => void
  nextHref: string | null
  /** the reader has typed notes (they are saved with the call, or before the check) */
  hasNotes: boolean
  /** what still has to be recorded before the sign-out check (from the server, notes excluded once typed) */
  checkTodo: string[]
  onOpenNotes: () => void
}

const DECISIONS: Decision[] = ['benign', 'suspicious', 'malignant']
const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

function Choice({ value, onChange, label }: { value: Decision | null; onChange: (d: Decision) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {DECISIONS.map((d) => <button key={d} type="button" className="seg" aria-pressed={value === d} onClick={() => onChange(d)}>{cap(d)}</button>)}
    </div>
  )
}

/**
 * One row, one step at a time. Consequential actions are two-step (choose, then record), so a stray
 * click never records a call or unlocks AI evidence. Long hints collapse away on narrow viewers.
 */
export default function DecisionBar({ wf, read, busy, readOnly, unrevisited, onInitial, onRunCheck, onFinal, onNewRead, onGoRegion, nextHref, hasNotes, checkTodo, onOpenNotes }: Props) {
  const step = readOnly ? 5 : currentStep(wf)
  const blind = read.review_mode === 'blind'
  const needNotes = blind && !hasNotes
  const decision = (wf.confirmed ? read.final_decision : null) ?? read.initial_decision
  const [pick, setPick] = useState<Decision | null>(null)
  useEffect(() => { setPick(step === 3 ? (read.initial_decision as Decision | null) : null) }, [step, read.read_id, read.initial_decision])

  return (
    <div className="decision-bar" role="region" aria-label="Review workflow">
      <span className="db-step small">
        <span className="db-step-n num">Step {Math.min(step + 1, STEPS.length)}/{STEPS.length}</span>
        <strong>{STEPS[Math.min(step, STEPS.length - 1)].short}</strong>
      </span>

      {readOnly && (
        <>
          <span className="db-prompt small"><Lock size={14} aria-hidden />
            <span>Completed{decision ? <>: final call <strong>{cap(decision)}</strong></> : ''}.<span className="db-long"> Research sign-out check recorded. Shown read-only.</span></span>
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onNewRead} title="Starts a new, separate read of this case">Start a new read</Button>
          {nextHref && <ButtonLink size="sm" variant="primary" href={nextHref} iconRight={ArrowRight}>Next case</ButtonLink>}
        </>
      )}

      {!readOnly && step === 0 && (
        <>
          <Choice value={pick} onChange={setPick} label="Your initial assessment" />
          <Button variant="primary" size="sm" icon={Check} disabled={!pick || busy || needNotes} onClick={() => pick && onInitial(pick)}
            title={needNotes ? 'Write your notes first' : undefined}>
            {pick ? `Record ${cap(pick)}` : 'Record call'}
          </Button>
          {needNotes && <Button variant="secondary" size="sm" icon={NotebookPen} onClick={onOpenNotes}>Write notes</Button>}
          <span className="db-prompt small">
            {blind
              ? (needNotes ? <><EyeOff size={14} aria-hidden /><span>Your notes and call first<span className="db-long">; AI evidence stays hidden until both are saved</span>.</span></>
                : pick ? <span className="warn-text">Recording saves your notes, reveals AI evidence and cannot be undone.</span>
                : <><EyeOff size={14} aria-hidden /><span>Now your call<span className="db-long">; AI evidence stays hidden until you record it</span>.</span></>)
              : <span className="db-long">Record your call; the evidence is already visible.</span>}
          </span>
        </>
      )}

      {!readOnly && (step === 1 || step === 2) && (
        <>
          <span className="db-prompt small"><span>Your call: <strong>{cap(decision)}</strong>.
            {checkTodo.length
              ? <span className="warn-text"> Before the check: {checkTodo.join(', ')}.</span>
              : <span className="db-long"> Review the evidence and unseen areas, then run the check.</span>}</span></span>
          {checkTodo.includes('notes') && <Button variant="secondary" size="sm" icon={NotebookPen} onClick={onOpenNotes}>Write notes</Button>}
          <Button variant="primary" size="sm" icon={ShieldCheck} disabled={busy || checkTodo.length > 0} onClick={onRunCheck}
            title={checkTodo.length ? `Still needed: ${checkTodo.join(', ')}` : undefined}>Run research sign-out check</Button>
        </>
      )}

      {!readOnly && step === 3 && (
        <>
          {unrevisited.length > 0 && (
            <Button variant="primary" size="sm" icon={Crosshair} onClick={() => onGoRegion(unrevisited[0])}
              title={`${unrevisited.length} flagged region${unrevisited.length === 1 ? '' : 's'} not yet revisited`}>
              Go to region {unrevisited[0].rank}<span className="db-long"> ({unrevisited.length} not revisited)</span>
            </Button>
          )}
          <Choice value={pick} onChange={setPick} label="Confirm or revise your call" />
          <Button variant={unrevisited.length ? 'secondary' : 'primary'} size="sm" icon={Check} disabled={!pick || busy} onClick={() => pick && onFinal(pick)}
            title="Records your final call and re-runs the unseen-tissue check on it">
            {pick && pick !== read.initial_decision ? `Revise to ${cap(pick)}` : `Confirm ${cap(pick ?? decision)}`}
          </Button>
          <Button variant="ghost" size="sm" icon={RotateCcw} disabled={busy} onClick={onRunCheck} aria-label="Re-run the unseen-tissue check" title="Re-run the unseen-tissue check" />
        </>
      )}

      {!readOnly && step >= 4 && (
        <>
          <span className="db-prompt small">
            <span>Final call: <strong>{cap(decision)}</strong>{read.initial_decision && read.initial_decision !== decision ? ` (revised from ${read.initial_decision})` : ''}.<span className="db-long">{step === 4 ? ' Additional reader suggested (Decision tab).' : ' Research sign-out check recorded.'}</span></span>
          </span>
          {nextHref && <ButtonLink size="sm" variant="secondary" href={nextHref} iconRight={ArrowRight}>Next case</ButtonLink>}
        </>
      )}
    </div>
  )
}
