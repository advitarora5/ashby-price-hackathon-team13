import { useEffect, useState } from 'react'
import type { Read, Rect, Region } from '../types'

// Optional Clef feature, self-contained: notes check and region referee.
// Hidden entirely when the backend route is off (SECONDLOOK_CLEF=0).

interface CheckRow {
  finding: string
  feature: string | null
  label: string
  about: string
  category: 'contradiction' | 'possibly_missed' | 'not_found' | 'confirmed' | 'agrees_absent' | 'cannot_check'
  said_text: string
  said_p: number | null
  slide_share: number | null
  reason: string
  context?: string | null
  where?: (Rect & { tile_id: string })[]
}
interface Check { rows: CheckRow[]; model: string; checked_at: string; method: string; stale?: boolean }
interface Referee { explanation: string; probabilities: Record<string, number>; needs_expert: number | null; n_images: number }

interface Props {
  caseId: string
  read: Read | null
  regions: Region[]
  onJump: (r: Rect, what: string) => void
  onShowTiles: (rects: Rect[], label: string) => void
}

const GROUPS: Record<CheckRow['category'], { icon: string; title: string; tone: string }> = {
  contradiction: { icon: '⚠', title: 'Your notes say absent, but the AI sees it', tone: 'bad' },
  possibly_missed: { icon: '⚠', title: 'Not in your notes, but the AI sees it', tone: 'bad' },
  not_found: { icon: '?', title: "In your notes, but the AI doesn't find it", tone: 'warn' },
  confirmed: { icon: '✓', title: 'Your notes and the AI agree', tone: 'ok' },
  agrees_absent: { icon: '✓', title: 'Both say absent', tone: 'ok' },
  cannot_check: { icon: '–', title: "In your notes, but the AI can't check it", tone: 'muted' },
}
const EXPLAIN: Record<string, string> = {
  real_tumour: 'real tumour', benign_mimic: 'benign look-alike', artifact: 'artifact', ambiguous: 'genuinely ambiguous',
}

async function call<T>(path: string, method = 'GET'): Promise<T> {
  const res = await fetch(`/api${path}`, { method })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { detail = (await res.json()).detail ?? detail } catch { /* not json */ }
    throw Object.assign(new Error(String(detail)), { status: res.status })
  }
  return res.json() as Promise<T>
}

export default function ClefPanel({ caseId, read, regions, onJump, onShowTiles }: Props) {
  const [check, setCheck] = useState<Check | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [off, setOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ref, setRef] = useState<Record<string, Referee | string>>({})
  const visible = !!read?.evidence_visible && read.source === 'live'

  useEffect(() => {
    setCheck(null); setMsg(null); setRef({})
    if (!visible || !read) return
    call<Check>(`/reads/${read.read_id}/notes-check`).then(setCheck).catch((e) => { if (e.status === 404 && e.message === 'Not Found') setOff(true) })
  }, [read?.read_id, visible]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCheck((c) => (c ? { ...c, stale: true } : c)) }, [read?.notes])

  if (off || !visible || !read) return null

  const runCheck = () => {
    setBusy(true); setMsg(null)
    call<Check>(`/reads/${read.read_id}/notes-check`, 'POST').then((c) => setCheck({ ...c, stale: false }))
      .catch((e) => (e.status === 404 && e.message === 'Not Found' ? setOff(true) : setMsg(e.message))).finally(() => setBusy(false))
  }
  const explain = (r: Region) => {
    setRef((s) => ({ ...s, [r.region_id]: 'asking Clef…' }))
    call<Referee>(`/cases/${caseId}/regions/${r.region_id}/explain?read_id=${read.read_id}`, 'POST')
      .then((a) => setRef((s) => ({ ...s, [r.region_id]: a })))
      .catch((e) => setRef((s) => ({ ...s, [r.region_id]: e.message })))
  }
  const groups = (Object.keys(GROUPS) as CheckRow['category'][])
    .map((k) => ({ k, rows: (check?.rows ?? []).filter((r) => r.category === k) })).filter((g) => g.rows.length)

  return (
    <section className="panel clef">
      <div className="panel-head">
        <h3>Notes check</h3>
        <span className="muted small">Clef reads your notes; the slide AI checks them</span>
      </div>
      <div className="clef-run">
        <button className="btn small" disabled={busy || !read.notes_saved_at} onClick={runCheck}>
          {busy ? 'Reading your notes…' : check ? 'Check again' : 'Check my notes against the slide'}
        </button>
        {check?.stale && <span className="small warn-text">notes changed since this check</span>}
        {!read.notes_saved_at && <span className="small muted">save your notes first</span>}
      </div>
      {msg && <p className="small warn-text">{msg}</p>}
      {check && groups.length === 0 && <p className="small muted">Nothing to flag: your notes and the slide AI line up.</p>}
      {groups.map(({ k, rows }) => (
        <div key={k} className={`clef-group tone-${GROUPS[k].tone}`}>
          <div className="small clef-title"><span className="clef-icon">{GROUPS[k].icon}</span>{GROUPS[k].title}</div>
          <ul>
            {rows.map((r) => (
              <li key={r.finding}>
                <b className="small">{r.label}</b>
                <span className="small muted">
                  {r.slide_share !== null ? ` · AI: ${(r.slide_share * 100).toFixed(r.slide_share < 0.1 ? 1 : 0)}% of tissue` : ''}
                  {r.category !== 'possibly_missed' && r.said_p !== null ? ` · notes ${r.said_text} (${Math.round(r.said_p * 100)}%)` : ''}
                  {r.reason ? ` · ${r.reason}` : ''}
                </span>
                {r.context && <div className="small muted">{r.context}</div>}
                {r.where && r.where.length > 0 && (
                  <span className="clef-links">
                    <button className="link small" onClick={() => onJump(r.where![0], `jump:clef:${r.finding}`)}>where ↗</button>
                    <button className="link small" onClick={() => onShowTiles(r.where!, r.label.toLowerCase())}>outline</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {check && <p className="small muted clef-method">{check.method} · {check.model}</p>}
      {regions.length > 0 && (
        <>
          <div className="panel-head clef-sub"><h3>Why was this flagged?</h3><span className="muted small">Clef weighs the evidence for a region</span></div>
          <ul className="clef-regions">
            {regions.slice(0, 4).map((r) => {
              const a = ref[r.region_id]
              return (
                <li key={r.region_id}>
                  <button className="link small" onClick={() => onJump(r, `region:${r.region_id}`)}>
                    {r.kind === 'disputed' ? 'disputed' : 'risk'} region #{r.rank} ↗
                  </button>
                  {!a && <button className="btn small" onClick={() => explain(r)}>Explain</button>}
                  {typeof a === 'string' && <span className="small muted"> {a}</span>}
                  {a && typeof a !== 'string' && (
                    <div className="small">
                      Most likely <b>{EXPLAIN[a.explanation] ?? a.explanation}</b>
                      <span className="muted"> · {Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])
                        .map(([k, v]) => `${EXPLAIN[k] ?? k} ${Math.round(v * 100)}%`).join(' · ')}</span>
                      {a.needs_expert !== null && a.needs_expert >= 0.5 && <div className="warn-text">Clef suggests a close look at high magnification</div>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="small muted clef-method">Experimental: shown only to explain a flag, never as a diagnosis.</p>
        </>
      )}
    </section>
  )
}
