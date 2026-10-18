import { BRAND } from '../../brand'

/**
 * Claripath mark: an optical aperture. The outer ring is the microscope field of view, the
 * inner arc a focus ring, and the offset filled disc the one illuminated region worth a look.
 */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}
      aria-label={title} className="brand-mark">
      <circle cx="16" cy="16" r="14" fill="none" stroke="var(--c-primary)" strokeWidth="2.5" />
      <path d="M16 7.5a8.5 8.5 0 0 1 8.5 8.5" fill="none" stroke="var(--c-primary)" strokeWidth="2" strokeLinecap="round" opacity=".55" />
      <circle cx="19.2" cy="12.8" r="4.2" fill="var(--c-teal)" />
      <circle cx="12.5" cy="19.5" r="1.6" fill="var(--c-primary)" opacity=".45" />
    </svg>
  )
}

export function Wordmark({ collapsed }: { collapsed?: boolean }) {
  return (
    <span className="wordmark">
      <BrandMark size={26} />
      {!collapsed && (
        <span className="wordmark-text">
          <span className="wordmark-name">{BRAND.name}</span>
          <span className="wordmark-descriptor">{BRAND.descriptor}</span>
        </span>
      )}
    </span>
  )
}
