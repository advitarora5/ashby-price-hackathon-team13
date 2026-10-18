import type { PolicyRec, Read, Signout } from '../types'

/** The research review workflow, in order. The pathologist decides at every step. */
export const STEPS = [
  { id: 'initial', label: 'Initial assessment', short: 'Assess' },
  { id: 'evidence', label: 'Review AI evidence', short: 'Evidence' },
  { id: 'unseen', label: 'Unseen-tissue check', short: 'Unseen check' },
  { id: 'confirm', label: 'Confirm or revise', short: 'Confirm' },
  { id: 'reader', label: 'Additional reader', short: 'Reader' },
  { id: 'outcome', label: 'Research outcome', short: 'Outcome' },
] as const
export type StepId = (typeof STEPS)[number]['id']

export interface WorkflowState { read: Read | null; signout: Signout | null; rec: PolicyRec | null; evidenceVisible: boolean; confirmed: boolean }

/** Index of the current (first not-done) step. */
export function currentStep(s: WorkflowState): number {
  if (!s.read?.initial_decision) return 0
  if (!s.signout) return s.evidenceVisible ? 2 : 1
  if (!s.confirmed) return 3
  if (s.rec && (s.rec.suggestion === 'second_read' || s.rec.suggestion === 'third_read')) return 4
  return 5
}

export function stepDone(i: number, s: WorkflowState): boolean {
  return i < currentStep(s) || (i === 5 && currentStep(s) === 5 && !!s.signout)
}
