import { useEffect, useState } from 'react'
import type { Decision, Read } from '../types'

interface Props {
  read: Read
  evidenceHidden: boolean
  signedOutOnce: boolean
  onSaveNotes: (text: string) => Promise<void>
  onReveal: (text: string, d: Decision) => Promise<void>
  onDecide: (stage: 'initial' | 'final', d: Decision) => Promise<void>
  onSignOut: () => Promise<void>
}

const DECISIONS: Decision[] = ['benign', 'suspicious', 'malignant']

export default function ReviewForm({ read, evidenceHidden, signedOutOnce, onSaveNotes, onReveal, onDecide, onSignOut }: Props) {
  const [draft, setDraft] = useState(read.notes ?? '')
  const [pending, setPending] = useState<Decision | null>(read.initial_decision)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setDraft(read.notes ?? ''); setPending(read.initial_decision) }, [read.read_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draft !== (read.notes ?? '')
  const hasText = draft.trim().length > 0
  const status = !read.notes_saved_at ? 'not saved yet' : dirty ? 'unsaved changes' : 'saved'
  const run = (f: () => Promise<void>) => async () => { setBusy(true); try { await f() } finally { setBusy(false) } }
  const decision = read.final_decision ?? read.initial_decision
  const todo = [...read.signout_missing.filter((m) => m !== 'assessment'), ...(dirty ? ['save your notes'] : [])]

  return (
    <div className="review">
      <div className="review-head">
        <b>Your notes</b>
        <span className={`small ${status === 'saved' ? 'muted' : 'warn-text'}`}>{status}</span>
      </div>
      <textarea className="notes" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)}
        placeholder={evidenceHidden ? 'Describe what you see before the AI evidence is shown…' : 'Full notes for this case…'} />
      <div className="decision-bar">
        {evidenceHidden ? (
          <>
            <span>Your assessment:</span>
            {DECISIONS.map((d) => (
              <button key={d} className={`btn dec-${d} ${pending === d ? 'on' : ''}`} aria-pressed={pending === d}
                onClick={() => setPending(d)}>{d}</button>
            ))}
            <button className="btn primary" disabled={busy || !hasText || !pending}
              onClick={run(() => onReveal(draft, pending!))}>Save notes &amp; reveal AI</button>
            <span className="small muted">AI evidence stays hidden until you save notes and pick an assessment.</span>
          </>
        ) : (
          <>
            {!read.initial_decision ? (
              <>
                <span>Your assessment:</span>
                {DECISIONS.map((d) => (
                  <button key={d} className={`btn dec-${d}`} onClick={() => onDecide('initial', d)}>{d}</button>
                ))}
              </>
            ) : (
              <span>Assessment: <b>{decision}</b>{read.final_decision && read.initial_decision !== read.final_decision ? ` (changed from ${read.initial_decision})` : ''}</span>
            )}
            <button className="btn" disabled={busy || !hasText || !dirty} onClick={run(() => onSaveNotes(draft))}>Save notes</button>
            {read.initial_decision && (
              <button className="btn primary" disabled={busy || todo.length > 0}
                title={todo.length ? `Still needed: ${todo.join(', ')}` : undefined}
                onClick={run(onSignOut)}>{signedOutOnce ? 'Re-run sign-out check' : `Sign out as ${decision}`}</button>
            )}
            {read.initial_decision && todo.length > 0 && (
              <span className="small warn-text">Before sign-out: {todo.join(', ')}</span>
            )}
            {signedOutOnce && (
              <span className="final">
                <span className="small muted">after re-inspection:</span>
                {DECISIONS.map((d) => (
                  <button key={d} className={`btn small dec-${d}`} onClick={() => onDecide('final', d)}>confirm {d}</button>
                ))}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
