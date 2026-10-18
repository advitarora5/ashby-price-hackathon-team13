import { ArrowRight, FlaskConical, TriangleAlert } from 'lucide-react'
import type { EvalDoc } from '../types'
import { href } from '../lib/router'
import { SUMMARY_KEYS } from '../lib/research'
import Panel from './ui/Panel'
import EmptyState, { Skeleton } from './ui/EmptyState'


interface Props { docs: Record<string, EvalDoc> | null; error: string | null }

export default function ResearchSummary({ docs, error }: Props) {
  const items = docs ? SUMMARY_KEYS.filter((k) => docs[k] && !docs[k].error && docs[k].headline?.length) : []
  return (
    <Panel title="Research evidence" id="ov-research" flush
      subtitle="Module-level evaluations on separate datasets. Not a clinical validation."
      actions={<a href={href({ page: 'research' })} className="small nowrap">Research Insights <ArrowRight size={13} aria-hidden /></a>}>
      {error ? <EmptyState icon={TriangleAlert} tone="warning" title="Evaluation results unavailable">{error}</EmptyState>
        : !docs ? <div className="list-pad"><Skeleton width="80%" /><Skeleton width="60%" /><Skeleton width="70%" /></div>
          : items.length === 0 ? <EmptyState icon={FlaskConical} title="No evaluation outputs yet">Run <code>python -m secondlook.eval.run_all</code>.</EmptyState>
            : (
              <ul className="research-list">
                {items.map((k) => {
                  const d = docs[k]
                  const h = d.headline![0]
                  return (
                    <li key={k} className="research-item">
                      <div className="research-head">
                        <span className="research-title">{d.title ?? k}</span>
                        {d.measure && <span className="tag">{d.measure}</span>}
                      </div>
                      <div className="research-metric">
                        <span className="research-value num">{h.value}</span>
                        <span className="research-label">{h.label}{h.ci ? <span className="muted num"> · CI {h.ci}</span> : null}</span>
                      </div>
                      {d.dataset && <div className="research-dataset">Dataset: {d.dataset}</div>}
                    </li>
                  )
                })}
              </ul>
            )}
    </Panel>
  )
}
