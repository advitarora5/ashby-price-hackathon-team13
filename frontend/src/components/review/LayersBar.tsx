import { ChevronLeft, ChevronRight, Eye, EyeOff, Home, Keyboard, Lock, Map as MapIcon, Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '../ui/Button'

export type LayerKey = 'risk' | 'disagreement' | 'regions' | 'artifact' | 'coverage'
export type Layers = Record<LayerKey, boolean>

const LAYER_META: Record<LayerKey, { label: string; key: string; ai: boolean; swatch: string }> = {
  risk: { label: 'Tumour score', key: 'R', ai: true, swatch: 'sw-risk' },
  disagreement: { label: 'Disagreement', key: 'D', ai: true, swatch: 'sw-dis' },
  regions: { label: 'Regions', key: 'G', ai: true, swatch: 'sw-reg' },
  artifact: { label: 'Artifacts', key: 'A', ai: false, swatch: 'sw-art' },
  coverage: { label: 'Unseen', key: 'C', ai: false, swatch: 'sw-cov' },
}
const ORDER: LayerKey[] = ['risk', 'regions', 'disagreement', 'coverage', 'artifact']

interface Props {
  layers: Layers
  onToggle: (k: LayerKey, on: boolean) => void
  allHidden: boolean
  onToggleAll: () => void
  evidenceVisible: boolean
  opacity: number
  onOpacity: (v: number) => void
  target: { index: number; total: number; label: string } | null
  onPrevTarget: () => void
  onNextTarget: () => void
}

interface ViewProps {
  zoomMag: number | null
  minMag: number
  onZoom: (f: number) => void
  onHome: () => void
  navigator: boolean
  onNavigator: () => void
  focusMode: boolean
  onFocusMode: () => void
  onShortcuts: () => void
}

/** Zoom indicator and view controls (top toolbar). */
export function ViewControls(p: ViewProps) {
  return (
      <div className="lb-group" role="group" aria-label="View">
        <span className={`zoom-chip num ${p.zoomMag !== null && p.zoomMag < p.minMag ? 'is-low' : ''}`}
          title={p.zoomMag !== null && p.zoomMag < p.minMag ? `Below ${p.minMag}×: tissue on screen is not counted as viewed` : `At ≥${p.minMag}× tissue on screen counts as viewed`}>
          {p.zoomMag === null ? '—' : `${p.zoomMag < 10 ? p.zoomMag.toFixed(1) : Math.round(p.zoomMag)}×`}
          {p.zoomMag !== null && p.zoomMag < p.minMag && <span className="sr-only"> (below {p.minMag}×: viewing is not counted)</span>}
        </span>
        <Button size="sm" variant="ghost" icon={ZoomOut} aria-label="Zoom out (−)" title="Zoom out (−)" onClick={() => p.onZoom(1 / 1.6)} />
        <Button size="sm" variant="ghost" icon={ZoomIn} aria-label="Zoom in (+)" title="Zoom in (+)" onClick={() => p.onZoom(1.6)} />
        <Button size="sm" variant="ghost" icon={Home} aria-label="Fit slide (0)" title="Fit slide (0)" onClick={p.onHome} />
        <Button size="sm" variant="ghost" icon={MapIcon} aria-label="Toggle overview map (N)" title="Toggle overview map (N)" aria-pressed={p.navigator} onClick={p.onNavigator} />
        <Button size="sm" variant="ghost" icon={p.focusMode ? Minimize2 : Maximize2} aria-pressed={p.focusMode}
          aria-label={p.focusMode ? 'Exit focus mode (F)' : 'Focus mode (F)'} title={p.focusMode ? 'Exit focus mode (F or Esc)' : 'Focus mode: hide panels (F)'} onClick={p.onFocusMode} />
        <Button size="sm" variant="ghost" icon={Keyboard} aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)" onClick={p.onShortcuts} />
      </div>
  )
}

/** Viewer controls live in a bar above the slide so they never cover tissue. */
export default function LayersBar(p: Props) {
  return (
    <div className="layers-bar" role="toolbar" aria-label="Viewer and overlay controls">
      <div className="lb-group" role="group" aria-label="Overlays">
        {ORDER.map((k) => {
          const m = LAYER_META[k]
          const locked = m.ai && !p.evidenceVisible
          const on = p.layers[k] && !locked && !p.allHidden
          return (
            <button type="button" key={k} className={`layer-toggle ${on ? 'is-on' : ''} ${locked ? 'is-locked' : ''}`}
              aria-pressed={p.layers[k] && !locked} disabled={locked} onClick={() => p.onToggle(k, !p.layers[k])}
              title={locked ? 'AI layer: hidden until you record your assessment' : `${m.label} overlay (${m.key})`}>
              {locked ? <Lock size={12} aria-hidden /> : <span className={`sw ${m.swatch}`} aria-hidden />}
              <span>{m.label}</span>
              {locked && <span className="sr-only"> (locked until your assessment)</span>}
            </button>
          )
        })}
        <Button size="sm" variant="ghost" icon={p.allHidden ? Eye : EyeOff} onClick={p.onToggleAll} aria-pressed={p.allHidden} title="Hide or show all overlays (H)">
          {p.allHidden ? 'Show overlays' : 'Hide all'}
        </Button>
        {(p.layers.risk || p.layers.disagreement) && p.evidenceVisible && !p.allHidden && <label className="opacity-ctl" title="Heatmap opacity">
          <span className="xs muted">Opacity</span>
          <input type="range" min={0.15} max={1} step={0.05} value={p.opacity} onChange={(e) => p.onOpacity(Number(e.target.value))}
            aria-label="Heatmap overlay opacity" aria-valuetext={`${Math.round(p.opacity * 100)}%`} />
        </label>}
      </div>

      {p.target && <div className="lb-group lb-targets" role="group" aria-label="Highlighted regions">
        <Button size="sm" variant="ghost" icon={ChevronLeft} aria-label="Previous highlighted region (K)" title="Previous highlighted region (K)"
          disabled={!p.target} onClick={p.onPrevTarget} />
        <span className="lb-target small num" aria-live="polite" title="Step through highlighted regions with J / K">
          {p.target ? <>{p.target.label} <span className="muted">{p.target.index + 1}/{p.target.total}</span></> : <span className="muted">No regions</span>}
        </span>
        <Button size="sm" variant="ghost" icon={ChevronRight} aria-label="Next highlighted region (J)" title="Next highlighted region (J)"
          disabled={!p.target} onClick={p.onNextTarget} />
      </div>}

    </div>
  )
}
