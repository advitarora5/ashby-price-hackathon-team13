import { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, Inbox, Search, TriangleAlert } from 'lucide-react'
import type { CaseRow, Health } from '../types'
import { href } from '../lib/router'
import { ARTIFACT_FLAG, REVIEW_STATUS, matchesSegment, needsAttention, routingLabel, routingScore, type Segment } from '../lib/status'
import { absoluteTime, pct, relativeTime, score, tissueLabel } from '../lib/format'
import DataTable, { type Column } from './ui/DataTable'
import StatusBadge from './ui/StatusBadge'
import Tabs from './ui/Tabs'
import { ButtonLink } from './ui/Button'
import EmptyState, { SkeletonRows } from './ui/EmptyState'

interface Props {
  variant: 'overview' | 'full'
  cases: CaseRow[]
  loading: boolean
  error: string | null
  lastActivity: Record<string, string>
  health: Health | null
  currentCaseId: string | null
  onOpen: (caseId: string) => void
  maxRows?: number
  footer?: (shown: number, total: number) => ReactNode
}

const STATUS_ORDER: Record<string, number> = { in_review: 0, unread: 1, signed_out: 2 }

function Meter({ value, secondary, label }: { value: number | null; secondary?: boolean; label: string }) {
  return (
    <span className={`meter ${secondary ? 'secondary' : ''}`}>
      <span className="meter-track" aria-hidden><span className="meter-fill" style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} /></span>
      <span className="meter-val num" aria-label={`${label} ${score(value)}`}>{score(value)}</span>
    </span>
  )
}

