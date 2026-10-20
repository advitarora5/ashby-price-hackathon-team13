import { useEffect, useState } from 'react'
import { History, Save } from 'lucide-react'
import { api } from '../../api'
import type { NoteVersion, Read } from '../../types'
import { absoluteTime } from '../../lib/format'
import { Button } from '../ui/Button'

interface Props {
  read: Read
  draft: string
  onDraft: (text: string) => void
  onSave: () => void
  busy: boolean
  readOnly: boolean
  evidenceHidden: boolean
}

export const NOTES_ID = 'rv-notes'

/**
 * The reader's own case notes. On a blind read they are required (with the call) before AI evidence is
 * shown; every read needs them before the sign-out check. Each save is kept as a new version.
 */
export default function NotesSection({ read, draft, onDraft, onSave, busy, readOnly, evidenceHidden }: Props) {
  const [history, setHistory] = useState<NoteVersion[] | null>(null)
  useEffect(() => { setHistory(null) }, [read.read_id])
  // keep an open history list current after each save
  useEffect(() => { if (history) api.history(read.read_id).then(setHistory).catch(() => undefined) }, [read.notes]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleHistory = () => {
    if (history) setHistory(null)
    else api.history(read.read_id).then(setHistory).catch(() => setHistory([]))
  }

  const dirty = draft !== (read.notes ?? '')
  const status = !read.notes_saved_at ? 'Not saved yet' : dirty ? 'Unsaved changes' : 'Saved'

  return (
    <section className="sub" aria-labelledby="dc-notes">
      <div className="sub-head">
        <h3 id="dc-notes">Your notes</h3>
        <span className={`xs ${status === 'Saved' ? 'muted' : 'warn-text'}`} aria-live="polite">{status}</span>
      </div>
      {read.signed_out_at && <p className="xs muted">Signed out {absoluteTime(read.signed_out_at)}. Later edits are kept as new versions.</p>}
      <label htmlFor={NOTES_ID} className="sr-only">Your notes for this case</label>
      <textarea id={NOTES_ID} className="input notes-input" rows={5} value={draft} readOnly={readOnly}
        onChange={(e) => onDraft(e.target.value)}
        placeholder={evidenceHidden ? 'Describe what you see before the AI evidence is shown…' : 'Your notes for this case…'} />
      <div className="btn-row">
        {!readOnly && (
          <Button size="sm" variant="secondary" icon={Save} disabled={busy || !draft.trim() || !dirty} onClick={onSave}>Save notes</Button>
        )}
        {read.notes_saved_at && (
          <Button size="sm" variant="ghost" icon={History} aria-expanded={!!history} onClick={toggleHistory}>
            {history ? 'Hide history' : 'Version history'}
          </Button>
        )}
      </div>
      {evidenceHidden && !readOnly && (
        <p className="xs muted">AI evidence stays hidden until your notes are saved and your call is recorded. Recording your call saves these notes.</p>
      )}
      {history && (
        <ol className="note-history">
          {history.length === 0 && <li className="xs muted">No saved versions yet.</li>}
          {history.map((h, i) => (
            <li key={h.version}>
              <div className="xs muted num">v{h.version} · {absoluteTime(h.saved_at)}{i === 0 ? ' · current' : ''}</div>
              <div className="note-history-text small">{h.text}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
