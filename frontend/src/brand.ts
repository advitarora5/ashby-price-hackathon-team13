/**
 * Single source of truth for product branding. Change the name here (and nowhere else);
 * index.html picks these up at build time through the plugin in vite.config.ts.
 * Name-conflict notes: docs/design/claripath-design-direction.md (not a trademark clearance).
 */
export const BRAND = {
  name: 'Claripath',
  shortName: 'Claripath',
  tagline: 'Illuminate what matters.',
  descriptor: 'Clinical Review Intelligence',
  researchNotice: 'Research use only',
  researchNoticeLong: 'Research use only. Not for clinical diagnosis; not validated for patient care.',
} as const

export type Brand = typeof BRAND
