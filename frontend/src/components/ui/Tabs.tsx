import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface TabDef { id: string; label: ReactNode; count?: number; icon?: ReactNode }

interface Props {
  tabs: TabDef[]
  value: string
  onChange: (id: string) => void
  label: string
  /** id prefix used to link tabs and panels (aria-controls) */
  idPrefix: string
  variant?: 'underline' | 'segmented'
}

/** WAI-ARIA tabs with roving tabindex and arrow / Home / End keys. */
export default function Tabs({ tabs, value, onChange, label, idPrefix, variant = 'underline' }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value)
    let n = -1
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = tabs.length - 1
    if (n < 0) return
    e.preventDefault()
    onChange(tabs[n].id)
    refs.current[n]?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className={`tabs tabs-${variant}`} onKeyDown={onKey}>
      {tabs.map((t, i) => {
        const sel = t.id === value
        return (
          <button key={t.id} ref={(el) => { refs.current[i] = el }} role="tab" type="button"
            id={`${idPrefix}-tab-${t.id}`} aria-selected={sel} aria-controls={`${idPrefix}-panel`}
            tabIndex={sel ? 0 : -1} className={`tab ${sel ? 'is-selected' : ''}`} onClick={() => onChange(t.id)}>
            {t.icon}
            <span>{t.label}</span>
            {t.count !== undefined && <span className="tab-count num">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
