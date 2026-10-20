import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '../ui/Button'

const SHORTCUTS: [string, string][] = [
  ['J / K', 'Next / previous highlighted region'],
  ['R', 'Tumour score overlay'],
  ['G', 'Flagged regions'],
  ['D', 'Disagreement overlay'],
  ['C', 'Seen / unseen map'],
  ['A', 'Artifacts overlay'],
  ['H', 'Hide / show all overlays'],
  ['+ / −', 'Zoom in / out'],
  ['0', 'Fit slide'],
  ['N', 'Overview map'],
  ['F', 'Focus mode (Esc to exit)'],
  ['[ / ]', 'Case list / AI panel'],
  ['1 – 4', 'Evidence, Unseen areas, Model comparison, Review decision tabs'],
  ['?', 'This help'],
]

/** Non-modal help card. Shortcuts never fire while typing in a field. */
export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div className="shortcut-help" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1} ref={ref}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="sh-head">
        <strong>Keyboard shortcuts</strong>
        <Button size="sm" variant="ghost" icon={X} aria-label="Close shortcuts" onClick={onClose} />
      </div>
      <dl>
        {SHORTCUTS.map(([k, d]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}
      </dl>
      <p className="xs muted">Shortcuts are off while a text field or menu has focus.</p>
    </div>
  )
}
