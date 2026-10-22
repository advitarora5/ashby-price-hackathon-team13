import type { ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, Eye, EyeOff, FlaskConical, Home, Keyboard, Layers as LayersIcon, Lock, Map as MapIcon, Maximize2,
  Minimize2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ZoomIn, ZoomOut,
} from 'lucide-react'
import { Button } from '../ui/Button'
import Popover from '../ui/Popover'

export type LayerKey = 'risk' | 'disagreement' | 'regions' | 'artifact' | 'coverage'
export type Layers = Record<LayerKey, boolean>

const META: Record<LayerKey, { label: string; short: string; key: string; ai: boolean; swatch: string }> = {
  risk: { label: 'Tumour probe score', short: 'Score', key: 'R', ai: true, swatch: 'sw-risk' },
  regions: { label: 'Flagged regions', short: 'Regions', key: 'G', ai: true, swatch: 'sw-reg' },
  disagreement: { label: 'Model disagreement', short: 'Disagree', key: 'D', ai: true, swatch: 'sw-dis' },
  coverage: { label: 'Not yet viewed (shaded)', short: 'Unseen', key: 'C', ai: false, swatch: 'sw-cov' },
  artifact: { label: 'Artifacts', short: 'Artifacts', key: 'A', ai: false, swatch: 'sw-art' },
}
const ORDER: LayerKey[] = ['risk', 'regions', 'disagreement', 'coverage', 'artifact']

interface Props {
  title: ReactNode
  navOpen: boolean
  onToggleNav: () => void
  sideOpen: boolean
  onToggleSide: () => void
  focusMode: boolean
  onFocusMode: () => void
  hasCase: boolean
  layers: Layers
  onToggleLayer: (k: LayerKey, on: boolean) => void
  allHidden: boolean
  onToggleAll: () => void
  evidenceVisible: boolean
  opacity: number
  onOpacity: (v: number) => void
  zoomMag: number | null
  minMag: number
  onZoom: (f: number) => void
  onHome: () => void
  navigator: boolean
  onNavigator: () => void
  onShortcuts: () => void
  /** optional slot after "Hide all" (tissue search box) */
  search?: ReactNode
  prevCase: { href: string; label: string } | null
  nextCase: { href: string; label: string } | null
}

function LayerChip({ k, p, compact }: { k: LayerKey; p: Props; compact?: boolean }) {
  const m = META[k]
  const locked = m.ai && !p.evidenceVisible
  const pressed = p.layers[k] && !locked
  return (
    <button type="button" className={`layer-toggle ${pressed ? 'is-on' : ''} ${locked ? 'is-locked' : ''} ${p.allHidden ? 'is-suppressed' : ''}`}
      aria-pressed={pressed} disabled={locked} onClick={() => p.onToggleLayer(k, !p.layers[k])}
      title={locked ? `${m.label}: hidden until you record your assessment` : `${m.label} (${m.key})${p.allHidden ? ' · all overlays hidden (H)' : ''}`}>
      {locked ? <Lock size={12} aria-hidden /> : <span className={`sw ${m.swatch}`} aria-hidden />}
      <span>{compact ? m.label : m.short}</span>
      {locked && <span className="sr-only"> (locked until your assessment)</span>}
    </button>
  )
}

/**
 * One non-wrapping toolbar row: case, overlays, view. Lower-priority controls move into the
 * Layers / More popovers as the viewer column narrows (container queries in review.css).
 */
