import type { ReactNode } from 'react'
import { ArrowRight, CircleCheck, CircleMinus, FlaskConical, Info, TriangleAlert } from 'lucide-react'
import type { EvalDoc } from '../types'
import { href } from '../lib/router'
import Panel from './ui/Panel'
import EmptyState, { Skeleton } from './ui/EmptyState'

type Status = 'pass' | 'fail' | 'info'
interface Summary { key: string; question: string; status: Status; result: ReactNode; context: ReactNode; dataset?: string }

const STATUS = {
  pass: { icon: CircleCheck, text: 'Met' },
  fail: { icon: CircleMinus, text: 'Not met' },
  info: { icon: Info, text: 'Reported' },
} as const

const find = (d: EvalDoc, re: RegExp) => d.headline?.find((h) => re.test(h.label))
const grab = (s: string | undefined, re: RegExp) => s?.match(re)?.[1]
const caveat = (d: EvalDoc, re: RegExp) => d.caveats?.find((c) => re.test(c))

/**
 * One deliberately chosen, result-oriented line per research question. Every number is read from
 * /api/eval/summary; if the expected headline is missing the item is skipped rather than guessed.
 */
function summarise(docs: Record<string, EvalDoc>): Summary[] {
  const out: Summary[] = []
  const f = docs.features
  if (f && !f.error) {
    const probe = find(f, /tumou?r probe/i)
    const bar = find(f, /metastasis/i)
    if (probe) out.push({
      key: 'features', question: 'Do the evidence scores separate tumour from benign tiles?', status: probe.status ?? 'info',
      result: <>Tumour probe tile AUROC <b className="num">{probe.value}</b>{probe.ci && <span className="muted num"> (CI {probe.ci})</span>}</>,
      context: <>{bar ? <>Text-prompt “metastasis” bar: {bar.value}. </> : null}{grab(bar?.label, /(\d+ test slides?)/i) ?? ''}{bar ? '; tile level only.' : ''}</>,
      dataset: 'CAMELYON16 test slides (lymph node)',
    })
  }
  const g = docs.disagreement
  if (g && !g.error) {
    const h = find(g, /model errors/i) ?? g.headline?.[0]
    const ent = grab(h?.note, /entropy\s+([\d.]+%)/i)
    if (h) out.push({
      key: 'disagreement', question: 'Does model disagreement find the model’s errors?', status: h.status ?? 'info',
      result: h.status === 'fail' && ent
        ? <>No: single-model uncertainty caught more errors (<b className="num">{ent}</b> vs <b className="num">{h.value}</b> in the top 15%)</>
        : <><b className="num">{h.value}</b> of errors in the top 15%{ent ? <> (uncertainty baseline {ent})</> : null}</>,
      context: <>So cases are routed by uncertainty; disagreement is shown for comparison only.{h.ci && <span className="num"> Disagreement CI {h.ci}.</span>}</>,
      dataset: 'CAMELYON16 test-slide tiles',
    })
  }
  const u = docs.unseen
  if (u && !u.error) {
    const h = find(u, /<=\s*1(\.0)? alert/i)
    const base = grab(h?.note, /ai_ignoring_log\s+([\d.]+%)/i)
    const colleague = grab(h?.note, /colleague_read\s+([\d.]+%)/i)
    const size = caveat(u, /effective sample/i)
    if (h) out.push({
      key: 'unseen', question: 'Do unseen-tissue alerts catch search misses?', status: h.status ?? 'info',
      result: <>Caught <b className="num">{h.value}</b> of search misses at ≤1 alert per benign read{h.ci && <span className="muted num"> ({h.ci})</span>}</>,
      context: <>{base && <>Same as an AI-only baseline that ignores where the reader looked ({base}){colleague ? `; a colleague's read: ${colleague}` : ''}. </>}{size?.replace(/^Effective sample:\s*/i, 'Sample: ')}</>,
      dataset: u.dataset,
    })
  }
  const p = docs.policy
  if (p && !p.error) {
    const one = find(p, /^1 resident/i)
    const five = find(p, /majority of 5/i)
    const ref = caveat(p, /expert reference/i)
    if (one) out.push({
      key: 'policy', question: 'How many human reads does a reliable call need?', status: one.status ?? 'info',
      result: <>1 resident agrees with the reference <b className="num">{one.value}</b>{five ? <>; majority of 5: <b className="num">{five.value}</b> at 500 reads / 100 cases</> : null}</>,
      context: <>{ref ? 'Caveat: the expert reference may have been formed with the residents’ labels visible. ' : ''}AI-supported policy not yet run.</>,
      dataset: 'CrowdGleason test set (prostate)',
    })
  }
  return out
}

export default function ResearchSummary({ docs, error }: { docs: Record<string, EvalDoc> | null; error: string | null }) {
  const items = docs ? summarise(docs) : []
  return (
    <Panel title="Research evidence" id="ov-research" flush
      subtitle="Separate module-level evaluations, each on its own dataset. Not a clinical validation."
      actions={<a href={href({ page: 'research' })} className="small nowrap">Details <ArrowRight size={13} aria-hidden /></a>}>
      {error ? <EmptyState icon={TriangleAlert} tone="warning" title="Evaluation results unavailable">{error}</EmptyState>
        : !docs ? <div className="list-pad"><Skeleton width="80%" /><Skeleton width="60%" /><Skeleton width="70%" /></div>
          : items.length === 0 ? <EmptyState icon={FlaskConical} title="No evaluation outputs yet">Run <code>python -m secondlook.eval.run_all</code>.</EmptyState>
            : (
              <ul className="research-list">
                {items.map((it) => {
                  const S = STATUS[it.status]
                  return (
                    <li key={it.key} className="research-item">
                      <div className="research-head">
                        <span className="research-title">{it.question}</span>
                        <span className={`headline-status is-${it.status}`}><S.icon size={12} aria-hidden />{S.text}</span>
                      </div>
                      <div className="research-result">{it.result}</div>
                      <div className="research-dataset">{it.context}{it.dataset && <> Dataset: {it.dataset}.</>}</div>
                    </li>
                  )
                })}
              </ul>
            )}
    </Panel>
  )
}

