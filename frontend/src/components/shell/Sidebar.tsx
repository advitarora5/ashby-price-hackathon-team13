import { FlaskConical, LayoutDashboard, ListChecks, Microscope, PanelLeftClose, PanelLeftOpen, Settings, EyeOff, type LucideIcon } from 'lucide-react'
import { BRAND } from '../../brand'
import { href, type Page, type Route } from '../../lib/router'
import { Wordmark } from '../ui/BrandMark'
import InfoTip from '../ui/InfoTip'

interface Props {
  route: Route
  collapsed: boolean
  onToggle: () => void
  reviewCaseId: string | null
  reviewSlideId: string | null
  counts: { needsAttention: number | null }
  provenance: string | null
  blindAll: boolean
}

interface Item { page: Page; label: string; icon: LucideIcon }
const ITEMS: Item[] = [
  { page: 'overview', label: 'Overview', icon: LayoutDashboard },
  { page: 'cases', label: 'Cases', icon: ListChecks },
  { page: 'review', label: 'Slide Review', icon: Microscope },
  { page: 'research', label: 'Research Insights', icon: FlaskConical },
]

export default function Sidebar({ route, collapsed, onToggle, reviewCaseId, reviewSlideId, counts, provenance, blindAll }: Props) {
  const link = (it: Item) => {
    const active = route.page === it.page
    const to = it.page === 'review' && reviewCaseId ? href({ page: 'review', caseId: reviewCaseId }) : href({ page: it.page })
    const Icon = it.icon
    const sub = it.page === 'review' && reviewSlideId ? reviewSlideId : null
    return (
      <li key={it.page}>
        <a href={to} className={`nav-link ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}
          title={collapsed ? it.label + (sub ? ` (${sub})` : '') : undefined}>
          <Icon size={18} aria-hidden strokeWidth={1.9} />
          {!collapsed && (
            <span className="nav-text">
              <span>{it.label}</span>
              {sub && <span className="nav-sub mono">{sub}</span>}
            </span>
          )}
          {collapsed && <span className="sr-only">{it.label}</span>}
          {!collapsed && it.page === 'cases' && counts.needsAttention !== null && counts.needsAttention > 0 && (
            <span className="nav-count num" title="Slow path · open cases">{counts.needsAttention}<span className="sr-only"> slow-path cases open</span></span>
          )}
        </a>
      </li>
    )
  }

  return (
    <nav className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-head">
        <a href={href({ page: 'overview' })} className="sidebar-brand" aria-label={`${BRAND.name} overview`}>
          <Wordmark collapsed={collapsed} />
        </a>
      </div>
      <ul className="nav-list">{ITEMS.map(link)}</ul>
      <div className="sidebar-spacer" />
      <ul className="nav-list nav-list-secondary">{link({ page: 'settings', label: 'Settings', icon: Settings })}</ul>
      <div className="sidebar-foot">
        {blindAll && (
          <a href={href({ page: 'settings' })} className="mode-chip" title="Blind-first is on for all cases (Settings)">
            <EyeOff size={14} aria-hidden />{!collapsed ? <span>Blind-first: all cases</span> : <span className="sr-only">Blind-first on for all cases</span>}
          </a>
        )}
        <div className="ruo" role="note">
          <FlaskConical size={14} aria-hidden />
          {!collapsed ? <span>{BRAND.researchNotice}</span> : <span className="ruo-short" aria-label={BRAND.researchNoticeLong}>RUO</span>}
          <InfoTip label="About research use">
            <strong>{BRAND.researchNoticeLong}</strong>
            {provenance && <><br />Data: {provenance}.</>}
          </InfoTip>
        </div>
        <button type="button" className="collapse-btn" onClick={onToggle} aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </nav>
  )
}
