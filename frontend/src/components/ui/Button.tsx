import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

interface Common { variant?: Variant; size?: Size; icon?: LucideIcon; iconRight?: LucideIcon; children?: ReactNode }

const cls = (variant: Variant, size: Size, extra?: string, iconOnly?: boolean) =>
  ['btn', `btn-${variant}`, `btn-${size}`, iconOnly ? 'btn-icon' : '', extra ?? ''].filter(Boolean).join(' ')

export function Button({ variant = 'secondary', size = 'md', icon: Icon, iconRight: IconR, children, className, type = 'button', ...rest }:
  Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cls(variant, size, className, !children)} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden strokeWidth={2} />}
      {children}
      {IconR && <IconR size={size === 'sm' ? 14 : 16} aria-hidden strokeWidth={2} />}
    </button>
  )
}

/** Navigation that looks like a button (keeps real link semantics: middle-click, back/forward). */
export function ButtonLink({ variant = 'secondary', size = 'md', icon: Icon, iconRight: IconR, children, className, ...rest }:
  Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cls(variant, size, className, !children)} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden strokeWidth={2} />}
      {children}
      {IconR && <IconR size={size === 'sm' ? 14 : 16} aria-hidden strokeWidth={2} />}
    </a>
  )
}
