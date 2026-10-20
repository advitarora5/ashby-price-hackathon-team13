import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface Props { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; tone?: 'neutral' | 'warning' }

export default function EmptyState({ icon: Icon, title, children, action, tone = 'neutral' }: Props) {
  return (
    <div className={`empty-state tone-${tone}`} role={tone === 'warning' ? 'alert' : undefined}>
      {Icon && <Icon size={22} aria-hidden strokeWidth={1.75} />}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Skeleton({ width, height = 12, className }: { width?: number | string; height?: number; className?: string }) {
  return <span className={`skeleton ${className ?? ''}`} style={{ width, height }} aria-hidden />
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-rows" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="skeleton-row">
          {Array.from({ length: cols }, (_, c) => <Skeleton key={c} width={c === 0 ? '18%' : `${10 + ((r + c) % 3) * 4}%`} />)}
        </div>
      ))}
    </div>
  )
}
