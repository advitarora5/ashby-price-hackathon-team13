import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import Sidebar from './components/shell/Sidebar'
import { useRoute, type Page } from './lib/router'
import { needsAttention } from './lib/status'
import { deriveActivity, type CaseActivity } from './lib/activity'
import { BRAND } from './brand'
import OverviewPage from './pages/OverviewPage'
import CasesPage from './pages/CasesPage'
import ResearchPage from './pages/ResearchPage'
import SettingsPage from './pages/SettingsPage'
import type { CaseRow, EvalDoc, Health, PolicySummary } from './types'
import EmptyState from './components/ui/EmptyState'

// the viewer (OpenSeadragon) is the heaviest chunk; load it on first visit to Slide Review
const SlideReviewPage = lazy(() => import('./pages/SlideReviewPage'))

const PAGE_TITLES: Record<Page, string> = {
  overview: 'Overview', cases: 'Cases', review: 'Slide Review', research: 'Research Insights', settings: 'Settings',
}

/** Per-viewer conveniences only; the app works without storage. */
const store = {
  get(k: string): string | null { try { return window.localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v) } catch { /* storage unavailable */ } },
}

export default function App() {
  const [route, navigate] = useRoute()
  const [cases, setCases] = useState<CaseRow[]>([])
  const [casesLoaded, setCasesLoaded] = useState(false)
  const [casesErr, setCasesErr] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [summary, setSummary] = useState<PolicySummary | null>(null)
  const [evalDocs, setEvalDocs] = useState<Record<string, EvalDoc> | null>(null)
  const [evalErr, setEvalErr] = useState<string | null>(null)
  const [activity, setActivity] = useState<Record<string, CaseActivity>>({})
  const [blindAll, setBlindAll] = useState(() => store.get('claripath.blindAll') === '1')
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const v = store.get('claripath.navCollapsed')
    return v === null ? window.innerWidth < 1100 : v === '1'
  })
  const [reviewCaseId, setReviewCaseId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([route.page]))

  const refreshCases = useCallback(() => {
    api.cases()
      .then((c) => { setCases(c); setCasesErr(null) })
      .catch((e) => setCasesErr(`Backend unreachable: ${e.message}`))
      .finally(() => setCasesLoaded(true))
    // last activity per case, derived read-only from the existing audit log
    api.auditEvents().then((events) => setActivity(deriveActivity(events))).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshCases()
    api.health().then(setHealth).catch(() => undefined)
    api.policySummary().then(setSummary).catch(() => undefined)
    api.evalSummary().then(setEvalDocs).catch((e) => setEvalErr(e.message))
  }, [refreshCases])

  // keep the review workspace mounted and remember which case it shows
  useEffect(() => {
    setVisited((v) => (v.has(route.page) ? v : new Set(v).add(route.page)))
    if (route.page === 'review' && route.caseId) setReviewCaseId(route.caseId)
  }, [route])

  useEffect(() => {
    document.title = `${PAGE_TITLES[route.page]}${route.page === 'review' && reviewCaseId ? ` · ${reviewCaseId.replace('case_', '')}` : ''} · ${BRAND.name}`
  }, [route.page, reviewCaseId])

  const setBlind = (v: boolean) => { setBlindAll(v); store.set('claripath.blindAll', v ? '1' : '0') }
  const toggleNav = () => setNavCollapsed((c) => { store.set('claripath.navCollapsed', c ? '0' : '1'); return !c })
  const openCase = useCallback((id: string) => navigate({ page: 'review', caseId: id }), [navigate])

  const loading = !casesLoaded
  const reviewSlide = useMemo(() => cases.find((c) => c.case_id === reviewCaseId)?.slide_id ?? reviewCaseId?.replace('case_', '') ?? null, [cases, reviewCaseId])
  const attention = casesLoaded && !casesErr ? cases.filter(needsAttention).length : null
  const show = (p: Page) => route.page === p

  return (
    <div className={`app-shell ${navCollapsed ? 'nav-collapsed' : ''} ${focusMode && route.page === 'review' ? 'is-focus' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <Sidebar route={route} collapsed={navCollapsed} onToggle={toggleNav} reviewCaseId={reviewCaseId} reviewSlideId={reviewSlide}
        counts={{ needsAttention: attention }} provenance={health?.provenance ?? null} blindAll={blindAll} />
      <main id="main" className="app-main" tabIndex={-1}>
        {visited.has('overview') && (
          <div className="page-host" hidden={!show('overview')}>
            <OverviewPage cases={cases} loading={loading} error={casesErr} health={health} activity={activity}
              evalDocs={evalDocs} evalErr={evalErr} currentCaseId={reviewCaseId} blindAll={blindAll} onOpen={openCase} />
          </div>
        )}
        {visited.has('cases') && (
          <div className="page-host" hidden={!show('cases')}>
            <CasesPage cases={cases} loading={loading} error={casesErr} health={health} activity={activity}
              currentCaseId={reviewCaseId} onOpen={openCase} />
          </div>
        )}
        {visited.has('review') && (
          <div className="page-host" hidden={!show('review')}>
            <Suspense fallback={<div className="review-empty"><EmptyState title="Loading slide viewer…" /></div>}>
              <SlideReviewPage caseId={reviewCaseId} visible={show('review')} cases={cases} casesErr={casesErr} blindAll={blindAll}
                evalDocs={evalDocs} onCasesChanged={refreshCases} onSelectCase={openCase} focusMode={focusMode} onFocusMode={setFocusMode} />
            </Suspense>
          </div>
        )}
        {visited.has('research') && (
          <div className="page-host" hidden={!show('research')}>
            <ResearchPage docs={evalDocs} error={evalErr} summary={summary} health={health} />
          </div>
        )}
        {visited.has('settings') && (
          <div className="page-host" hidden={!show('settings')}>
            <SettingsPage blindAll={blindAll} onBlindAll={setBlind} health={health} />
          </div>
        )}
      </main>
    </div>
  )
}
