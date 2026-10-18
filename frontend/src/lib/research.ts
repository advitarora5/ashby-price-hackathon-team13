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

/** Tile-level AUROCs for the two tumour signals, read from /api/eval/summary (features.json). */
export function tumourSignalEval(docs: Record<string, EvalDoc> | null) {
  const h = docs?.features?.headline ?? []
  const probe = h.find((x) => /tumou?r probe/i.test(x.label))
  const text = h.find((x) => /metastasis/i.test(x.label))
  const slides = text?.label.match(/(\d+) test slides?/i)?.[1] ?? probe?.label.match(/(\d+) test slides?/i)?.[1] ?? null
  return {
    probe: probe ? { auroc: probe.value, ci: probe.ci ?? null } : null,
    text: text ? { auroc: text.value, ci: text.ci ?? null } : null,
    slides,
  }
}

/** Neutral, question-style titles for each evaluation (the JSON titles read as claims). */
export const RESEARCH_QUESTIONS: Record<string, string> = {
  features: 'Do the evidence scores separate tumour from benign tiles?',
  artifacts: 'Does the artifact gate catch damaged tiles?',
  disagreement: 'Does model disagreement find the model’s errors?',
  unseen: 'Do unseen-tissue alerts catch search misses?',
  policy: 'How many human reads does a reliable call need?',
}
