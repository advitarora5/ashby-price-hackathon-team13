import { useMemo } from 'react'
import {
  ArrowRight, CircleCheck, CircleDashed, CircleDot, EyeOff, FolderOpen, History, Play, ScanSearch,
} from 'lucide-react'
import type { CaseRow, EvalDoc, Health } from '../types'
import { href } from '../lib/router'
import { needsAttention, routingLabel, routingScore } from '../lib/status'
import { absoluteTime, relativeTime, tissueLabel } from '../lib/format'
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
  lastActivity: Record<string, string>
  evalDocs: Record<string, EvalDoc> | null
  evalErr: string | null
  currentCaseId: string | null
  blindAll: boolean
  onOpen: (caseId: string) => void
}

export default function OverviewPage(p: Props) {
  const stats = useMemo(() => {
    const by = (s: string) => p.cases.filter((c) => c.review_status === s).length
    return {
      total: p.cases.length, unread: by('unread'), inReview: by('in_review'), done: by('signed_out'),
      slow: p.cases.filter((c) => c.tier === 'slow').length,
      attention: p.cases.filter(needsAttention).length,
    }
  }, [p.cases])

  /** In-review cases, most recently touched first (audit log). */
  const inProgress = useMemo(() => p.cases
    .filter((c) => c.review_status === 'in_review')
    .sort((a, b) => (p.lastActivity[b.case_id] ?? '').localeCompare(p.lastActivity[a.case_id] ?? '')), [p.cases, p.lastActivity])

  // Server order = routing signal, highest first. Next priority = first not-started case.
  const nextCase = useMemo(() => p.cases.find((c) => c.review_status === 'unread' && c.tier === 'slow')
    ?? p.cases.find((c) => c.review_status === 'unread') ?? null, [p.cases])
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
                  <span className="sep" aria-hidden>|</span>
                  <span>Queue ordered by {routingLabel(signal).toLowerCase()}</span>
                  {p.blindAll && (<><span className="sep" aria-hidden>|</span><span className="inline-flag"><EyeOff size={13} aria-hidden /> Blind-first on for all cases</span></>)}
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
          <StatTile label="Not started" value={stats.unread} loading={p.loading} icon={CircleDashed}
            hint="no read opened yet" />
          <StatTile label="In review" value={stats.inReview} loading={p.loading} icon={CircleDot} tone="info"
            hint="read opened, no sign-out check" />
          <StatTile label="Completed" value={stats.done} loading={p.loading} icon={CircleCheck} tone="success"
            hint="research sign-out check recorded" />
          <StatTile label="Slow path" value={<>{stats.attention}<small>open of {stats.slow}</small></>} loading={p.loading} icon={ScanSearch} tone="accent"
            hint={`top 15% by ${routingLabel(signal).toLowerCase()}`}
            info={<>Cases ranked in the top 15% by {routingLabel(signal).toLowerCase()} (a rank cut-off; no validation-derived threshold yet).
              They open blind-first. This is a review-routing aid, not a clinical urgency score.</>} />
          <StatTile label="Unseen-tissue alerts open" value="Not available" unavailable icon={EyeOff}
            hint="alerts are per read; not tracked per case"
            info={<>Unseen-region alerts are produced by the sign-out check inside a read. The API does not expose an outstanding-alert count per case, so none is shown here.</>} />
        </div>

        <div className="overview-grid">
          <Panel title="Priority review queue" id="ov-queue" flush
            subtitle={<>Open cases, highest {routingLabel(signal).toLowerCase()} first. Scores are relative ranks, not probabilities.</>}>
            <CaseWorklist variant="overview" cases={p.cases} loading={p.loading} error={p.error} lastActivity={p.lastActivity}
              health={p.health} currentCaseId={p.currentCaseId} onOpen={p.onOpen} maxRows={10}
              footer={(shown, total) => total > shown && (
                <div className="worklist-foot">
                  <a href={href({ page: 'cases' })} className="small">View all {total} matching cases in Cases <ArrowRight size={13} aria-hidden /></a>
                </div>
              )} />
          </Panel>

          <div className="overview-side">
            <Panel title="Continue reviewing" id="ov-continue" level={2} flush
              subtitle="Reads in progress, most recent activity first">
              {p.loading ? <div className="list-pad"><Skeleton width="70%" /><Skeleton width="50%" /></div>
                : inProgress.length === 0 ? (
                  <EmptyState icon={History} title="No reads in progress">
                    {nextCase ? <>Next by priority: <span className="mono">{nextCase.slide_id}</span>.</> : 'All cases are completed.'}
                  </EmptyState>
                ) : (
                  <ul className="resume-list">
                    {inProgress.slice(0, 5).map((c) => {
                      const t = p.lastActivity[c.case_id]
                      return (
                        <li key={c.case_id}>
                          <a className="resume-item" href={href({ page: 'review', caseId: c.case_id })}
                            aria-label={`Resume ${c.slide_id}${t ? `, last activity ${relativeTime(t)}` : ''}`}>
                            <span className="resume-main">
                              <span className="mono strong">{c.slide_id}</span>
                              <StatusBadge kind="tier" value={c.tier} />
                            </span>
                            <span className="resume-meta">
                              {t ? <time dateTime={t} title={absoluteTime(t)}>{relativeTime(t, true)}</time> : <span>no activity logged</span>}
                              <span className="num">· {routingLabel(c.routing_signal).split(' ')[1]} {routingScore(c)?.toFixed(2) ?? '—'}</span>
                            </span>
                            <ArrowRight size={15} aria-hidden className="resume-arrow" />
                          </a>
                        </li>
                      )
                    })}
                    {inProgress.length > 5 && (
                      <li className="resume-more"><a href={href({ page: 'cases' })} className="small">{inProgress.length - 5} more in review</a></li>
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
