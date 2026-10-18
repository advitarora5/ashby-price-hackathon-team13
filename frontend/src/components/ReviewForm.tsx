import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Decision, NoteVersion, Read } from '../types'

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
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function ReviewForm({ read, evidenceHidden, signedOutOnce, onSaveNotes, onReveal, onDecide, onSignOut }: Props) {
  const [draft, setDraft] = useState(read.notes ?? '')
  const [pending, setPending] = useState<Decision | null>(read.initial_decision)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<NoteVersion[] | null>(null)
  // what is typed vs what the server has, for this read: unsaved notes are saved automatically
  // when the reader switches case, reloads or closes the page (each save is a new version)
  const pendingSave = useRef({ readId: read.read_id, text: read.notes ?? '', saved: read.notes ?? '' })
  useEffect(() => {
    setDraft(read.notes ?? ''); setPending(read.initial_decision); setHistory(null)
    pendingSave.current = { readId: read.read_id, text: read.notes ?? '', saved: read.notes ?? '' }
    const readId = read.read_id
    const saveIfDirty = () => {
      const p = pendingSave.current
      if (p.readId === readId && p.text.trim() && p.text !== p.saved) {
        p.saved = p.text
        api.saveNotesOnLeave(readId, p.text)
      }
    }
    window.addEventListener('pagehide', saveIfDirty)
    return () => { window.removeEventListener('pagehide', saveIfDirty); saveIfDirty() }
  }, [read.read_id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { pendingSave.current.saved = read.notes ?? '' }, [read.notes])
  // keep an open history list current after each save
  useEffect(() => { if (history) api.history(read.read_id).then(setHistory).catch(() => undefined) }, [read.notes]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleHistory = () => {
    if (history) setHistory(null)
    else api.history(read.read_id).then(setHistory).catch(() => setHistory([]))
  }

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
        {read.signed_out_at && <span className="small muted">signed out {when(read.signed_out_at)} · edits are kept as new versions</span>}
        <span className="spacer" />
        {read.notes_saved_at && (
          <button className="link small" onClick={toggleHistory}>{history ? 'hide history' : 'version history'}</button>
        )}
        <span className={`small ${status === 'saved' ? 'muted' : 'warn-text'}`}>{status}</span>
      </div>
      {history && (
        <ol className="history">
          {history.length === 0 && <li className="small muted">No saved versions yet.</li>}
          {history.map((h, i) => (
            <li key={h.version}>
              <div className="small muted">v{h.version} · {when(h.saved_at)}{i === 0 ? ' · current' : ''}</div>
              <div className="history-text">{h.text}</div>
            </li>
          ))}
        </ol>
      )}
      <textarea className="notes" rows={4} value={draft} onChange={(e) => { setDraft(e.target.value); pendingSave.current.text = e.target.value }}
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
