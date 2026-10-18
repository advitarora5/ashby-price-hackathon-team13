import type { CaseRow, Health } from '../types'
import type { CaseActivity } from '../lib/activity'
import { routingLabel } from '../lib/status'
import { tissueLabel } from '../lib/format'
import CaseWorklist from '../components/CaseWorklist'

interface Props {
  cases: CaseRow[]
  loading: boolean
  error: string | null
  health: Health | null
  activity: Record<string, CaseActivity>
  currentCaseId: string | null
  onOpen: (caseId: string) => void
}

export default function CasesPage(p: Props) {
  const signal = p.cases[0]?.routing_signal
  const tissues = [...new Set(p.cases.map((c) => `${tissueLabel(c.organ)} · ${c.dataset.toUpperCase()}`))]
  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-header">
          <div>
            <h1>Cases</h1>
            <div className="page-context">
              <span>{p.cases.length} cases{tissues.length ? ` · ${tissues.join(', ')}` : ''}</span>
              <span>Default order: {routingLabel(signal).toLowerCase()}, highest first</span>
              <span>Slow path · open = high-uncertainty cases not yet completed (a routing group, not clinical urgency)</span>
            </div>
          </div>
        </header>
        <section className="panel panel-flush cases-table" aria-label="Case worklist">
          <CaseWorklist variant="full" cases={p.cases} loading={p.loading} error={p.error} activity={p.activity}
            health={p.health} currentCaseId={p.currentCaseId} onOpen={p.onOpen} />
        </section>
        {p.cases.some((c) => c.tier_rule === 'rank_top15') && (
          <p className="small muted footnote">
            Tier cut-off: top 15% by rank (no validation-derived cut-off yet).
            {signal === 'entropy' && ' Model disagreement did not beat single-model uncertainty in evaluation, so tiers use uncertainty; disagreement is still shown.'}
          </p>
        )}
      </div>
    </div>
  )
}
