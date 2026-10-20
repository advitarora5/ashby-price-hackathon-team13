import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight, CircleCheck, CircleDashed, CircleDot, ClipboardCheck, EyeOff, FolderOpen, History, Play, ScanSearch,
} from 'lucide-react'
import type { CaseRow, EvalDoc, Health } from '../types'
import type { CaseActivity } from '../lib/activity'
import { href } from '../lib/router'
import { displayStatus, needsAttention, routingLabel, routingScore } from '../lib/status'
import { absoluteTime, relativeTime, score, tissueLabel } from '../lib/format'
import CaseWorklist from '../components/CaseWorklist'
import Panel from '../components/ui/Panel'
import StatTile from '../components/ui/StatTile'
import StatusBadge from '../components/ui/StatusBadge'
import { ButtonLink } from '../components/ui/Button'
import EmptyState, { Skeleton } from '../components/ui/EmptyState'
import ResearchSummary from '../components/ResearchSummary'

interface Props {
  cases: CaseRow[]
  loading: boolean
  error: string | null
  health: Health | null
  activity: Record<string, CaseActivity>
  evalDocs: Record<string, EvalDoc> | null
  evalErr: string | null
  currentCaseId: string | null
  blindAll: boolean
  onOpen: (caseId: string) => void
}

/** Queue length follows the window height so large screens are not left empty. */
function useQueueRows() {
  const calc = () => Math.max(8, Math.min(30, Math.floor((window.innerHeight - 430) / 44)))
  const [n, setN] = useState(calc)
  useEffect(() => {
    const on = () => setN(calc())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return n
}

export default function OverviewPage(p: Props) {
  const maxRows = useQueueRows()
  const stats = useMemo(() => {
    const st = p.cases.map((c) => displayStatus(c, p.activity[c.case_id]))
    const n = (s: string) => st.filter((x) => x === s).length
    return {
      total: p.cases.length, unread: n('unread'), opened: n('opened') + n('in_review'), assessed: n('assessed'), done: n('signed_out'),
      slow: p.cases.filter((c) => c.tier === 'slow').length,
      attention: p.cases.filter(needsAttention).length,
    }
  }, [p.cases, p.activity])

  /** Cases with an open read, most recently opened first (audit log). */
  const inProgress = useMemo(() => p.cases
    .filter((c) => c.review_status === 'in_review')
    .sort((a, b) => (p.activity[b.case_id]?.lastOpened ?? '').localeCompare(p.activity[a.case_id]?.lastOpened ?? '')), [p.cases, p.activity])

  // Server order = routing signal, highest first. Next priority = first not-started case.
  const nextCase = useMemo(() => p.cases.find((c) => c.review_status === 'unread') ?? null, [p.cases])
  const resume = inProgress[0] ?? null

  const signal = p.cases[0]?.routing_signal
  const datasets = [...new Set(p.cases.map((c) => `${tissueLabel(c.organ)} (${c.dataset.toUpperCase()})`))]

  const primary = resume
    ? { label: `Resume review · ${resume.slide_id}`, to: resume.case_id, icon: Play }
    : nextCase ? { label: `Open next priority case · ${nextCase.slide_id}`, to: nextCase.case_id, icon: ArrowRight } : null

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-header">
          <div>
            <h1>Overview</h1>
            <div className="page-context">
              {p.loading ? <Skeleton width={320} /> : (
                <>
                  <span>{stats.total} cases · {datasets.join(', ') || 'no data'}</span>
                  <span>Queue ordered by {routingLabel(signal).toLowerCase()}</span>
                  {p.blindAll && <span className="inline-flag"><EyeOff size={13} aria-hidden /> Blind-first on for all cases</span>}
                </>
              )}
            </div>
          </div>
          <div className="page-actions">
            <ButtonLink variant="secondary" href={href({ page: 'cases' })} icon={FolderOpen}>All cases</ButtonLink>
            {primary && (
              <ButtonLink variant="primary" href={href({ page: 'review', caseId: primary.to })} icon={primary.icon}>{primary.label}</ButtonLink>
            )}
          </div>
        </header>

        <div className="stat-row" role="group" aria-label="Workload summary">
          <StatTile label="Cases in worklist" value={stats.total} loading={p.loading} icon={FolderOpen}
            hint={p.health ? `of ${p.health.cases} in data bundle` : 'from /api/cases'} />
          <StatTile label="Not started" value={stats.unread} loading={p.loading} icon={CircleDashed} hint="no read opened yet" />
          <StatTile label="Opened" value={stats.opened} loading={p.loading} icon={CircleDot} tone="info" hint="read opened, no assessment yet" />
          <StatTile label="Assessed" value={stats.assessed} loading={p.loading} icon={ClipboardCheck} tone="info"
            hint="assessment recorded, no sign-out check" />
          <StatTile label="Completed" value={stats.done} loading={p.loading} icon={CircleCheck} tone="success" hint="research sign-out check run" />
          <StatTile label="Slow path · open" value={<>{stats.attention}<small>of {stats.slow}</small></>} loading={p.loading} icon={ScanSearch} tone="accent"
            hint={`top 15% by ${routingLabel(signal).toLowerCase()}`}
            info={<>Cases ranked in the top 15% by {routingLabel(signal).toLowerCase()} (a rank cut-off; no validation-derived threshold yet)
              that are not yet completed. They open blind-first. A review-routing group, not a clinical urgency score.</>} />
        </div>

        <div className="overview-grid">
          <Panel title="Priority review queue" id="ov-queue" flush className="queue-panel"
            subtitle={signal === 'entropy'
              ? <>Open cases, highest model uncertainty first. Uncertainty = normalised entropy of the tumour probe (0–1, higher = less certain); not a probability of cancer.</>
              : <>Open cases, highest model disagreement first. Disagreement is a 0–1 rank; not a probability of cancer.</>}>
            <CaseWorklist variant="overview" cases={p.cases} loading={p.loading} error={p.error} activity={p.activity}
              health={p.health} currentCaseId={p.currentCaseId} onOpen={p.onOpen} maxRows={maxRows}
              footer={(shown, total) => total > shown && (
                <div className="worklist-foot">
                  <a href={href({ page: 'cases' })} className="small">View all {total} matching cases in Cases <ArrowRight size={13} aria-hidden /></a>
                </div>
              )} />
          </Panel>

          <div className="overview-side">
            <Panel title="Continue reviewing" id="ov-continue" level={2} flush subtitle="Open reads, most recently opened first. Resume restores your read.">
              {p.loading ? <div className="list-pad"><Skeleton width="70%" /><Skeleton width="50%" /></div>
                : inProgress.length === 0 ? (
                  <EmptyState icon={History} title="No reads in progress">
                    {nextCase ? <>Next by priority: <span className="mono">{nextCase.slide_id}</span>.</> : 'All cases are completed.'}
                  </EmptyState>
                ) : (
                  <ul className="resume-list">
                    {inProgress.slice(0, 5).map((c) => {
                      const t = p.activity[c.case_id]?.lastOpened
                      return (
                        <li key={c.case_id}>
                          <a className="resume-item" href={href({ page: 'review', caseId: c.case_id })}
                            aria-label={`Resume ${c.slide_id}${t ? `, last opened ${relativeTime(t)}` : ''}`}>
                            <span className="resume-main">
                              <span className="mono strong">{c.slide_id}</span>
                              <StatusBadge kind="review" value={displayStatus(c, p.activity[c.case_id])} />
                              <StatusBadge kind="tier" value={c.tier} />
                            </span>
                            <span className="resume-meta">
                              {t ? <time dateTime={t} title={absoluteTime(t)}>{relativeTime(t, true)}</time> : <span>no activity logged</span>}
                              <span className="num">· {signal === 'entropy' ? 'uncertainty' : 'disagreement'} {score(routingScore(c))}</span>
                            </span>
                            <ArrowRight size={15} aria-hidden className="resume-arrow" />
                          </a>
                        </li>
                      )
                    })}
                    {inProgress.length > 5 && (
                      <li className="resume-more"><a href={href({ page: 'cases' })} className="small">{inProgress.length - 5} more in progress</a></li>
                    )}
                  </ul>
                )}
            </Panel>

            <ResearchSummary docs={p.evalDocs} error={p.evalErr} />
          </div>
        </div>
      </div>
    </div>
  )
}
