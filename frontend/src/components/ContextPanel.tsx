import { useEffect, useState } from 'react'
import type { Rect } from '../types'

// Optional spatial-context feature, self-contained: its types and requests live here.
// Hidden entirely when the backend route is off (SECONDLOOK_CONTEXT=0) or missing.

interface Correlation {
  hidden: boolean
  hidden_reason?: string
  available?: boolean
  reason?: string
  features: { id: string; label: string }[]
  rings: { label: string; um: [number, number] }[]
  n_high: number[]
  ratio: (number | null)[][][]   // [x][ring][y]
  q: (number | null)[][][]
}
interface RingSummary { ring: string; features: string[] }
interface Match { case_id: string | null; slide_id: string; tile_id: string; shape_similarity: number; summary: RingSummary[]; rect: Rect }
interface Similar { available: boolean; reason?: string; query?: { summary: RingSummary[] }; matches?: Match[] }

interface Props {
  caseId: string
  readId: string | undefined
  tileId: string | null
  hidden: boolean
  onShowTiles: (rects: Rect[], label: string) => void
  onOpenMatch: (caseId: string, tileId: string, rect: Rect) => void
}

const get = async <T,>(path: string): Promise<T> => {
  const res = await fetch(`/api${path}`)
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return res.json() as Promise<T>
}
const qs = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
const SIG = 0.05
// how each ring reads in a sentence: "<Y> is 2× more common <phrase> <X>"
const PHRASE = ['in the same spot as', 'right next to', '2–3 tiles from', '4–6 tiles from']

function cellColor(r: number | null, q: number | null) {
  if (r === null || q === null || q >= SIG) return 'transparent'
  const t = Math.min(1, Math.abs(Math.log2(r)) / 1.2)
  return r > 1 ? `rgba(192, 38, 45, ${0.15 + 0.75 * t})` : `rgba(37, 99, 235, ${0.15 + 0.75 * t})`
}

// each feature is named only at the innermost ring where it stands out
function describe(s: RingSummary[]) {
  const seen = new Set<string>()
  const parts = s.map((r) => {
    const fresh = r.features.filter((f) => !seen.has(f))
    fresh.forEach((f) => seen.add(f))
    return fresh.length ? `${fresh.join(' + ').toLowerCase()} ${r.ring === 'this spot' ? 'here' : r.ring}` : ''
  }).filter(Boolean)
  return parts.length ? parts.join(' · ') : 'nothing stands out from the average'
}

