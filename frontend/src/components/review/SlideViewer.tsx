import { useEffect, useRef } from 'react'
import OpenSeadragon from 'openseadragon'
import type { CaseDetail, Rect, Region } from '../../types'

/**
 * Coordinates: everything the backend sends is in level-0 slide pixels. OpenSeadragon
 * viewport coordinates are level-0 / slide width (x and y both divided by width), which
 * holds for the Deep Zoom source and for the thumbnail fallback, so overlays stay aligned
 * at every zoom level.
 */
export interface LayerSpec { key: string; url: string; opacity: number }

export interface ViewportReport { x: number; y: number; w: number; h: number; zoom: number }

export type ViewerStatus = { state: 'loading' } | { state: 'ready'; tileErrors: number } | { state: 'error'; message: string }

/** Imperative controls for toolbar buttons and keyboard shortcuts. */
export interface ViewerControls {
  zoomBy: (f: number) => void
  home: () => void
  setNavigator: (on: boolean) => void
}

interface Props {
  detail: CaseDetail
  layers: LayerSpec[]
  boxes: { region: Region; tone: 'evidence' | 'disputed' | 'unseen' | 'selected'; label: string }[]
  focus: { rect: Rect; key: number } | null
  follow: (Rect & { key: number }) | null
  fixation: { x: number; y: number } | null
  onViewport?: (v: ViewportReport) => void
  onClickPoint?: (x: number, y: number) => void
  onBoxClick?: (r: Region) => void
  onStatus?: (s: ViewerStatus) => void
  /** Jumps land at no less than this objective-equivalent magnification (the coverage counting threshold). */
  minMag?: number
  controls?: { current: ViewerControls | null }
}

