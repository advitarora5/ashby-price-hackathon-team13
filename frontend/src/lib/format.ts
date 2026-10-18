export const pct = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(digits)}%`

/** Relative 0–1 scores (ranks, entropy) shown as plain decimals so they never read as probabilities. */
export const score = (v: number | null | undefined) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v > 0.99) return '>0.99' // never round an uncalibrated score up to certainty
  if (v < 0.01) return '<0.01'
  return v.toFixed(2)
}

/** Artifact share: one decimal so values either side of the 5% flag never look identical. */
export const pct1 = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export const tissueLabel = (organ: string) => {
  const t = organ.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const rtfLong = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null
const rtfShort = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' }) : null

export function relativeTime(iso: string | null | undefined, short = false, now = Date.now()): string {
  const rtf = short ? rtfShort : rtfLong
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.round((t - now) / 1000)
  const a = Math.abs(s)
  if (!rtf) return new Date(t).toLocaleString()
  if (a < 45) return 'just now'
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour')
  if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day')
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export const absoluteTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''

/** Share as a percentage that never rounds a non-zero value to 0% or a non-full value to 100%. */
export function share(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v <= 0) return '0%'
  if (v >= 1) return '100%'
  if (v < 0.01) return '<1%'
  if (v > 0.99) return '>99%'
  return `${Math.round(v * 100)}%`
}
