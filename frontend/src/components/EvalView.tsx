import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleMinus, Info, TriangleAlert } from 'lucide-react'
import type { EvalDoc, EvalHeadline } from '../types'
import { RESEARCH_ORDER, RESEARCH_QUESTIONS } from '../lib/research'
import EmptyState, { SkeletonRows } from './ui/EmptyState'

const STATUS_ICON = { pass: CircleCheck, fail: CircleMinus, info: Info } as const
const STATUS_TEXT = { pass: 'Met', fail: 'Not met', info: 'Reported' } as const
const rank = (k: string) => { const i = RESEARCH_ORDER.indexOf(k); return i < 0 ? 99 : i }

function Headline({ h }: { h: EvalHeadline }) {
  const Icon = h.status ? STATUS_ICON[h.status] : null
  return (
    <div className={`headline ${h.status ? `is-${h.status}` : ''}`}>
      <span className="headline-label">{h.label}</span>
      <span className="headline-value num">{h.value}</span>
      {(h.ci || h.status) && (
        <span className="headline-meta">
          {h.ci && <span className="num">CI {h.ci}</span>}
          {Icon && h.status && <span className={`headline-status is-${h.status}`}><Icon size={12} aria-hidden />{STATUS_TEXT[h.status]}</span>}
        </span>
      )}
      {h.note && <div className="headline-note">{h.note}</div>}
    </div>
  )
}

/** Evaluation cards; numbers come straight from bundle/eval/*.json via /api/eval/summary. */
export default function EvalView({ docs, error }: { docs: Record<string, EvalDoc> | null; error: string | null }) {
  const [open, setOpen] = useState<string | null>(null)
  if (error) return <EmptyState icon={TriangleAlert} tone="warning" title="Evaluation results could not be loaded">{error}</EmptyState>
  if (!docs) return <SkeletonRows rows={6} cols={3} />
  const entries = Object.entries(docs).filter(([, d]) => d && typeof d === 'object')
    .sort(([a], [b]) => rank(a) - rank(b))
  if (entries.length === 0) return <EmptyState title="No evaluation outputs yet">Run <code>python -m secondlook.eval.run_all</code>.</EmptyState>
  return (
    <div className="eval-grid">
      {entries.map(([key, d]) => (
        <article key={key} className="panel eval-card" aria-labelledby={`eval-${key}`}>
          <div className="eval-head">
            <h3 id={`eval-${key}`}>{RESEARCH_QUESTIONS[key] ?? d.title ?? key}</h3>
            {d.measure && <span className="tag">{d.measure}</span>}
          </div>
          {d.dataset && <div className="eval-dataset"><span className="muted">Dataset:</span> {d.dataset}</div>}
          {d.scope && <div className="small warn-text">{d.scope}</div>}
          {d.error && <div className="notice warn"><TriangleAlert size={14} aria-hidden />{d.error}</div>}
          <div className="headlines">{d.headline?.map((h) => <Headline key={h.label} h={h} />)}</div>
          {d.caveats && d.caveats.length > 0 && (
            <div className="caveats">
              <div className="caveats-title"><TriangleAlert size={13} aria-hidden /> Caveats</div>
              <ul>{d.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          <button type="button" className="link-btn small raw-toggle" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
            {open === key ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
            {open === key ? 'Hide' : 'Show'} raw JSON
          </button>
          {open === key && <pre className="raw">{JSON.stringify(d, null, 1)}</pre>}
        </article>
      ))}
    </div>
  )
}
