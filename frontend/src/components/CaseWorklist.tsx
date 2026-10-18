import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Inbox, Search, TriangleAlert } from 'lucide-react'
import type { CaseRow, Health } from '../types'
import type { CaseActivity } from '../lib/activity'
import { href } from '../lib/router'
import {
  ARTIFACT_FLAG, SEGMENT_LABEL, actionLabel, displayStatus, matchesSegment, needsAttention, routingLabel, routingScore, type Segment,
} from '../lib/status'
import { absoluteTime, pct1, relativeTime, score, tissueLabel } from '../lib/format'
import DataTable, { type Column, type SortState } from './ui/DataTable'
import StatusBadge from './ui/StatusBadge'
import Tabs from './ui/Tabs'
import { ButtonLink } from './ui/Button'
import EmptyState, { SkeletonRows } from './ui/EmptyState'

interface Props {
  variant: 'overview' | 'full'
  cases: CaseRow[]
  loading: boolean
  error: string | null
  activity: Record<string, CaseActivity>
  health: Health | null
  currentCaseId: string | null
  onOpen: (caseId: string) => void
  maxRows?: number
  footer?: (shown: number, total: number) => ReactNode
}

const STATUS_ORDER: Record<string, number> = { assessed: 0, opened: 1, in_review: 1, unread: 2, signed_out: 3 }
const DEFAULT_SORT: SortState = { key: 'routing', dir: 'desc' }

/** Worklist filters persist per reader (this browser) across reloads. */
function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = window.localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial } catch { return initial }
  })
  useEffect(() => { try { window.localStorage.setItem(key, JSON.stringify(v)) } catch { /* storage unavailable */ } }, [key, v])
  return [v, setV]
}

