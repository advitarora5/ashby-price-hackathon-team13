import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import InfoTip from './InfoTip'

interface Props {
  label: string
  value: ReactNode
  /** Short context under the number: denominators, definitions. */
  hint?: ReactNode
  info?: ReactNode
  icon?: LucideIcon
  tone?: 'neutral' | 'info' | 'warning' | 'success' | 'accent'
  unavailable?: boolean
  loading?: boolean
}

export default function StatTile({ label, value, hint, info, icon: Icon, tone = 'neutral', unavailable, loading }: Props) {
  return (
    <div className={`stat tone-${tone} ${unavailable ? 'is-unavailable' : ''}`}>
      <div className="stat-label">
        {Icon && <Icon size={14} aria-hidden />}
        <span>{label}</span>
        {info && <InfoTip label={`About ${label}`}>{info}</InfoTip>}
      </div>
      <div className="stat-value num">{loading ? <span className="skeleton skeleton-text" style={{ width: 40 }} /> : value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}
