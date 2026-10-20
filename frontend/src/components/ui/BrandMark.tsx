import { useId } from 'react'
import { BRAND } from '../../brand'

/**
 * Claripath mark: a "C" drawn as a microscope aperture, open toward a single illuminated focus
 * point. Geometry is shared with public/favicon.svg and the boot screen in index.html; keep them in sync.
 */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  // gradient ids must be unique per instance and safe inside url(#...)
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}
      aria-label={title} className="brand-mark">
      <defs>
        <linearGradient id={`bm-tile-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4b7ba1" />
          <stop offset="1" stopColor="#2c4d6a" />
        </linearGradient>
        <radialGradient id={`bm-glow-${uid}`}>
          <stop offset="0" stopColor="#7fe0d6" stopOpacity=".6" />
          <stop offset="1" stopColor="#7fe0d6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#bm-tile-${uid})`} />
      <path d="M21.6 9.9A8.6 8.6 0 1 0 21.6 22.1" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="23.6" cy="16" r="5.4" fill={`url(#bm-glow-${uid})`} />
      <circle cx="23.6" cy="16" r="2.8" fill="#7fe0d6" />
    </svg>
  )
}

export function Wordmark({ collapsed }: { collapsed?: boolean }) {
  return (
    <span className="wordmark">
      <BrandMark size={28} />
      {!collapsed && (
        <span className="wordmark-text">
          <span className="wordmark-name">{BRAND.name}</span>
          <span className="wordmark-descriptor">{BRAND.descriptor}</span>
        </span>
      )}
    </span>
  )
}
