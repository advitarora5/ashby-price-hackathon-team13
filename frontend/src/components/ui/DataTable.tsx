import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import InfoTip from './InfoTip'

export type SortDir = 'asc' | 'desc'
export interface SortState { key: string; dir: SortDir }

export interface Column<T> {
  key: string
  header: string
  cell: (row: T) => ReactNode
  /** Present = sortable. null values always sort last. */
  sortValue?: (row: T) => string | number | null
  /** Direction used on first click (numbers usually start high-to-low). */
  firstDir?: SortDir
  align?: 'left' | 'right' | 'center'
  width?: string
  info?: ReactNode
  /** Approximate width the column needs (px, incl. padding). Used to decide which columns fit. */
  minWidth?: number
  /** Lower = more important. 0 = always shown. Columns are dropped from the highest number first. */
  priority?: number
  /** Keep this column pinned to the right edge (row actions). */
  sticky?: boolean
}

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  caption: string
  sort?: SortState | null
  onSortChange?: (s: SortState | null) => void
  defaultSort?: SortState | null
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string | undefined
  isSelected?: (row: T) => boolean
  empty?: ReactNode
  maxRows?: number
  dense?: boolean
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * Sortable, keyboard-accessible table. Sorting is done with real <button>s in the headers
 * (aria-sort on the <th>). Row click is a mouse convenience; every row must also contain a
 * focusable action (e.g. an Open link) so keyboard users are never stuck.
 */
/** Which columns fit in `width`, keeping the most important ones (container-aware, not viewport-based). */
function fitColumns<T>(cols: Column<T>[], width: number): Set<string> {
  if (!width) return new Set(cols.map((c) => c.key))
  const order = [...cols].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const keep = new Set<string>()
  let used = 0
  for (const c of order) {
    const w = c.minWidth ?? 100
    if ((c.priority ?? 0) === 0 || used + w <= width) { keep.add(c.key); used += w }
  }
  return keep
}

export default function DataTable<T>(p: Props<T>) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // first pass: estimated widths; second pass: if the rendered table still overflows, drop the
  // next least important column until it fits (fonts, badges and locales vary)
  const table = useRef<HTMLTableElement>(null)
  const [extraDrop, setExtraDrop] = useState(0)
  const estimated = useMemo(() => fitColumns(p.columns, width), [p.columns, width])
  const droppable = useMemo(() => p.columns.filter((c) => estimated.has(c.key) && (c.priority ?? 0) > 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).map((c) => c.key), [p.columns, estimated])
  const visible = useMemo(() => {
    const v = new Set(estimated)
    droppable.slice(0, extraDrop).forEach((k) => v.delete(k))
    return v
  }, [estimated, droppable, extraDrop])
  useLayoutEffect(() => { setExtraDrop(0) }, [width, p.columns])
  useLayoutEffect(() => {
    const t = table.current, w = wrap.current
    if (t && w && t.scrollWidth > w.clientWidth + 1 && extraDrop < droppable.length) setExtraDrop((d) => d + 1)
  }, [extraDrop, droppable.length, visible, p.rows, width])
  const cols = p.columns.filter((c) => visible.has(c.key))
  const [inner, setInner] = useState<SortState | null>(p.defaultSort ?? null)
  const sort = p.sort !== undefined ? p.sort : inner
  const setSort = (s: SortState | null) => { if (p.onSortChange) p.onSortChange(s); else setInner(s) }

  const sorted = useMemo(() => {
    if (!sort) return p.rows
    const col = p.columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return p.rows
    const sv = col.sortValue
    const withIdx = p.rows.map((r, i) => ({ r, i, v: sv(r) }))
    withIdx.sort((x, y) => {
      if (x.v === null || y.v === null) return compare(x.v, y.v) || x.i - y.i
      const c = compare(x.v, y.v)
      return (sort.dir === 'asc' ? c : -c) || x.i - y.i
    })
    return withIdx.map((x) => x.r)
  }, [p.rows, p.columns, sort])

  const shown = p.maxRows ? sorted.slice(0, p.maxRows) : sorted

  const clickHeader = (c: Column<T>) => {
    const first = c.firstDir ?? 'asc'
    if (!sort || sort.key !== c.key) setSort({ key: c.key, dir: first })
    else if (sort.dir === first) setSort({ key: c.key, dir: first === 'asc' ? 'desc' : 'asc' })
    else setSort(p.defaultSort ?? null)
  }

  const hiddenSort = sort && !visible.has(sort.key) ? p.columns.find((c) => c.key === sort.key) : null

  return (
    <div className="table-scroll" ref={wrap}>
      {hiddenSort && (
        <div className="table-sortnote small muted">
          Sorted by {hiddenSort.header} ({sort!.dir === 'asc' ? 'ascending' : 'descending'}); column hidden at this width.{' '}
          <button type="button" className="link-btn" onClick={() => setSort(p.defaultSort ?? null)}>Reset sort</button>
        </div>
      )}
      <table ref={table} className={`data-table ${p.dense ? 'dense' : ''}`}>
        <caption className="sr-only">{p.caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => {
              const active = sort?.key === c.key
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined
              const Icon = active ? (sort!.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
              return (
                <th key={c.key} scope="col" aria-sort={ariaSort} style={{ width: c.width }}
                  className={`align-${c.align ?? 'left'} ${c.sticky ? 'is-sticky' : ''}`}>
                  <span className="th-inner">
                    {c.sortValue ? (
                      <button type="button" className={`th-sort ${active ? 'is-active' : ''}`} onClick={() => clickHeader(c)}>
                        {c.header}<Icon size={12} aria-hidden className="th-sort-icon" />
                      </button>
                    ) : <span>{c.header}</span>}
                    {c.info && <InfoTip label={`About ${c.header}`}>{c.info}</InfoTip>}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={p.rowKey(r)}
              className={[p.onRowClick ? 'is-clickable' : '', p.isSelected?.(r) ? 'is-selected' : '', p.rowClassName?.(r) ?? ''].join(' ')}
              aria-selected={p.isSelected ? p.isSelected(r) : undefined}
              onClick={p.onRowClick ? (e) => {
                if ((e.target as HTMLElement).closest('a,button,input,select,label')) return
                p.onRowClick!(r)
              } : undefined}>
              {cols.map((c) => (
                <td key={c.key} className={`align-${c.align ?? 'left'} ${c.sticky ? 'is-sticky' : ''}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && p.empty}
    </div>
  )
}
