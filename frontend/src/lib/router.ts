import { useCallback, useEffect, useState } from 'react'

/** Tiny hash router: #/overview, #/cases, #/review/<case_id>, #/research, #/settings. */
export type Page = 'overview' | 'cases' | 'review' | 'research' | 'settings'
export interface Route { page: Page; caseId?: string }

const PAGES: Page[] = ['overview', 'cases', 'review', 'research', 'settings']

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const page = (PAGES as string[]).includes(parts[0]) ? (parts[0] as Page) : 'overview'
  return page === 'review' && parts[1] ? { page, caseId: parts[1] } : { page }
}

export function href(r: Route): string {
  return r.page === 'review' && r.caseId ? `#/review/${encodeURIComponent(r.caseId)}` : `#/${r.page}`
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const navigate = useCallback((r: Route) => {
    const h = href(r)
    if (window.location.hash !== h) window.location.hash = h
  }, [])
  return [route, navigate]
}
