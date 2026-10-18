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
  const id = useId()

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
    const down = (e: PointerEvent) => { if (!btn.current?.contains(e.target as Node)) { setOpen(false); setPinned(false) } }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', down)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('pointerdown', down) }
  }, [open])

  return (
    <>
      <button ref={btn} type="button" className="infotip-btn" aria-label={label} aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setPinned(!pinned); setOpen(!pinned) }}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!pinned) setOpen(false) }}
        onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setPinned(false) }}>
        {icon ?? <Info size={13} aria-hidden />}
      </button>
      {open && pos && createPortal(
        <div role="tooltip" id={id} className="infotip" style={{ top: pos.top, left: pos.left }}>{children}</div>,
        document.body,
      )}
    </>
  )
}