export default function ReviewToolbar(p: Props) {
  const low = p.zoomMag !== null && p.zoomMag < p.minMag
  const anyOn = ORDER.filter((k) => p.layers[k] && (!META[k].ai || p.evidenceVisible)).length
  return (
    <div className="review-toolbar" role="toolbar" aria-label="Slide review controls">
      {!p.focusMode && (
        <Button variant="ghost" size="sm" icon={p.navOpen ? PanelLeftClose : PanelLeftOpen} onClick={p.onToggleNav}
          aria-expanded={p.navOpen} aria-label={p.navOpen ? 'Hide case list ([)' : 'Show case list ([)'} title={p.navOpen ? 'Hide case list ([)' : 'Show case list ([)'} />
      )}
      <div className="tb-title">{p.title}</div>

      {p.hasCase && (
        <>
          <div className="tb-layers-inline" role="group" aria-label="Overlays">
            {ORDER.map((k) => <LayerChip key={k} k={k} p={p} />)}
          </div>
          <Popover className="tb-layers-menu" label="Overlays" icon={LayersIcon} text={<span>Layers <span className="num muted">{p.allHidden ? 0 : anyOn}</span></span>} align="left">
            {() => (
              <div className="pop-stack">
                {ORDER.map((k) => <LayerChip key={k} k={k} p={p} compact />)}
                <label className="opacity-ctl">
                  <span className="xs muted">Heatmap opacity</span>
                  <input type="range" min={0.15} max={1} step={0.05} value={p.opacity} onChange={(e) => p.onOpacity(Number(e.target.value))}
                    aria-label="Heatmap overlay opacity" aria-valuetext={`${Math.round(p.opacity * 100)}%`} />
                </label>
              </div>
            )}
          </Popover>
          <Button size="sm" variant="ghost" icon={p.allHidden ? Eye : EyeOff} onClick={p.onToggleAll} aria-pressed={p.allHidden}
            title="Hide or show all overlays (H)" className="tb-hideall" aria-label={p.allHidden ? 'Show overlays (H)' : 'Hide all overlays (H)'}>
            <span className="tb-label">{p.allHidden ? 'Show' : 'Hide all'}</span>
          </Button>
          {p.search}
          <span className="toolbar-spacer" />
          <span className={`zoom-chip num ${low ? 'is-low' : ''}`} role="status"
            title={low ? `Below ${p.minMag}×: tissue on screen is not counted as viewed` : `At ≥${p.minMag}× tissue on screen counts as viewed`}>
            {p.zoomMag === null ? '—' : `${p.zoomMag < 10 ? p.zoomMag.toFixed(1) : Math.round(p.zoomMag)}×`}
            {low && <span className="sr-only"> (below {p.minMag}×: viewing is not counted)</span>}
          </span>
          <span className="tb-zoom">
            <Button size="sm" variant="ghost" icon={ZoomOut} aria-label="Zoom out (−)" title="Zoom out (−)" onClick={() => p.onZoom(1 / 1.6)} />
            <Button size="sm" variant="ghost" icon={ZoomIn} aria-label="Zoom in (+)" title="Zoom in (+)" onClick={() => p.onZoom(1.6)} />
            <Button size="sm" variant="ghost" icon={Home} aria-label="Fit slide (0)" title="Fit slide (0)" onClick={p.onHome} />
          </span>
          <Popover label="More view options" icon={MoreHorizontal}>
            {(close) => (
              <div className="pop-menu">
                <div className="pop-row tb-zoom-alt">
                  <Button size="sm" icon={ZoomOut} onClick={() => p.onZoom(1 / 1.6)}>Out</Button>
                  <Button size="sm" icon={ZoomIn} onClick={() => p.onZoom(1.6)}>In</Button>
                  <Button size="sm" icon={Home} onClick={p.onHome}>Fit</Button>
                </div>
                <Button size="sm" variant="ghost" icon={MapIcon} aria-pressed={p.navigator} onClick={p.onNavigator}>Overview map <kbd>N</kbd></Button>
                <Button size="sm" variant="ghost" icon={p.focusMode ? Minimize2 : Maximize2} aria-pressed={p.focusMode} onClick={() => { close(); p.onFocusMode() }}>
                  {p.focusMode ? 'Exit focus mode' : 'Focus mode'} <kbd>F</kbd>
                </Button>
                <Button size="sm" variant="ghost" icon={Keyboard} onClick={() => { close(); p.onShortcuts() }}>Keyboard shortcuts <kbd>?</kbd></Button>
                <label className="opacity-ctl pop-opacity">
                  <span className="xs muted">Heatmap opacity</span>
                  <input type="range" min={0.15} max={1} step={0.05} value={p.opacity} onChange={(e) => p.onOpacity(Number(e.target.value))}
                    aria-label="Heatmap overlay opacity" aria-valuetext={`${Math.round(p.opacity * 100)}%`} />
                </label>
                <div className="pop-row">
                  {p.prevCase ? <a className="btn btn-secondary btn-sm" href={p.prevCase.href} title={p.prevCase.label}><ArrowLeft size={14} aria-hidden />Previous case</a>
                    : <span className="btn btn-secondary btn-sm" aria-disabled="true"><ArrowLeft size={14} aria-hidden />Previous case</span>}
                  {p.nextCase ? <a className="btn btn-secondary btn-sm" href={p.nextCase.href} title={p.nextCase.label}>Next case<ArrowRight size={14} aria-hidden /></a>
                    : <span className="btn btn-secondary btn-sm" aria-disabled="true">Next case<ArrowRight size={14} aria-hidden /></span>}
                </div>
              </div>
            )}
          </Popover>
        </>
      )}
      {!p.hasCase && <span className="toolbar-spacer" />}
      <span className="ruo-chip xs" title="Research use only. Not for clinical diagnosis."><FlaskConical size={12} aria-hidden /> RUO</span>
      {!p.focusMode && (
        <Button variant="ghost" size="sm" icon={p.sideOpen ? PanelRightClose : PanelRightOpen} onClick={p.onToggleSide}
          aria-expanded={p.sideOpen} aria-label={p.sideOpen ? 'Hide AI panel (])' : 'Show AI panel (])'} title={p.sideOpen ? 'Hide AI panel (])' : 'Show AI panel (])'} />
      )}
    </div>
  )
}