export default function CaseWorklist(p: Props) {
  const k = `claripath.worklist.${p.variant}`
  const [query, setQuery] = usePersisted(`${k}.q`, '')
  const [segment, setSegment] = usePersisted<Segment>(`${k}.seg`, p.variant === 'overview' ? 'open' : 'all')
  const [tier, setTier] = usePersisted<'all' | 'slow' | 'fast'>(`${k}.tier`, 'all')
  const [sort, setSort] = usePersisted<SortState | null>(`${k}.sort`, DEFAULT_SORT)

  const signal = p.cases[0]?.routing_signal
  const primaryLabel = signal === 'entropy' ? 'Uncertainty' : 'Disagreement'
  const secondaryLabel = signal === 'entropy' ? 'Disagreement' : 'Uncertainty'
  const routingSource = p.health?.thresholds?.routing_signal?.source

  const counts = useMemo(() => {
    const segs: Segment[] = ['all', 'attention', 'in_review', 'unread', 'signed_out', 'open']
    return Object.fromEntries(segs.map((s) => [s, p.cases.filter((c) => matchesSegment(c, s)).length])) as Record<Segment, number>
  }, [p.cases])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return p.cases.filter((c) => matchesSegment(c, segment)
      && (tier === 'all' || c.tier === tier)
      && (!q || c.slide_id.toLowerCase().includes(q) || c.case_id.toLowerCase().includes(q) || c.organ.toLowerCase().includes(q)))
  }, [p.cases, query, segment, tier])

  const rankOf = useMemo(() => {
    const ranked = [...p.cases].filter((c) => routingScore(c) !== null).sort((a, b) => (routingScore(b) ?? 0) - (routingScore(a) ?? 0))
    return Object.fromEntries(ranked.map((c, i) => [c.case_id, i + 1])) as Record<string, number>
  }, [p.cases])

  const columns = useMemo<Column<CaseRow>[]>(() => {
    const cols: Column<CaseRow>[] = [
      { key: 'case', header: 'Case', priority: 0, minWidth: 110, sortValue: (c) => c.slide_id,
        cell: (c) => (
          <div className="cell-case">
            <span className="mono">{c.slide_id}</span>
            <span className="cell-sub">{tissueLabel(c.organ)}</span>
          </div>
        ) },
      { key: 'status', header: 'Status', priority: 0, minWidth: 130, sortValue: (c) => STATUS_ORDER[displayStatus(c, p.activity[c.case_id])] ?? 9,
        cell: (c) => <StatusBadge kind="review" value={displayStatus(c, p.activity[c.case_id])} /> },
      { key: 'tier', header: 'Routing', priority: 1, minWidth: 128, sortValue: (c) => (c.tier === 'slow' ? 0 : c.tier === 'fast' ? 1 : 2),
        info: (
          <>
            <strong>Fast / slow path.</strong> Cases ranked in the top 15% by {routingLabel(signal).toLowerCase()} go to the slow path,
            where your own assessment is recorded before AI evidence is shown. A rank cut-off, not a clinical urgency score.
          </>
        ),
        cell: (c) => <StatusBadge kind="tier" value={c.tier} /> },
      { key: 'routing', header: primaryLabel, align: 'right', priority: 0, minWidth: 150, firstDir: 'desc', sortValue: (c) => routingScore(c),
        info: (
          <>
            <strong>{routingLabel(signal)}: the routing signal.</strong>{' '}
            {signal === 'entropy'
              ? 'Normalised entropy of the tumour probe (0–1, higher = less certain), taken as the 90th percentile over the case’s tissue tiles.'
              : 'Case-level 90th percentile of the tile disagreement rank between two pathology models (0–1).'}{' '}
            Not a probability of cancer. "#n" is the case’s rank among all {p.cases.length} cases.
            {routingSource && <><br /><br />Why this signal: {routingSource}.</>}
          </>
        ),
        cell: (c) => {
          const v = routingScore(c)
          return (
            <span className="meter">
              <span className="meter-rank num">{rankOf[c.case_id] ? `#${rankOf[c.case_id]}` : ''}</span>
              <span className="meter-track" aria-hidden><span className="meter-fill" style={{ width: `${Math.max(0, Math.min(1, v ?? 0)) * 100}%` }} /></span>
              <span className="meter-val num">{score(v)}</span>
            </span>
          )
        } },
      { key: 'secondary', header: secondaryLabel, align: 'right', priority: p.variant === 'overview' ? 5 : 3, minWidth: 116, firstDir: 'desc',
        sortValue: (c) => (signal === 'entropy' ? c.disagreement_score : c.uncertainty_score),
        info: signal === 'entropy' ? (
          <>
            <strong>Model disagreement (shown for comparison; not used for routing).</strong> 90th-percentile tile rank of disagreement
            between PLIP and QuiltNet (0–1). In evaluation it caught fewer model errors than uncertainty, so it does not set the tier.
          </>
        ) : <>Single-model uncertainty, shown for comparison.</>,
        cell: (c) => <span className="num muted">{score(signal === 'entropy' ? c.disagreement_score : c.uncertainty_score)}</span> },
    ]
    if (p.variant === 'full') {
      cols.push({ key: 'artifact', header: 'Artifacts', align: 'right', priority: 4, minWidth: 104, firstDir: 'desc', sortValue: (c) => c.artifact_share,
        info: <>Share of tissue tiles flagged by the artifact gate (blur, ink, folds). Flagged above {ARTIFACT_FLAG * 100}%; flagged tiles are excluded from disagreement.</>,
        cell: (c) => c.artifact_share === null ? <span className="muted">—</span>
          : c.artifact_share > ARTIFACT_FLAG
            ? <span className="tag warn-tag"><TriangleAlert size={12} aria-hidden />{pct1(c.artifact_share)}<span className="sr-only"> of tiles, above the flag level</span></span>
            : <span className="muted num">{pct1(c.artifact_share)}</span> })
      cols.push({ key: 'reads', header: 'Replays', align: 'right', priority: 6, minWidth: 96, firstDir: 'desc', sortValue: (c) => c.recorded_reads,
        info: <>Recorded PathoGaze eye-tracking reads available to replay in Slide Review.</>,
        cell: (c) => c.recorded_reads ? <span className="num">{c.recorded_reads}</span> : <span className="muted">—</span> })
    }
    cols.push(
      { key: 'activity', header: 'Last opened', align: 'right', priority: 2, minWidth: 124, firstDir: 'desc',
        sortValue: (c) => p.activity[c.case_id]?.lastOpened ?? null,
        info: <>Most recent event on a read of this case (opening, viewing, assessing), from the audit log of any session.</>,
        cell: (c) => {
          const t = p.activity[c.case_id]?.lastOpened
          return t ? <time dateTime={t} title={absoluteTime(t)} className="num nowrap">{relativeTime(t, true)}</time> : <span className="muted">—</span>
        } },
      { key: 'open', header: 'Action', align: 'right', priority: 0, minWidth: 108, sticky: true,
        cell: (c) => {
          const cur = p.currentCaseId === c.case_id
          const label = actionLabel(c, cur)
          return (
            <ButtonLink size="sm" variant={cur ? 'primary' : 'secondary'} href={href({ page: 'review', caseId: c.case_id })}
              iconRight={ArrowRight} aria-label={`${label} ${c.slide_id}`}>
              {label}
            </ButtonLink>
          )
        } },
    )
    return cols
  }, [p.variant, p.activity, p.currentCaseId, p.cases.length, signal, primaryLabel, secondaryLabel, routingSource, rankOf])

  const segTabs = p.variant === 'full'
    ? (['all', 'attention', 'in_review', 'unread', 'signed_out'] as Segment[]).map((id) => ({ id, label: SEGMENT_LABEL[id], count: counts[id] }))
    : null

  const defaultSeg: Segment = p.variant === 'overview' ? 'open' : 'all'
  const filtersActive = query !== '' || tier !== 'all' || segment !== defaultSeg

  return (
    <div className="worklist">
      {segTabs && (
        <Tabs tabs={segTabs} value={segment} onChange={(s) => setSegment(s as Segment)} label="Case groups" idPrefix="cases-seg" />
      )}
      <div className="worklist-toolbar" id={segTabs ? 'cases-seg-panel' : undefined}>
        <label className="input-search">
          <Search size={14} aria-hidden />
          <span className="sr-only">Search cases</span>
          <input className="input" type="search" placeholder="Search slide ID or tissue" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {!segTabs && (
          <label className="field-inline">
            <span>Status</span>
            <select className="select" value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
              {(['open', 'all', 'attention', 'in_review', 'unread', 'signed_out'] as Segment[]).map((s) => (
                <option key={s} value={s}>{SEGMENT_LABEL[s]} · {counts[s]}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field-inline">
          <span>Routing</span>
          <select className="select" value={tier} onChange={(e) => setTier(e.target.value as typeof tier)}>
            <option value="all">All paths</option>
            <option value="slow">Slow path</option>
            <option value="fast">Fast path</option>
          </select>
        </label>
        {filtersActive && (
          <button type="button" className="link-btn small" onClick={() => { setQuery(''); setTier('all'); setSegment(defaultSeg) }}>
            Clear filters
          </button>
        )}
        <span className="worklist-count muted small num" aria-live="polite">
          {p.maxRows && rows.length > p.maxRows ? `Top ${p.maxRows} of ${rows.length}` : `${rows.length} case${rows.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {p.error ? (
        <EmptyState icon={TriangleAlert} tone="warning" title="Cases could not be loaded">{p.error}</EmptyState>
      ) : p.loading ? (
        <SkeletonRows rows={p.maxRows ? Math.min(p.maxRows, 8) : 10} cols={6} />
      ) : (
        <DataTable rows={rows} columns={columns} rowKey={(c) => c.case_id}
          caption={p.variant === 'overview' ? 'Priority review queue' : 'Case worklist'}
          sort={sort} onSortChange={setSort} defaultSort={DEFAULT_SORT}
          onRowClick={(c) => p.onOpen(c.case_id)}
          isSelected={(c) => c.case_id === p.currentCaseId}
          rowClassName={(c) => (needsAttention(c) ? 'row-attention' : c.review_status === 'signed_out' ? 'row-done' : undefined)}
          maxRows={p.maxRows}
          empty={<EmptyState icon={Inbox} title={p.cases.length ? 'No cases match these filters' : 'No cases in the data bundle'}>
            {p.cases.length ? 'Clear the search or filters to see more.' : 'Run the pipeline to populate the bundle (see README).'}
          </EmptyState>} />
      )}
      {p.footer && !p.loading && !p.error && p.footer(Math.min(rows.length, p.maxRows ?? rows.length), rows.length)}
    </div>
  )
}
