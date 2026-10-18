import { useEffect, useState } from 'react'

/**
 * The backend coverage PNG (one pixel per tile) paints seen tissue blue and unseen tissue amber,
 * which collides with the yellow-red tumour heatmap. We recolour it client-side into a cool
 * slate veil over tissue not yet viewed (viewed tissue stays clear), so the two encodings never
 * share a hue family. Pixel positions are untouched, so alignment is unchanged.
 */
export const UNSEEN_VEIL: [number, number, number, number] = [30, 48, 66, 120]

async function recolour(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' })
  const bmp = await createImageBitmap(await res.blob())
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue
    const unseen = d[i] > d[i + 2] // amber (unseen) vs blue (seen)
    if (unseen) { d[i] = UNSEEN_VEIL[0]; d[i + 1] = UNSEEN_VEIL[1]; d[i + 2] = UNSEEN_VEIL[2]; d[i + 3] = UNSEEN_VEIL[3] }
    else d[i + 3] = 0
  }
  ctx.putImageData(img, 0, 0)
  const blob: Blob = await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('toBlob failed'))), 'image/png'))
  return URL.createObjectURL(blob)
}

export function useRecolouredCoverage(src: string | null): string | null {
  const [out, setOut] = useState<string | null>(null)
  useEffect(() => {
    if (!src) { setOut(null); return }
    let live = true
    let made: string | null = null
    recolour(src).then((u) => { made = u; if (live) setOut(u); else URL.revokeObjectURL(u) }).catch(() => { if (live) setOut(src) })
    return () => { live = false; if (made) window.setTimeout(() => URL.revokeObjectURL(made!), 5000) }
  }, [src])
  return src ? out : null
}