export default function SlideViewer(p: Props) {
  const el = useRef<HTMLDivElement>(null)
  const viewer = useRef<OpenSeadragon.Viewer | null>(null)
  const layerItems = useRef<Map<string, { url: string; item: OpenSeadragon.TiledImage }>>(new Map())
  const cb = useRef(p)
  cb.current = p
  const W = p.detail.width

  // viewer lifecycle (one per case)
  useEffect(() => {
    if (!el.current) return
    const tileSources: OpenSeadragon.TileSourceOptions | string = p.detail.dzi_url
      ? p.detail.dzi_url
      : ({ type: 'image', url: p.detail.thumbnail_url } as unknown as OpenSeadragon.TileSourceOptions)
    const v = OpenSeadragon({
      element: el.current,
      tileSources,
      showNavigationControl: false,
      showNavigator: true,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorSizeRatio: 0.12,
      navigatorAutoFade: false,
      imageSmoothingEnabled: false,
      maxZoomPixelRatio: 2,
      visibilityRatio: 0.6,
      animationTime: 0.6,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
      crossOriginPolicy: 'Anonymous',
    })
    viewer.current = v
    layerItems.current = new Map()
    let tileErrors = 0
    cb.current.onStatus?.({ state: 'loading' })
    v.addHandler('open', () => cb.current.onStatus?.({ state: 'ready', tileErrors }))
    v.addHandler('open-failed', (e) => cb.current.onStatus?.({ state: 'error', message: String((e as unknown as { message?: string }).message ?? 'The slide image could not be opened.') }))
    v.addHandler('tile-load-failed', () => { tileErrors += 1; if (tileErrors === 1 || tileErrors % 10 === 0) cb.current.onStatus?.({ state: 'ready', tileErrors }) })
    if (cb.current.controls) {
      cb.current.controls.current = {
        zoomBy: (f) => { v.viewport.zoomBy(f); v.viewport.applyConstraints() },
        home: () => v.viewport.goHome(),
        setNavigator: (on) => { const el = (v.navigator as unknown as { element?: HTMLElement })?.element; if (el) el.style.display = on ? '' : 'none' },
      }
    }
    let last = 0
    let timer: number | undefined
    const report = () => {
      const b = v.viewport.getBounds(true)
      const cw = v.container.clientWidth
      if (!cw || b.width <= 0) return
      cb.current.onViewport?.({ x: b.x * W, y: b.y * W, w: b.width * W, h: b.height * W, zoom: cw / (b.width * W) })
    }
    const throttled = () => {
      const now = performance.now()
      window.clearTimeout(timer)
      if (now - last > 250) { last = now; report() } else { timer = window.setTimeout(report, 260) }
    }
    v.addHandler('viewport-change', throttled)
    v.addHandler('open', report)
    // our shortcuts own R/F; stop OpenSeadragon rotating or flipping the slide on those keys
    v.addHandler('canvas-key', (e) => {
      const k = (e as unknown as { originalEvent: KeyboardEvent }).originalEvent?.key
      if (k && /^[rRfF]$/.test(k)) (e as unknown as { preventDefaultAction: boolean }).preventDefaultAction = true
    })
    v.addHandler('canvas-click', (e) => {
      if (!e.quick) return
      const pt = v.viewport.pointFromPixel(e.position)
      cb.current.onClickPoint?.(pt.x * W, pt.y * W)
    })
    return () => { window.clearTimeout(timer); v.destroy(); viewer.current = null; if (cb.current.controls) cb.current.controls.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.detail.case_id])

  // overlay layers (grid PNGs, one pixel per tile)
  useEffect(() => {
    const v = viewer.current
    if (!v) return
    const gridW = (p.detail.grid_cols * p.detail.tile_w0) / W
    const wanted = new Map(p.layers.map((l) => [l.key, l]))
    for (const [key, cur] of layerItems.current) {
      const want = wanted.get(key)
      if (!want) { v.world.removeItem(cur.item); layerItems.current.delete(key) }
      else if (want.url === cur.url) cur.item.setOpacity(want.opacity)
    }
    const apply = () => {
      for (const l of p.layers) {
        const cur = layerItems.current.get(l.key)
        if (cur && cur.url === l.url) continue
        v.addTiledImage({
          tileSource: { type: 'image', url: l.url } as unknown as OpenSeadragon.TileSourceOptions,
          x: 0, y: 0, width: gridW, opacity: l.opacity,
          success: (ev) => {
            const item = (ev as unknown as { item: OpenSeadragon.TiledImage }).item
            const prev = layerItems.current.get(l.key)
            layerItems.current.set(l.key, { url: l.url, item })
            if (prev) v.world.removeItem(prev.item) // swap after load: no flicker
          },
        })
      }
    }
    if (v.world.getItemCount() > 0) apply()
    else v.addOnceHandler('open', apply)
  }, [p.layers, p.detail, W])

  // region boxes
  useEffect(() => {
    const v = viewer.current
    if (!v) return
    const draw = () => {
      v.clearOverlays()
      for (const b of p.boxes) {
        const d = document.createElement('div')
        d.className = `region-box tone-${b.tone}`
        d.title = b.label
        if (b.tone !== 'selected') {
          d.setAttribute('role', 'button'); d.tabIndex = 0; d.setAttribute('aria-label', b.label || `${b.region.kind} region ${b.region.rank}`)
          d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cb.current.onBoxClick?.(b.region) } })
        }
        const tag = document.createElement('span')
        tag.textContent = b.label
        d.appendChild(tag)
        d.addEventListener('pointerdown', (e) => e.stopPropagation())
        d.addEventListener('click', (e) => { e.stopPropagation(); cb.current.onBoxClick?.(b.region) })
        const r = b.region
        v.addOverlay({ element: d, location: new OpenSeadragon.Rect(r.x / W, r.y / W, r.w / W, r.h / W) })
      }
      if (p.fixation) {
        const d = document.createElement('div')
        d.className = 'fixation-dot'
        v.addOverlay({ element: d, location: new OpenSeadragon.Point(p.fixation.x / W, p.fixation.y / W),
          placement: OpenSeadragon.Placement.CENTER })
      }
    }
    if (v.world.getItemCount() > 0) draw()
    else v.addOnceHandler('open', draw)
  }, [p.boxes, p.fixation, W])

  // navigate to a rectangle (jump links, alerts), landing at >= minMag so the visit counts as viewed
  useEffect(() => {
    const v = viewer.current
    if (!v || !p.focus) return
    const { x, y, w, h } = p.focus.rect
    const go = () => {
      const pad = Math.max(w, h) * 0.6
      let bw = w + 2 * pad
      let bh = h + 2 * pad
      const cw = v.container.clientWidth || 800
      const ch = v.container.clientHeight || 600
      const mag = cb.current.minMag
      if (mag) {
        // screen px per level-0 px needed for `mag`: zoom = mag * mpp / 10 (backend convention)
        const need = (mag * 1.15 * p.detail.mpp) / 10
        bw = Math.min(bw, cw / need)
        bh = Math.min(bh, ch / need)
      }
      const cx = x + w / 2, cy = y + h / 2
      v.viewport.fitBounds(new OpenSeadragon.Rect((cx - bw / 2) / W, (cy - bh / 2) / W, bw / W, bh / W))
    }
    if (v.world.getItemCount() > 0) go()
    else v.addOnceHandler('open', go)
  }, [p.focus, W, p.detail.mpp])

  // replay: follow the recorded reader's viewport exactly
  useEffect(() => {
    const v = viewer.current
    if (!v || !p.follow) return
    const { x, y, w, h } = p.follow
    v.viewport.fitBounds(new OpenSeadragon.Rect(x / W, y / W, w / W, h / W), false)
  }, [p.follow, W])

  return <div ref={el} className="osd" role="application" aria-label={`Slide ${p.detail.slide_id}: drag to pan, scroll to zoom`} />
}
