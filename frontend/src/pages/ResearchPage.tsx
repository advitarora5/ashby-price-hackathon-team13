import { FlaskConical } from 'lucide-react'
import type { EvalDoc, Health, PolicySummary } from '../types'
import EvalView from '../components/EvalView'
import PolicyCostTable from '../components/PolicyCostTable'
import Panel from '../components/ui/Panel'

interface Props { docs: Record<string, EvalDoc> | null; error: string | null; summary: PolicySummary | null; health: Health | null }

export default function ResearchPage({ docs, error, summary, health }: Props) {
  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-header">
          <div>
            <h1>Research Insights</h1>
            <div className="page-context">
              <span>Each measure is tested on the dataset that fits it (lymph node, prostate, colon). These are separate module-level evaluations, not an end-to-end clinical validation.</span>
            </div>
          </div>
        </header>
        <div className="notice" role="note">
          <FlaskConical size={15} aria-hidden />
          <span>
            Numbers come straight from <code>bundle/eval/*.json</code> through <code>/api/eval/summary</code>.
            Results from different organs and tasks are never combined into one score.
            {health?.provenance && <> Live review data: {health.provenance}.</>}
          </span>
        </div>
        <EvalView docs={docs} error={error} />
        <Panel title="What each reader policy costs" id="rs-policy" flush
          subtitle="Human reads per 100 cases against agreement with the expert reference (CrowdGleason prostate test set)">
          <PolicyCostTable summary={summary} />
        </Panel>
      </div>
    </div>
  )
}
