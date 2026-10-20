import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface Props {
  label: string
  /** visible button text (optional: icon-only buttons use `label` as their accessible name) */
  text?: ReactNode
  icon?: LucideIcon
  align?: 'left' | 'right'
  className?: string
  children: (close: () => void) => ReactNode
}

/**
 * Small disclosure popover (button + panel) for overflow controls. Esc or an outside click closes it
 * and returns focus to the button. Content is ordinary focusable controls, so Tab works inside it.
 */
export default function Popover({ label, text, icon: Icon, align = 'right', className, children }: Props) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => { setOpen(false); btn.current?.focus() }
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', down)
    const first = panel.current?.querySelector<HTMLElement>('button, input, select, a[href]')
    first?.focus()
    return () => window.removeEventListener('pointerdown', down)
  }, [open])
  return (
    <span className={`popover-wrap ${className ?? ''}`}>
      <button ref={btn} type="button" className={`btn btn-ghost btn-sm ${text ? '' : 'btn-icon'}`} aria-expanded={open} aria-controls={id}
        aria-label={text ? undefined : label} title={label} onClick={() => setOpen((o) => !o)}>
        {Icon && <Icon size={14} aria-hidden />}{text}
      </button>
      {open && (
        <div ref={panel} id={id} role="group" aria-label={label} className={`popover align-${align}`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
          {children(close)}
        </div>
      )}
    </span>
  )
}
