import type { EvalDoc, PolicySummary } from '../../types'

/**
 * Plain-language findings for the Research Insights page. Every number is read from the saved
 * evaluation files (/api/eval/summary, /api/policy/summary); a finding whose inputs are missing
 * is returned as null rather than guessed.
 */

export type Tone = 'good' | 'early' | 'bad' | 'pending'
export type FindingId = 'features' | 'artifacts' | 'disagreement' | 'unseen' | 'policy'
export type Range = [number, number]

export const TONE_TEXT: Record<Tone, string> = {
  good: 'Holds up',
  early: 'Promising, early',
  bad: 'Didn’t work, design changed',
  pending: 'Not tested on real data yet',
}

export interface Certainty { level: 0 | 1 | 2 | 3; label: string; why: string }

interface Base {
  id: FindingId
  topic: string
  question: string
  tone: Tone
  /** the single number on the overview card, with what it counts */
  big: string
  bigLabel: string
  found: string
  meaning: string
  certainty: Certainty
}

export interface FeaturesFinding extends Base {
  id: 'features'
  probe: { auroc: number; ci: Range | null }
  text: { auroc: number; ci: Range | null } | null
  slides: number; tiles: number; tumourTiles: number
}
export interface ArtifactsFinding extends Base {
  id: 'artifacts'
  blur: number; ink: number; falseFlag: number; tiles: number
}
export interface SignalResult { key: string; label: string; detail: string; rate: number; ci: Range | null; chosen: boolean }
export interface DisagreementFinding extends Base {
  id: 'disagreement'
  signals: SignalResult[]; errors: number; slides: number; tiles: number
}
export interface MethodResult { key: string; label: string; detail: string; rate: number; ci: Range | null; cost: string }
export interface UnseenBudget { budget: number; alertsPerRead: number | null; methods: MethodResult[] }
export interface UnseenFinding extends Base {
  id: 'unseen'
  budgets: UnseenBudget[]; searchMisses: number; tumourBenignCalls: number; slides: number | null
}
export interface PolicyOption { key: string; label: string; short: string; reads: number; agreement: number; ci: Range | null }
export interface PolicyFinding extends Base {
  id: 'policy'
  options: PolicyOption[]; residentRange: Range | null; patches: number | null; slides: number | null; aiTested: boolean
}

