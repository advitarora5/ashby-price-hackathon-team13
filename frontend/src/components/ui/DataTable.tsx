import { useMemo, useState, type ReactNode } from 'react'
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
  /** Hide below this viewport width (px) via CSS class. */
  hideBelow?: 1100 | 1280 | 1600
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
export default function DataTable<T>(p: Props<T>) {
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

  return (
    <div className="table-scroll">
      <table className={`data-table ${p.dense ? 'dense' : ''}`}>
        <caption className="sr-only">{p.caption}</caption>
        <thead>
          <tr>
            {p.columns.map((c) => {
              const active = sort?.key === c.key
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined
              const Icon = active ? (sort!.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
              return (
                <th key={c.key} scope="col" aria-sort={ariaSort} style={{ width: c.width }}
                  className={`align-${c.align ?? 'left'} ${c.hideBelow ? `hide-below-${c.hideBelow}` : ''}`}>
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
              {p.columns.map((c) => (
                <td key={c.key} className={`align-${c.align ?? 'left'} ${c.hideBelow ? `hide-below-${c.hideBelow}` : ''}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && p.empty}
    </div>
  )
}