export default function ContextPanel({ caseId, readId, tileId, hidden, onShowTiles, onOpenMatch }: Props) {
  const [corr, setCorr] = useState<Correlation | null>(null)
  const [off, setOff] = useState(false)
  const [ring, setRing] = useState(1)
  const [active, setActive] = useState<string | null>(null)
  const [sim, setSim] = useState<Similar | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setCorr(null); setSim(null); setActive(null)
    if (hidden) return
    get<Correlation>(`/cases/${caseId}/context/correlation?${qs({ read_id: readId })}`)
      .then(setCorr).catch((e) => { if (e.status === 404) setOff(true) })
  }, [caseId, readId, hidden])
  useEffect(() => { setSim(null) }, [tileId])

  if (off || hidden) return null
  if (!corr || corr.hidden) return null
  if (!corr.available) return <section className="panel ctx"><div className="panel-head"><h3>Spatial context</h3></div><p className="small muted">{corr.reason}</p></section>

  const shown = corr.features.map((f, i) => ({ ...f, i })).filter((f) => corr.n_high[f.i] > 0)
  const ratio = (x: number, y: number) => corr.ratio[x]?.[ring]?.[y] ?? null
  const qv = (x: number, y: number) => corr.q[x]?.[ring]?.[y] ?? null
  // pairs that already share the same tiles (e.g. two words for tumour) say nothing about layout: list the rest
  const sameSpot = (x: number, y: number) => (corr.q[x]?.[0]?.[y] ?? 1) < SIG && (corr.ratio[x]?.[0]?.[y] ?? 1) >= 2
  const strongest = shown.flatMap((x) => corr.features.map((y, yi) => ({ x, y, yi, r: ratio(x.i, yi), q: qv(x.i, yi) })))
    .filter((c) => c.r !== null && c.q !== null && c.q < SIG && c.x.i !== c.yi && (ring === 0 || !sameSpot(c.x.i, c.yi)))
    .sort((a, b) => Math.abs(Math.log(b.r!)) - Math.abs(Math.log(a.r!))).slice(0, 4)
  const where = PHRASE[ring] ?? `${corr.rings[ring].label} from`

  const showPair = (x: string, y: string, xl: string, yl: string) => {
    const key = `${x}|${y}|${ring}`
    setActive(key)
    get<{ tiles: Rect[]; n_tiles: number }>(`/cases/${caseId}/context/pair?${qs({ x, y, ring, read_id: readId })}`)
      .then((p) => onShowTiles(p.tiles, `${yl.toLowerCase()} ${where} ${xl.toLowerCase()}`)).catch(() => undefined)
  }
  const findSimilar = () => {
    if (!tileId) return
    setBusy(true)
    get<Similar>(`/cases/${caseId}/context/similar?${qs({ tile: tileId, read_id: readId })}`)
      .then(setSim).catch(() => setSim({ available: false, reason: 'search failed' })).finally(() => setBusy(false))
  }

  return (
    <section className="panel ctx">
      <div className="panel-head">
        <h3>Spatial context</h3>
        <span className="muted small">which features gather around which, on this slide</span>
      </div>
      <div className="seg ctx-rings" role="group" aria-label="distance">
        {corr.rings.map((r, i) => (
          <button key={r.label} className={`seg-btn ${ring === i ? 'on' : ''}`} aria-pressed={ring === i} onClick={() => setRing(i)}
            title={`${Math.round(r.um[0])}–${Math.round(r.um[1])} µm`}>{r.label}</button>
        ))}
      </div>
      <div className="ctx-grid" style={{ gridTemplateColumns: `minmax(96px, 1fr) repeat(${corr.features.length}, 18px)` }}>
        <span className="small muted ctx-corner">tiles high in ↓<br />what's {where.replace(/ (as|from|to)$/, '')} →</span>
        {corr.features.map((y) => <span key={y.id} className="ctx-col">{y.label}</span>)}
        {shown.map((x) => [
          <span key={`l${x.id}`} className="ctx-row small">{x.label}</span>,
          ...corr.features.map((y, yi) => {
            const r = ratio(x.i, yi), q = qv(x.i, yi)
            const key = `${x.id}|${y.id}|${ring}`
            return (
              <button key={key} className={`ctx-cell ${active === key ? 'on' : ''}`} style={{ background: cellColor(r, q) }}
                disabled={r === null}
                title={r === null ? '' : `${y.label} is ${r.toFixed(2)}× as common ${where} ${x.label.toLowerCase()} tiles` +
                  (q !== null ? ` (q = ${q.toFixed(3)}${q < SIG ? '' : ', not significant'})` : '')}
                onClick={() => showPair(x.id, y.id, x.label, y.label)} />
            )
          }),
        ])}
      </div>
      <div className="small muted ctx-legend"><span className="sw ctx-up" /> gathers around <span className="sw ctx-down" /> avoids · blank = not significant (q ≥ {SIG})</div>
      {strongest.length === 0 && <p className="small muted">No clear layout pattern at this distance.</p>}
      {strongest.length > 0 && (
        <ul className="ctx-top">
          {strongest.map((c) => (
            <li key={`${c.x.id}${c.y.id}`}>
              <button className="link small" onClick={() => showPair(c.x.id, c.y.id, c.x.label, c.y.label)}>
                {c.y.label} {c.r! > 1 ? `${c.r!.toFixed(1)}× more` : `${(1 / c.r!).toFixed(1)}× less`} common {where} {c.x.label.toLowerCase()}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ctx-search">
        <button className="btn small" disabled={!tileId || busy} onClick={findSimilar}>
          {busy ? 'Searching…' : 'Find similar arrangements'}
        </button>
        <span className="small muted">other cases where the tissue around a spot is organised like the selected tile</span>
      </div>
      {sim && !sim.available && <p className="small muted">{sim.reason}</p>}
      {sim?.available && (
        <>
          <p className="small"><b>Selected spot:</b> {describe(sim.query!.summary)}</p>
          {sim.matches!.length === 0 && <p className="small muted">No other indexed case has a matching arrangement.</p>}
          <ul className="ctx-matches">
            {sim.matches!.map((m) => (
              <li key={`${m.slide_id}${m.tile_id}`}>
                <button className="link small" disabled={!m.case_id} onClick={() => m.case_id && onOpenMatch(m.case_id, m.tile_id, m.rect)}>
                  {m.slide_id} ↗
                </button>
                <span className="small muted"> {Math.round(m.shape_similarity * 100)}% similar layout</span>
                <div className="small">{describe(m.summary)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