export type Finding = FeaturesFinding | ArtifactsFinding | DisagreementFinding | UnseenFinding | PolicyFinding

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const range = (v: unknown): Range | null =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`

/** Sample size in words. Slide count is what limits every evaluation here (bootstrap is by slide). */
function certaintyFromSlides(slides: number | null, unit = 'test slides'): Certainty {
  if (slides === null) return { level: 0, label: 'Unknown', why: 'The sample size was not recorded.' }
  if (slides < 10) return { level: 1, label: 'Low', why: `Only ${slides} ${unit}, so the true value could be quite different.` }
  if (slides < 50) return { level: 2, label: 'Moderate', why: `${slides} ${unit}: enough to see a pattern, not enough to rely on it.` }
  return { level: 3, label: 'High', why: `${slides.toLocaleString()} ${unit}, with tight ranges.` }
}

function features(d: EvalDoc | undefined): FeaturesFinding | null {
  const l = obj(d?.lymph_node)
  const probe = num(l.tumor_probe_auroc)
  if (!d || d.error || !l.available || probe === null) return null
  const text = num(l.metastasis_text_auroc)
  const slides = num(l.n_slides) ?? 0
  const ci = range(l.tumor_probe_auroc_ci)
  const pairs = Math.round(probe * 100)
  return {
    id: 'features', topic: 'Tumour detector', question: 'Can it tell tumour tiles from healthy ones?',
    tone: probe >= 0.85 ? 'good' : probe >= 0.7 ? 'early' : 'bad',
    big: `${pairs} / 100`, bigLabel: 'tumour–healthy pairs ranked the right way',
    found: `Shown one tumour tile and one healthy tile, the tumour detector gives the tumour tile the higher score ${pairs} times out of 100. A coin flip would manage 50.${text !== null ? ` The text-prompt “metastasis” bar manages ${Math.round(text * 100)}.` : ''}`,
    meaning: 'The tumour-detector score is a useful cue on lymph-node slides. The text-prompt bar is much weaker, so treat it as a hint, not evidence.',
    certainty: {
      ...certaintyFromSlides(slides),
      why: `Only ${slides} lymph-node test slides${ci ? `, so the true score could be anywhere from ${Math.round(ci[0] * 100)} to ${Math.min(100, Math.round(ci[1] * 100))} out of 100` : ''}.${obj(d.colon).available ? '' : ' Colon tissue has not been tested yet.'}`,
    },
    probe: { auroc: probe, ci }, text: text !== null ? { auroc: text, ci: range(l.metastasis_text_auroc_ci) } : null,
    slides, tiles: num(l.n_tiles) ?? 0, tumourTiles: num(l.n_pos) ?? 0,
  }
}

function artifacts(d: EvalDoc | undefined): ArtifactsFinding | null {
  const s = obj(d?.synthetic)
  const blur = num(s.blur_recall_on_injected_blur)
  const ink = num(s.ink_recall_on_injected_pen)
  if (!d || d.error || !s.available || blur === null || ink === null) return null
  const flags = Object.values(obj(s.false_flag_rate_on_clean)).map(num).filter((x): x is number => x !== null)
  const falseFlag = flags.length ? Math.max(...flags) : 0
  const real = Boolean(obj(d.real).available)
  return {
    id: 'artifacts', topic: 'Damage filter', question: 'Does it catch blurry or ink-marked tiles before scoring?',
    tone: real ? 'good' : 'pending',
    big: pct(blur), bigLabel: 'of blurred tiles caught (simulated damage)',
    found: `On tiles where we added damage ourselves, the filter caught ${pct(blur)} of blur and ${pct(ink)} of pen ink, and flagged ${pct(falseFlag)} of clean tiles by mistake.`,
    meaning: 'Blurry tissue is reliably kept out of the scores; pen ink gets through about half the time. This only shows the rules fire. It is not a measured accuracy.',
    certainty: { level: real ? 2 : 0, label: real ? 'Moderate' : 'Not measured', why: real ? 'Measured on hand-labelled tiles.' : 'No real damaged tiles have been hand-labelled yet, so there is no reportable number.' },
    blur, ink, falseFlag, tiles: num(s.n_tiles) ?? 0,
  }
}

const SIGNALS: Record<string, [string, string]> = {
  entropy: ['Single-model uncertainty', 'How unsure one model is about a tile'],
  disagreement: ['Two-model disagreement', 'Whether two different models give different answers'],
  knn_distance: ['Unfamiliar tissue', 'How far a tile is from tiles seen in training'],
  random: ['Random 15%', 'Picking tiles at random, as a floor'],
}

function disagreement(d: EvalDoc | undefined): DisagreementFinding | null {
  const c = obj(d?.camelyon16)
  const res = obj(c.results)
  if (!d || d.error || !c.available || !res.disagreement) return null
  const chosen = String(obj(d.routing_signal).signal ?? 'entropy')
  const signals: SignalResult[] = Object.entries(SIGNALS).flatMap(([key, [label, detail]]) => {
    const r = obj(res[key]); const rate = num(r.capture_top15)
    return rate === null ? [] : [{ key, label, detail, rate, ci: range(r.capture_ci), chosen: key === chosen }]
  }).sort((a, b) => b.rate - a.rate)
  const dis = signals.find((s) => s.key === 'disagreement')
  const best = signals[0]
  if (!dis || !best) return null
  const beaten = best.key !== 'disagreement'
  const slides = num(c.n_slides)
  return {
    id: 'disagreement', topic: 'Case routing', question: 'Which warning sign best finds the AI’s own mistakes?',
    tone: beaten ? 'bad' : 'good',
    big: beaten ? `${pct(best.rate)} vs ${pct(dis.rate)}` : pct(dis.rate),
    bigLabel: beaten ? 'of AI mistakes found: uncertainty vs disagreement' : 'of AI mistakes found by disagreement',
    found: beaten
      ? `If a reviewer checks the 15% of tiles each signal flags, ${best.label.toLowerCase()} puts ${pct(best.rate)} of the AI’s mistakes in front of them. Two-model disagreement, the idea we set out to test, finds only ${pct(dis.rate)}.`
      : `Checking the 15% of tiles flagged by disagreement surfaces ${pct(dis.rate)} of the AI’s mistakes, more than any simpler signal.`,
    meaning: beaten
      ? 'So Claripath sends cases for a closer look using single-model uncertainty. Disagreement still appears on each slide, but only for comparison.'
      : 'Claripath routes cases by two-model disagreement.',
    certainty: { ...certaintyFromSlides(slides), why: `${num(c.n_errors) ?? '?'} AI mistakes across ${slides ?? '?'} lymph-node test slides. ${beaten && dis.ci && best.ci && dis.ci[1] < best.rate ? ' Even so, the gap between the two signals is clear.' : ''}${obj(d.nct).available ? '' : ' Colon tissue has not been tested yet.'}` },
    signals, errors: num(c.n_errors) ?? 0, slides: slides ?? 0, tiles: num(c.n_tiles) ?? 0,
  }
}

const METHODS: Record<string, [string, string]> = {
  ai_unseen: ['Claripath unseen-tissue alerts', 'AI score on tissue the reader never looked at'],
  ai_ignoring_log: ['AI alerts, ignoring gaze', 'Same AI score, without knowing where the reader looked'],
  colleague_read: ['A colleague’s second read', 'Another pathologist reads the whole slide'],
  random_unseen: ['Random unseen spot', 'A random region the reader skipped'],
  colorhist_control: ['Colour-only control', 'Flags tissue by stain colour alone'],
}

function unseen(d: EvalDoc | undefined): UnseenFinding | null {
  const p = obj(d?.primary)
  const b = obj(p.budgets)
  if (!d || d.error || !Object.keys(b).length) return null
  const budgets: UnseenBudget[] = Object.entries(b).map(([k, v]) => {
    const catchBy = obj(obj(v).catch)
    const methods = Object.entries(METHODS).flatMap(([key, [label, detail]]) => {
      const m = obj(catchBy[key]); const rate = num(m.rate)
      return rate === null ? [] : [{ key, label, detail, rate, ci: range(m.ci_by_slide), cost: String(m.cost ?? '') }]
    })
    return { budget: Number(k), alertsPerRead: num(obj(v).alerts_per_benign_read), methods }
  }).filter((x) => x.methods.length && Number.isFinite(x.budget)).sort((a, z) => a.budget - z.budget)
  if (!budgets.length) return null
  const misses = num(p.n_search_miss) ?? 0
  const calls = num(p.n_tumor_benign_reads) ?? 0
  const slides = Number(d.caveats?.join(' ').match(/Effective sample:\s*(\d+)\s+slides/i)?.[1] ?? NaN)
  const ref = budgets.find((x) => x.budget === 1) ?? budgets[budgets.length - 1]
  const rate = (k: string) => ref.methods.find((m) => m.key === k)?.rate ?? null
  const ours = rate('ai_unseen'); const colleague = rate('colleague_read')
  const vsColleague = ours === null || colleague === null || colleague === 0 ? ''
    : ours / colleague >= 1.8 ? `, about ${(ours / colleague).toFixed(0)}× what a colleague’s full second read catches (${pct(colleague)})`
      : ours > colleague * 1.1 ? `, more than a colleague’s full second read catches (${pct(colleague)})`
        : ours < colleague * 0.9 ? `, less than a colleague’s full second read catches (${pct(colleague)})`
          : `, about the same as a colleague’s full second read (${pct(colleague)})`
  return {
    id: 'unseen', topic: 'Unseen-tissue alerts', question: 'Can it point readers to tumour they never looked at?',
    tone: 'early',
    big: ours !== null ? pct(ours) : '—', bigLabel: 'of never-looked-at tumours flagged, at most 1 alert per read',
    found: `${misses} of ${calls} missed tumours (${calls ? pct(misses / calls) : '—'}) were in tissue the pathologist never looked at.${ours !== null ? ` With at most one alert per read, Claripath flags ${pct(ours)} of them${vsColleague}.` : ''}`,
    meaning: 'Pointing readers to tissue they skipped targets the most common way tumours get missed. But AI alerts that ignore eye-tracking have done just as well so far, so the gaze data has not yet shown extra value.',
    certainty: { ...certaintyFromSlides(Number.isFinite(slides) ? slides : null, 'slides'), why: `${Number.isFinite(slides) ? `${slides} slides` : 'A small set of slides'} and ${misses} missed-tumour reads so far, so the ranges are wide (see the whiskers).` },
    budgets, searchMisses: misses, tumourBenignCalls: calls, slides: Number.isFinite(slides) ? slides : null,
  }
}

const POLICIES: Record<string, [string, string]> = {
  single: ['1 reader', '1'],
  double_arbitrated: ['2 readers, 3rd breaks ties', '2 + tiebreak'],
  majority_3: ['Majority of 3', '3'],
  majority_5: ['Majority of 5', '5'],
  majority_7: ['Majority of 7', '7'],
  ai_supported: ['AI as supporting reader', 'AI'],
}

function policy(summary: PolicySummary | null, d: EvalDoc | undefined): PolicyFinding | null {
  let options: PolicyOption[] = []
  if (summary?.available) {
    options = summary.runs.map((r) => ({ key: r.policy, label: POLICIES[r.policy]?.[0] ?? r.policy, short: POLICIES[r.policy]?.[1] ?? r.policy,
      reads: r.reads_per_100, agreement: r.agreement, ci: [r.ci_low, r.ci_high] as Range }))
  } else if (Array.isArray(d?.policies)) {
    options = (d.policies as unknown[]).flatMap((x) => {
      const r = obj(x); const a = num(r.agreement); const reads = num(r.reads_per_100); const k = String(r.policy)
      return a === null || reads === null ? [] : [{ key: k, label: POLICIES[k]?.[0] ?? k, short: POLICIES[k]?.[1] ?? k, reads, agreement: a, ci: range(r.agreement_ci) }]
    })
  }
  options = options.filter((o) => POLICIES[o.key]).sort((a, b) => a.reads - b.reads)
  const one = options.find((o) => o.key === 'single')
  const five = options.find((o) => o.key === 'majority_5')
  if (!one) return null
  const per = (summary?.per_resident ?? (d?.per_resident as { agreement: number }[] | undefined) ?? []).map((r) => r.agreement)
  const patches = summary?.n_patches ?? num(d?.n_patches)
  const slides = summary?.n_slides ?? num(d?.n_slides)
  const aiTested = options.some((o) => o.key === 'ai_supported')
  return {
    id: 'policy', topic: 'Reader policy', question: 'How many human reads does a reliable grade need?',
    tone: 'good',
    big: pct(one.agreement, 1), bigLabel: `agreement with the expert from one reader${five ? ` (5 readers: ${pct(five.agreement, 1)})` : ''}`,
    found: `One resident agrees with the expert’s prostate grade ${pct(one.agreement, 1)} of the time.${five ? ` A majority of five reaches ${pct(five.agreement, 1)}, at five times the reading work.` : ''}${per.length ? ` Individual residents ranged from ${pct(Math.min(...per))} to ${pct(Math.max(...per))}.` : ''}`,
    meaning: aiTested
      ? 'Compare the AI-supported policy with the human-only ones to see what it saves.'
      : 'A single read isn’t reliable enough for grading. The real question is whether AI support can close that gap with fewer reads, and that test hasn’t been run yet.',
    certainty: {
      ...certaintyFromSlides(slides ?? null, 'slides'),
      why: `${patches?.toLocaleString() ?? '?'} graded patches from ${slides ?? '?'} slides, so the ranges are tight. One caution: the expert may have seen the residents’ grades, which would flatter the multi-reader policies.`,
    },
    options, residentRange: per.length ? [Math.min(...per), Math.max(...per)] : null, patches: patches ?? null, slides: slides ?? null, aiTested,
  }
}

export function buildFindings(docs: Record<string, EvalDoc>, summary: PolicySummary | null): Finding[] {
  return [features(docs.features), artifacts(docs.artifacts), disagreement(docs.disagreement), unseen(docs.unseen), policy(summary, docs.policy)]
    .filter((f): f is Finding => f !== null)
    // a good result on a tiny sample is not yet "holds up"
    .map((f) => (f.tone === 'good' && f.certainty.level < 2 ? { ...f, tone: 'early' as const } : f))
}
