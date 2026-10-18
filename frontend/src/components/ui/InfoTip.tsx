import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

interface Props { label: string; children: ReactNode; icon?: ReactNode }

/**
 * Keyboard-reachable explanation. Opens on hover, focus or click; closes on Escape, blur or
 * outside click. Rendered in a portal with fixed positioning so table scrollers never clip it.
 */
export default function InfoTip({ label, children, icon }: Props) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const closeT = useRef<number | undefined>(undefined)
  const id = useId()
  // WCAG 1.4.13: hovering from the trigger onto the tooltip keeps it open
  const openNow = () => { window.clearTimeout(closeT.current); setOpen(true) }
  const closeSoon = () => { window.clearTimeout(closeT.current); if (!pinned) closeT.current = window.setTimeout(() => setOpen(false), 180) }

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const width = 280
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2))
    const below = r.bottom + 6
    setPos({ top: below + 160 > window.innerHeight ? Math.max(8, r.top - 6 - 160) : below, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPinned(false) } }
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (!btn.current?.contains(t) && !tip.current?.contains(t)) { setOpen(false); setPinned(false) }
    }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', down)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', down) }
  }, [open])

  return (
    <>
      <button ref={btn} type="button" className="infotip-btn" aria-label={label} aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setPinned(!pinned); setOpen(!pinned) }}
        onMouseEnter={openNow} onMouseLeave={closeSoon}
        onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setPinned(false) }}>
        {icon ?? <Info size={13} aria-hidden />}
      </button>
      {open && pos && createPortal(
        <div role="tooltip" id={id} ref={tip} className="infotip" style={{ top: pos.top, left: pos.left }}
          onMouseEnter={openNow} onMouseLeave={closeSoon}>{children}</div>,
        document.body,
      )}
    </>
  )
}