export default function CaseWorklist(p: Props) {
  const [query, setQuery] = useState('')
  const [segment, setSegment] = useState<Segment>(p.variant === 'overview' ? 'open' : 'all')
  const [tier, setTier] = useState<'all' | 'slow' | 'fast'>('all')

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

  const columns = useMemo<Column<CaseRow>[]>(() => {
    const cols: Column<CaseRow>[] = [
      { key: 'case', header: 'Case', sortValue: (c) => c.slide_id,
        cell: (c) => (
          <div className="cell-case">
            <span className="mono">{c.slide_id}</span>
            <span className="cell-sub">{tissueLabel(c.organ)}{p.variant === 'full' ? ` · ${c.dataset.toUpperCase()}` : ''}</span>
          </div>
        ) },
      { key: 'status', header: 'Status', sortValue: (c) => STATUS_ORDER[c.review_status] ?? 9,
        cell: (c) => <StatusBadge kind="review" value={c.review_status} /> },
      { key: 'tier', header: 'Routing', sortValue: (c) => (c.tier === 'slow' ? 0 : c.tier === 'fast' ? 1 : 2),
        info: (
          <>
            <strong>Fast / slow path.</strong> Cases ranked in the top 15% by {routingLabel(signal).toLowerCase()} go to the slow path,
            where your own assessment is recorded before AI evidence is shown. A rank cut-off, not a clinical urgency score.
          </>
        ),
        cell: (c) => <StatusBadge kind="tier" value={c.tier} /> },
      { key: 'routing', header: primaryLabel, align: 'right', firstDir: 'desc', sortValue: (c) => routingScore(c),
        info: (
          <>
            <strong>{routingLabel(signal)} (routing signal).</strong>{' '}
            {signal === 'entropy'
              ? 'Case-level 90th percentile of tumour-probe entropy across tissue tiles.'
              : 'Case-level 90th percentile of the tile disagreement rank between two pathology models.'}{' '}
            A relative 0–1 score used to order the queue — not a probability of cancer.
            {routingSource && <><br /><br />Chosen because: {routingSource}.</>}
          </>
        ),
        cell: (c) => <Meter value={routingScore(c)} label={primaryLabel} /> },
      { key: 'secondary', header: secondaryLabel, align: 'right', firstDir: 'desc', hideBelow: p.variant === 'overview' ? 1600 : 1100,
        sortValue: (c) => (signal === 'entropy' ? c.disagreement_score : c.uncertainty_score),
        info: signal === 'entropy' ? (
          <>
            <strong>Model disagreement (shown, not used for routing).</strong> 90th-percentile tile rank of disagreement between
            PLIP and QuiltNet ({p.cases[0]?.disagreement_source ?? 'source unknown'}). Relative 0–1 rank. It did not beat single-model
            uncertainty in evaluation, so it does not set the tier.
          </>
        ) : <>Single-model uncertainty, shown for comparison. Relative 0–1 score.</>,
        cell: (c) => <Meter secondary value={signal === 'entropy' ? c.disagreement_score : c.uncertainty_score} label={secondaryLabel} /> },
    ]
    if (p.variant === 'full') {
      cols.push(
      { key: 'artifact', header: 'Artifacts', align: 'right', firstDir: 'desc', hideBelow: 1280, sortValue: (c) => c.artifact_share,
        info: <>Share of tissue tiles flagged by the artifact gate (blur, ink, folds). Called out above {pct(ARTIFACT_FLAG)}; flagged tiles are excluded from disagreement.</>,
        cell: (c) => c.artifact_share === null ? <span className="muted">—</span>
          : c.artifact_share > ARTIFACT_FLAG
            ? <span className="tag warn-tag"><TriangleAlert size={12} aria-hidden />{pct(c.artifact_share)}<span className="sr-only"> of tiles, above flag level</span></span>
            : <span className="muted num">{pct(c.artifact_share)}</span> })
      cols.push({ key: 'reads', header: 'Replays', align: 'right', firstDir: 'desc', hideBelow: 1600, sortValue: (c) => c.recorded_reads,
        info: <>Recorded PathoGaze eye-tracking reads available to replay in Slide Review.</>,
        cell: (c) => c.recorded_reads ? <span className="num">{c.recorded_reads}</span> : <span className="muted">—</span> })
    }
    cols.push(
      { key: 'activity', header: 'Last activity', align: 'right', firstDir: 'desc', sortValue: (c) => p.lastActivity[c.case_id] ?? null,
        info: <>Most recent audit-log event for this case (open, layer change, assessment, sign-out check) from any session.</>,
        cell: (c) => {
          const t = p.lastActivity[c.case_id]
          return t ? <time dateTime={t} title={absoluteTime(t)} className="num nowrap">{relativeTime(t, true)}</time> : <span className="muted">—</span>
        } },
      { key: 'open', header: '', align: 'right', width: '1%',
        cell: (c) => (
          <ButtonLink size="sm" variant={p.currentCaseId === c.case_id ? 'primary' : 'secondary'} href={href({ page: 'review', caseId: c.case_id })}
            iconRight={ArrowRight} aria-label={`${p.currentCaseId === c.case_id ? 'Return to' : 'Open'} ${c.slide_id} in Slide Review`}>
            {p.currentCaseId === c.case_id ? 'Return' : c.review_status === 'in_review' ? 'Resume' : 'Open'}
          </ButtonLink>
        ) },
    )
    return cols
  }, [p.variant, p.lastActivity, p.currentCaseId, p.cases, signal, primaryLabel, secondaryLabel, routingSource])

  const segTabs = p.variant === 'full'
    ? [
        { id: 'all', label: 'All', count: counts.all },
        { id: 'attention', label: 'Needs attention', count: counts.attention },
        { id: 'in_review', label: REVIEW_STATUS.in_review.label, count: counts.in_review },
        { id: 'unread', label: REVIEW_STATUS.unread.label, count: counts.unread },
        { id: 'signed_out', label: REVIEW_STATUS.signed_out.label, count: counts.signed_out },
      ]
    : null

  const filtersActive = query !== '' || tier !== 'all' || segment !== (p.variant === 'overview' ? 'open' : 'all')

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
              <option value="open">Open (not completed) · {counts.open}</option>
              <option value="all">All · {counts.all}</option>
              <option value="attention">Needs attention · {counts.attention}</option>
              <option value="in_review">In review · {counts.in_review}</option>
              <option value="unread">Not started · {counts.unread}</option>
              <option value="signed_out">Completed · {counts.signed_out}</option>
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
          <button type="button" className="link-btn small" onClick={() => { setQuery(''); setTier('all'); setSegment(p.variant === 'overview' ? 'open' : 'all') }}>
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
          defaultSort={{ key: 'routing', dir: 'desc' }}
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
