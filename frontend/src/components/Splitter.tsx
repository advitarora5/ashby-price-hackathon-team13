import { useCallback, useRef, useState } from 'react'
import type { Limits, PanelState } from '../usePanel'

interface Props {
  /** which edge of the workspace the panel is docked to */
  dock: 'left' | 'right' | 'bottom'
  panel: PanelState
  setPanel: (p: PanelState) => void
  limits: Limits
  label: string
}

const ARROWS = {
  left: ['‹', '›'],
  right: ['›', '‹'],
  bottom: ['▾', '▴'],
} as const

/**
 * Drag handle between a docked panel and the slide viewer. Dragging resizes; dragging the
 * panel below half its minimum collapses it; the button toggles it; double-click resets.
 */
export default function Splitter({ dock, panel, setPanel, limits, label }: Props) {
  const drag = useRef<{ start: number; size: number } | null>(null)
  const [active, setActive] = useState(false)
  const vertical = dock !== 'bottom'
  const sign = dock === 'left' ? 1 : -1

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { start: vertical ? e.clientX : e.clientY, size: panel.open ? panel.size : 0 }
    setActive(true)
  }
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const want = d.size + sign * ((vertical ? e.clientX : e.clientY) - d.start)
    if (want < limits.min / 2) setPanel({ size: panel.size, open: false })
    else setPanel({ size: Math.min(limits.max, Math.max(limits.min, want)), open: true })
  }, [limits, panel.size, setPanel, sign, vertical])
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null
    setActive(false)
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  const [close, open] = ARROWS[dock]
  return (
    <div className={`splitter ${vertical ? 'split-v' : 'split-h'} dock-${dock} ${panel.open ? '' : 'collapsed'} ${active ? 'active' : ''}`}
      role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-label={`Resize ${label}`}
      title={`Drag to resize the ${label} · double-click to reset`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => setPanel({ size: limits.initial, open: true })}>
      <button className="split-toggle" aria-expanded={panel.open}
        title={panel.open ? `Hide the ${label}` : `Show the ${label}`}
        onClick={() => setPanel({ ...panel, open: !panel.open })}>{panel.open ? close : open}</button>
    </div>
  )
}
