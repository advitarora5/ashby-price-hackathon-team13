import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleMinus, Info, ListChecks, TriangleAlert } from 'lucide-react'
import type { EvalDoc, EvalHeadline } from '../types'
import { RESEARCH_QUESTIONS } from '../lib/research'

const STATUS = {
  pass: { icon: CircleCheck, text: 'Met' },
  fail: { icon: CircleMinus, text: 'Not met' },
  info: { icon: Info, text: 'Reported' },
} as const

const BASELINES: Record<string, string> = {
  ai_ignoring_log: 'AI-only alerts that ignore where the reader looked',
  colorhist_control: 'colour-histogram control',
  random_unseen: 'random unseen tissue',
  densest_unseen: 'densest unseen tissue',
  colleague_read: 'a colleague’s independent read',
}

/** Turn evaluation notes into plain language: no Python dicts, no internal identifiers. */
export function cleanNote(s: string): string {
  return s
    .replace(/\{([^}]*)\}/g, (_, body: string) => body.replace(/'/g, '').replace(/:\s*/g, ' ').replace(/,\s*/g, ', '))
    .replace(/\b(ai_ignoring_log|colorhist_control|random_unseen|densest_unseen|colleague_read)\b/g, (m) => BASELINES[m] ?? m)
    .replace(/\brealised\b/g, 'actual')
}

/** Drop developer instructions from caveats while keeping the limitation itself. */
export function cleanCaveat(s: string): string {
  return s
    .replace(/;?\s*run with [^;.]*/gi, '')
    .replace(/\s*\((?:run [^)]*|Delta job|[\w.-]+\.csv)\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.;,])/g, '$1')
    .trim()
}

/** One sample-size line per evaluation, from its structured fields (nothing invented). */
function sampleLine(key: string, d: EvalDoc): string | null {
  const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : null)
  const o = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
  if (key === 'features') {
    const l = o(d.lymph_node)
    return l.available ? `${n(l.n_tiles)} tiles (${n(l.n_pos)} tumour) from ${n(l.n_slides)} CAMELYON16 test slides. Colon (NCT-CRC-HE): not yet evaluated.` : null
  }
  if (key === 'artifacts') {
    const s = o(d.synthetic)
    return s.available ? `${n(s.n_tiles)} CAMELYON16 training tiles with injected damage. No real labelled artifact tiles yet.` : null
  }
  if (key === 'disagreement') {
    const c = o(d.camelyon16)
    return c.available ? `${n(c.n_tiles)} tiles from ${n(c.n_slides)} CAMELYON16 test slides, ${n(c.n_errors)} model errors. Colon (NCT): not yet evaluated.` : null
  }
  if (key === 'unseen') {
    const p = o(d.primary)
    return p.n_reads ? `${n(p.n_reads)} recorded reads (${n(p.n_benign_reads)} benign calls, ${n(p.n_tumor_benign_reads)} of them on tumour slides; ${n(p.n_search_miss)} search misses).` : null
  }
  if (key === 'policy') {
    const b = o(d.bootstrap)
    return d.n_patches ? `${n(d.n_patches)} patches from ${n(d.n_slides)} slides, 7 residents each; ${n(b.reps)} bootstrap resamples by ${String(b.unit ?? 'slide')}.` : null
  }
  return null
}

function Row({ h, context }: { h: EvalHeadline; context?: boolean }) {
  const S = h.status ? STATUS[h.status] : null
  const sanity = /sanity only/i.test(h.label)
  return (
    <div className={`headline ${context ? 'is-context' : ''}`}>
      <span className="headline-label">{context && <span className="tag">Context</span>} {h.label.replace(/\s*\(sanity only\)/i, '')}</span>
      <span className="headline-value num">{h.value}</span>
      <span className="headline-meta">
        {h.ci && <span className="num">CI {h.ci.replace(/^by slide /, 'by slide: ')}</span>}
        {S && <span className={`headline-status is-${h.status}`}><S.icon size={12} aria-hidden />{S.text}</span>}
        {sanity && <span className="headline-status is-info"><Info size={12} aria-hidden />Sanity check only</span>}
      </span>
      {h.note && <div className="headline-note">{cleanNote(h.note)}</div>}
    </div>
  )
}

/** One evaluation: question, dataset and sample size, results (context rows marked), limitations. */
export function EvalCard({ k, d }: { k: string; d: EvalDoc }) {
  const [raw, setRaw] = useState(false)
  const rows = d.headline ?? []
  const caveats = (d.caveats ?? []).map(cleanCaveat).filter(Boolean)
  const sample = sampleLine(k, d)
  return (
    <article className="panel eval-card" aria-labelledby={`eval-${k}`}>
      <div className="eval-head">
        <h3 id={`eval-${k}`}>{RESEARCH_QUESTIONS[k] ?? d.title ?? k}</h3>
      </div>
      <dl className="eval-meta">
        {d.dataset && <div><dt>Dataset</dt><dd>{d.dataset}</dd></div>}
        {sample && <div><dt>Sample</dt><dd>{sample}</dd></div>}
      </dl>
      {d.error && <div className="notice warn"><TriangleAlert size={14} aria-hidden />{d.error}</div>}
      <div className="headlines">
        {rows.map((h) => <Row key={h.label} h={h} context={k === 'unseen' && !h.status && /search misses \(never/i.test(h.label)} />)}
      </div>
      {caveats.length > 0 && (
        <div className="limits">
          <div className="limits-title"><ListChecks size={13} aria-hidden /> Limitations</div>
          <ul>{caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      <button type="button" className="link-btn small raw-toggle" aria-expanded={raw} onClick={() => setRaw(!raw)}>
        {raw ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {raw ? 'Hide' : 'Show'} source data (JSON)
      </button>
      {raw && <pre className="raw">{JSON.stringify(d, null, 1)}</pre>}
    </article>
  )
}
