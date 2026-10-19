import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Eye, FlaskConical, Microscope, Route, ScanSearch, TriangleAlert, Users } from 'lucide-react'
import type { EvalDoc, Health, PolicySummary } from '../types'
import { EvalCard } from '../components/EvalView'
import PolicyCostTable from '../components/PolicyCostTable'
import EmptyState, { SkeletonRows } from '../components/ui/EmptyState'
import { buildFindings, type Finding, type FindingId } from '../components/research/findings'
import { ArtifactsViz, CertaintyMeter, DisagreementViz, FeaturesViz, PolicyViz, UnseenViz, Verdict } from '../components/research/Visuals'

interface Props { docs: Record<string, EvalDoc> | null; error: string | null; summary: PolicySummary | null; health: Health | null }

const ICONS: Record<FindingId, typeof Eye> = { features: Microscope, artifacts: ScanSearch, disagreement: Route, unseen: Eye, policy: Users }

const GLOSSARY: [string, string][] = [
  ['AUROC', 'How well a score ranks positive tiles above negative ones: 0.5 is a coin flip, 1.0 is perfect.'],
  ['CI', '95% confidence interval from bootstrap resampling (by slide unless stated).'],
  ['QWK', 'Quadratic-weighted Cohen’s kappa: agreement on an ordered grade scale, corrected for chance.'],
  ['Search miss', 'A benign call on a tumour slide where the reader never looked at the tumour.'],
  ['CAMELYON16', 'Public lymph-node slide images with expert tumour outlines.'],
  ['PathoGaze', 'Eye-tracking recordings of pathologists reading CAMELYON16 slides.'],
  ['CrowdGleason', 'Prostate patches graded by 7 residents, with an expert reference.'],
]

function Visual({ f }: { f: Finding }) {
  switch (f.id) {
    case 'features': return <FeaturesViz f={f} />
    case 'artifacts': return <ArtifactsViz f={f} />
    case 'disagreement': return <DisagreementViz f={f} />
    case 'unseen': return <UnseenViz f={f} />
    case 'policy': return <PolicyViz f={f} />
  }
}

export default function ResearchPage({ docs, error, summary, health }: Props) {
  const findings = useMemo(() => (docs ? buildFindings(docs, summary) : []), [docs, summary])
  const [selected, setSelected] = useState<FindingId>('features')
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const current = findings.find((f) => f.id === selected) ?? findings[0]

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = findings.findIndex((f) => f.id === current?.id)
    const n = e.key === 'ArrowRight' ? (i + 1) % findings.length : e.key === 'ArrowLeft' ? (i - 1 + findings.length) % findings.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? findings.length - 1 : -1
    if (n < 0) return
    e.preventDefault()
    setSelected(findings[n].id)
    tabs.current[n]?.focus()
  }

  return (
    <div className="page">
      <div className="page-inner research-page">
        <header className="page-header">
          <div>
            <h1>Research Insights</h1>
            <p className="research-intro">
              Each part of Claripath was tested on its own, on a public dataset that fits it. Pick a test to see what it found
              and how much to trust it.
            </p>
          </div>
        </header>

        {error ? <EmptyState icon={TriangleAlert} tone="warning" title="Evaluation results could not be loaded">{error}</EmptyState>
          : !docs ? <SkeletonRows rows={6} cols={3} />
            : !current ? <EmptyState icon={FlaskConical} title="No evaluation results yet">Results appear here once the evaluations have been run.</EmptyState>
              : (
                <>
                  <div className="finding-cards" role="tablist" aria-label="Research tests" onKeyDown={onKey}>
                    {findings.map((f, i) => {
                      const Icon = ICONS[f.id]
                      const sel = f.id === current.id
                      return (
                        <button key={f.id} ref={(el) => { tabs.current[i] = el }} type="button" role="tab" id={`rs-tab-${f.id}`}
                          aria-selected={sel} aria-controls="rs-detail" tabIndex={sel ? 0 : -1}
                          className={`finding-card tone-${f.tone} ${sel ? 'is-selected' : ''}`} onClick={() => setSelected(f.id)}>
                          <span className="fc-topic"><Icon size={15} aria-hidden />{f.topic}</span>
                          <span className="fc-big num">{f.big}</span>
                          <span className="fc-label">{f.bigLabel}</span>
                          <Verdict tone={f.tone} />
                        </button>
                      )
                    })}
                  </div>

                  <section className="panel finding" id="rs-detail" role="tabpanel" aria-labelledby={`rs-tab-${current.id}`} key={current.id}>
                    <div className="finding-body">
                      <div className="finding-text">
                        <div className="finding-kicker">{current.topic}</div>
                        <h2 className="finding-question">{current.question}</h2>
                        <h3>What we found</h3>
                        <p className="finding-found">{current.found}</p>
                        <h3>What it means for Claripath</h3>
                        <p>{current.meaning}</p>
                        <h3>How sure are we?</h3>
                        <CertaintyMeter c={current.certainty} />
                      </div>
                      <div className="finding-viz"><Visual f={current} /></div>
                    </div>
                    <details className="finding-tech">
                      <summary><ChevronRight size={14} aria-hidden /> Technical details and limitations</summary>
                      <div className="finding-tech-body">
                        {docs[current.id] && <EvalCard k={current.id} d={docs[current.id]} />}
                        {current.id === 'policy' && <PolicyCostTable summary={summary} />}
                        <dl className="glossary">
                          {GLOSSARY.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
                        </dl>
                      </div>
                    </details>
                  </section>
                </>
              )}

        <p className="research-footnote small muted">
          <FlaskConical size={13} aria-hidden /> Research use only. Each test uses a different dataset and organ, so results are never combined, and none of
          this is a clinical validation. Every number comes from the saved evaluation files; nothing is simulated.
          {health?.provenance && <> Live review data: {health.provenance}.</>}
        </p>
      </div>
    </div>
  )
}
