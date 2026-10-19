import { useEffect, useState } from 'react'

export interface PanelState { size: number; open: boolean }

export interface Limits { initial: number; min: number; max: number }

const STORE = 'secondlook.layout'

function readStored(key: string): PanelState | null {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}')
    const p = all[key]
    return p && typeof p.size === 'number' && typeof p.open === 'boolean' ? p : null
  } catch { return null }
}

/** Size + open state of a dockable panel, remembered per browser (falls back to defaults). */
export function usePanel(key: string, lim: Limits) {
  const [p, setP] = useState<PanelState>(() => {
    const s = readStored(key)
    return s ? { open: s.open, size: Math.min(lim.max, Math.max(lim.min, s.size)) } : { size: lim.initial, open: true }
  })
  useEffect(() => {
    try {
      const all = JSON.parse(localStorage.getItem(STORE) ?? '{}')
      localStorage.setItem(STORE, JSON.stringify({ ...all, [key]: p }))
    } catch { /* storage unavailable: layout just isn't remembered */ }
  }, [key, p])
  return [p, setP] as const
}
