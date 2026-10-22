import { Fragment, useEffect, useState, type ReactNode } from 'react'

// Optional concept explanation ("why is this tumour?" in words), self-contained: fetches its own data.
// Hidden entirely when the backend route is off (SECONDLOOK_CONCEPTS=0) or nothing is fitted.

interface Concept { id: string; label: string; contribution: number; similarity_sd: number }
interface Explanation {
  hidden: boolean; available?: boolean; reason?: string
  tumour_logit: number; benign_logit: number; explained_share: number | null
  for: Concept[]; against: Concept[]
  target: { tile: string | null; region: string | null; n_tiles: number }
}

interface Props {
  caseId: string
  readId: string | undefined
  tileId: string | null
  regionId: string | null
  regionLabel: string | null
  /** search the slide for one of the words (tissue search); omitted when search is off */
  onSearch?: (phrase: string) => void
}

const phrase = (c: Concept) => (c.similarity_sd >= 0 ? `looks like ${c.label.toLowerCase()}` : `has little ${c.label.toLowerCase()}`)
const opposite = (c: Concept) => (c.similarity_sd >= 0 ? `less like ${c.label.toLowerCase()}` : `more like ${c.label.toLowerCase()}`)
const list = (xs: ReactNode[]) => xs.flatMap((x, i) => (i === 0 ? [x] : [i === xs.length - 1 ? ' and ' : ', ', x]))

export default function ConceptWords({ caseId, readId, tileId, regionId, regionLabel, onSearch }: Props) {
  const [ex, setEx] = useState<Explanation | null>(null)
  const [off, setOff] = useState(false)

  useEffect(() => {
    setEx(null)
    const q = regionId ? `region=${encodeURIComponent(regionId)}` : tileId ? `tile=${encodeURIComponent(tileId)}` : null
    if (!q) return
    let live = true
    fetch(`/api/cases/${caseId}/explain?${q}${readId ? `&read_id=${readId}` : ''}`)
      .then(async (r) => {
        if (r.status === 404 && (await r.clone().json().catch(() => ({}))).detail === 'Not Found') { setOff(true); return null }
        return r.ok ? (r.json() as Promise<Explanation>) : null
      })
      .then((d) => { if (live && d) { if (!d.hidden && d.available === false) setOff(true); else setEx(d) } })
      .catch(() => undefined)
    return () => { live = false }
  }, [caseId, readId, tileId, regionId])

  if (off || !ex || ex.hidden) return null
  const moved = ex.tumour_logit - ex.benign_logit
  const tumourish = ex.tumour_logit > 0
  const top = (tumourish ? ex.for : ex.against).slice(0, 3)
  const other = (tumourish ? ex.against : ex.for).slice(0, 2)
  if (!top.length) return null
  // each word links to tissue search, so "why" leads straight to "where"
  const word = (c: Concept, text: string) => (onSearch
    ? <button key={c.id} type="button" className="link-btn" title={`Show where the slide looks like ${c.label}`} onClick={() => onSearch(c.label)}>{text}</button>
    : <Fragment key={c.id}>{text}</Fragment>)

  return (
    <div className="cw" aria-live="polite">
      <div className="cw-head">
        <span className="signal-name">In words</span>
        <span className="xs muted">{ex.target.region ? `${regionLabel ?? 'region'} · its ${ex.target.n_tiles} tumour-scoring tiles` : 'selected tile'}</span>
      </div>
      <p className="small cw-line">
        <b>{tumourish ? 'Scored as tumour because it' : 'Scored as benign because it'}</b> {list(top.map((c) => word(c, phrase(c))))}
        {other.length > 0 && <span className="muted"> · weighing the other way: {list(other.map((c) => word(c, phrase(c))))}</span>}
      </p>
      {tumourish && (
        <p className="small cw-line">
          <b>To call it benign</b>, the AI would need it to look {list(top.slice(0, 2).map((c) => word(c, opposite(c))))}.
        </p>
      )}
      <p className="xs muted cw-foot">
        {ex.explained_share !== null && tumourish && moved > 2
          ? `These words account for about ${Math.round(Math.min(1, ex.explained_share) * 100)}% of the score. `
          : ''}
        {onSearch ? 'Click a word to see where it appears on the slide. ' : ''}What the AI relies on, read through CONCH's text concepts; not a diagnosis.
      </p>
    </div>
  )
}
