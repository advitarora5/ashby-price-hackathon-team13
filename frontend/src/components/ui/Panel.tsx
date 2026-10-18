import type { ReactNode } from 'react'

interface Props {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** heading level for document outline */
  level?: 2 | 3
  id?: string
  flush?: boolean
}

export default function Panel({ title, subtitle, actions, children, className, level = 2, id, flush }: Props) {
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <section className={`panel ${flush ? 'panel-flush' : ''} ${className ?? ''}`} aria-labelledby={id}>
      <SectionHeader title={<H id={id} className="panel-title">{title}</H>} subtitle={subtitle} actions={actions} />
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function SectionHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-header">
      <div className="section-titles">
        {title}
        {subtitle && <p className="section-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  )
}
