import type { EvalDoc } from '../types'

/** Order follows the research questions: evidence, disagreement, attention, reader policy. */
export const RESEARCH_ORDER = ['features', 'artifacts', 'disagreement', 'unseen', 'policy']

/** Disagreement-routing evaluation result, read from /api/eval/summary (null if not available). */
export function disagreementEval(docs: Record<string, EvalDoc> | null) {
  const d = docs?.disagreement
  const h = d?.headline?.find((x) => /model errors/i.test(x.label)) ?? d?.headline?.[0]
  if (!h) return null
  return { disagreement: h.value, entropy: h.note?.match(/entropy\s+([\d.]+%)/i)?.[1] ?? null, status: h.status ?? 'info', ci: h.ci ?? null }
}
