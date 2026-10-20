import { LIGHT, REVIEW_STATUS, TIER, statusOf, type StatusDef } from '../../lib/status'

const MAPS = { review: REVIEW_STATUS, tier: TIER, light: LIGHT } as const

interface Props {
  kind?: keyof typeof MAPS
  value?: string | null
  def?: StatusDef
  /** Short form drops the text on very tight layouts but keeps it for screen readers and as a title. */
  compact?: boolean
}

export default function StatusBadge({ kind, value, def, compact }: Props) {
  const d = def ?? statusOf(kind ? MAPS[kind] : {}, value)
  const Icon = d.icon
  return (
    <span className={`badge tone-${d.tone}`} title={d.description || undefined}>
      <Icon size={13} aria-hidden strokeWidth={2.2} />
      {compact ? <span className="sr-only">{d.label}</span> : <span>{d.label}</span>}
    </span>
  )
}
