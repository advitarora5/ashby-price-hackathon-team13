import { useEffect, useState } from 'react'
import type { Rect } from '../types'

// Optional tissue search ("Ctrl+F for tissue"), self-contained: fetches its own data.
// Hidden entirely when the backend route is off (SECONDLOOK_SEARCH=0).

interface Spot { tile_id: string; rect: Rect; score: number; rank: number }
interface Result {
  hidden: boolean; hidden_reason?: string; query: string; source: string; model: string; contrast: string
  n_tissue: number; n_highlighted: number; spots: Spot[]; method: string
}
interface CaseMatch { case_id: string; slide_id: string; strength: number; level: string; tile_id: string; rect: Rect }
interface Cases { hidden: boolean; matches: CaseMatch[]; n_cases: number; n_hidden: number; this_rank: number | null; this_level: string | null }
interface Suggestion { phrase: string; label: string; id: string }
interface Term { label: string; group: string }

interface Props {
  caseId: string
  readId: string | undefined
  query: string | null
  hidden: boolean
  onSearch: (q: string) => void
  onSpot: (s: Spot | null) => void
  onOpenCase: (caseId: string, rect: Rect) => void
}

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { detail = (await res.json()).detail ?? detail } catch { /* not json */ }
    throw Object.assign(new Error(String(detail)), { status: res.status })
  }
  return res.json() as Promise<T>
}

const LEVEL: Record<string, string> = { strong: 'strong match', medium: 'medium match', weak: 'weak match' }
const GROUPS: [string, string][] = [
  ['tumour', 'Tumour cells'], ['normal', 'Normal lymph node'], ['immune', 'Immune cells'],
  ['other', 'Other tissue'], ['artifact', 'Slide artifacts'],
]

export default function SearchPanel({ caseId, readId, query, hidden, onSearch, onSpot, onOpenCase }: Props) {
  const [res, setRes] = useState<Result | null>(null)
  const [cases, setCases] = useState<Cases | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [at, setAt] = useState(0)
  const [sugg, setSugg] = useState<Suggestion[]>([])
  const [terms, setTerms] = useState<Term[]>([])
  const [off, setOff] = useState(false)

  useEffect(() => {
    call<{ phrases: Suggestion[]; terms?: Term[] }>('/search/suggestions').then((d) => { setSugg(d.phrases); setTerms(d.terms ?? []) })
      .catch((e) => { if (e.status === 404) setOff(true) })
  }, [])

  useEffect(() => {
    setRes(null); setCases(null); setMsg(null); setAt(0); onSpot(null)
    if (!query || hidden) return
    const qs = `q=${encodeURIComponent(query)}${readId ? `&read_id=${readId}` : ''}`
    setBusy(true)
    call<Result>(`/cases/${caseId}/search?${qs}`)
      .then((r) => {
        setRes(r)
        if (!r.hidden && r.spots.length) onSpot(r.spots[0])
        return call<Cases>(`/cases/${caseId}/search/cases?${qs}`).then(setCases)
      })
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(false))
  }, [caseId, readId, query, hidden]) // eslint-disable-line react-hooks/exhaustive-deps

  if (off) return null
  if (hidden) return <p className="small muted side-empty">Tissue search is AI evidence: it unlocks once your blind call is recorded.</p>

  const step = (d: number) => {
    if (!res || !res.spots.length) return
    const i = (at + d + res.spots.length) % res.spots.length
    setAt(i); onSpot(res.spots[i])
  }

  return (
    <section className="panel srch">
      <div className="panel-head">
        <h3>Search this slide</h3>
        <span className="muted small">type what you're looking for in words; the slide lights up where it best matches</span>
      </div>
      {!query && (
        <>
          <p className="small muted">Use the search box above the slide (⌘F / Ctrl+F), or try:</p>
          <div className="srch-chips">
            {sugg.map((s) => <button key={s.id} className="srch-chip" onClick={() => onSearch(s.label)}>{s.label}</button>)}
          </div>
          {GROUPS.map(([g, title]) => {
            const ts = terms.filter((x) => x.group === g)
            return ts.length ? (
              <details key={g} className="srch-group" open={g === 'tumour'}>
                <summary className="small">{title} <span className="muted">({ts.length})</span></summary>
                <div className="srch-chips">
                  {ts.map((x) => <button key={x.label} className="srch-chip" onClick={() => onSearch(x.label)}>{x.label}</button>)}
                </div>
              </details>
            ) : null
          })}
        </>
      )}
      {busy && <p className="small muted">Searching…</p>}
      {msg && (
        <div className="srch-msg small">
          <p className="warn-text">{msg}</p>
          <div className="srch-chips">
            {sugg.map((s) => <button key={s.id} className="srch-chip" onClick={() => onSearch(s.label)}>{s.label}</button>)}
          </div>
        </div>
      )}
      {res && !res.hidden && (
        <>
          <div className="srch-q">
            <b>"{res.query}"</b>
            <button className="link-btn small" onClick={() => onSearch('')}>clear</button>
          </div>
          <p className="small muted">Highlighted: the best-matching {res.n_highlighted} of {res.n_tissue} tissue tiles (top 1%, darker = stronger).</p>
          <div className="srch-step">
            <span className="small"><b>Best spots</b> · {at + 1} of {res.spots.length}</span>
            <span className="srch-step-btns">
              <button className="btn btn-secondary btn-sm" onClick={() => step(-1)} aria-label="previous spot">◀</button>
              <button className="btn btn-secondary btn-sm" onClick={() => step(1)} aria-label="next spot">▶</button>
            </span>
          </div>
          <ol className="srch-spots srch-grid">
            {res.spots.map((s, i) => (
              <li key={s.tile_id} className={i === at ? 'on' : ''}>
                <button className="link-btn small" onClick={() => { setAt(i); onSpot(s) }} aria-label={`spot ${s.rank}`}>#{s.rank}</button>
              </li>
            ))}
          </ol>
          {cases && !cases.hidden && (
            <div className="srch-cases small">
              <div>
                <b>Other cases</b>
                {cases.this_level && <span className="muted"> · this slide ranks {cases.this_rank} of {cases.n_cases} ({LEVEL[cases.this_level]})</span>}
              </div>
              <ul>
                {cases.matches.map((m) => (
                  <li key={m.case_id}>
                    <button className="link-btn small" onClick={() => onOpenCase(m.case_id, m.rect)}>{m.slide_id} ↗</button>
                    <span className="muted"> {LEVEL[m.level]}</span>
                  </li>
                ))}
              </ul>
              {cases.n_hidden > 0 && <p className="muted">{cases.n_hidden} slow-path cases not shown until they're read.</p>}
            </div>
          )}
          <p className="small muted srch-method">
            Best matches, not a yes/no: the AI always finds a closest spot, so if the top spots don't show it, it may not be here.
            {' '}{res.source} · {res.model} vs "{res.contrast}"
          </p>
        </>
      )}
    </section>
  )
}
