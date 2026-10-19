import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleX, Hourglass } from 'lucide-react'
import {
  TONE_TEXT, pct, type ArtifactsFinding, type Certainty, type DisagreementFinding, type FeaturesFinding,
  type PolicyFinding, type Range, type Tone, type UnseenFinding,
} from './findings'

/** Content width of an element, kept current with a ResizeObserver (0 until measured). */
function useWidth(el: HTMLElement | null) {
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return w
}

const TONE_ICON ={ good: CircleCheck, early: Hourglass, bad: CircleX, pending: CircleDashed } as const

export function Verdict({ tone }: { tone: Tone }) {
  const Icon = TONE_ICON[tone]
  return <span className={`verdict tone-${tone}`}><Icon size={13} aria-hidden />{TONE_TEXT[tone]}</span>
}

export function CertaintyMeter({ c }: { c: Certainty }) {
  return (
    <div className="certainty">
      <div className="certainty-row">
        <span className="certainty-meter" aria-hidden>
          {[1, 2, 3].map((i) => <span key={i} className={i <= c.level ? 'is-on' : ''} />)}
        </span>
        <span className="certainty-label">{c.label}</span>
      </div>
      <p>{c.why}</p>
    </div>
  )
}

/** Small pressed-button group; the keyboard path for every interactive chart. */
function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void
}) {
  return (
    <div className="viz-control">
      <span className="viz-control-label" aria-hidden>{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} type="button" className="seg" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

function Viz({ title, controls, children, foot }: { title: string; controls?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <figure className="viz">
      <div className="viz-head">
        <figcaption className="viz-title">{title}</figcaption>
        {controls}
      </div>
      {children}
      {foot && <div className="viz-foot">{foot}</div>}
    </figure>
  )
}

interface BarItem { key: string; label: string; detail?: string; value: number; ci?: Range | null; highlight?: boolean; tag?: string; note?: string }

/** Horizontal bars on a 0–100% scale; the thin line over each bar is its likely range. */
function Bars({ items, label }: { items: BarItem[]; label: string }) {
  return (
    <ul className="rbars"aria-label={label}>
      {items.map((b) => (
        <li key={b.key} className={`rbar-row ${b.highlight ? 'is-highlight' : ''}`}>
          <div className="rbar-text">
            <span className="rbar-label">{b.label}{b.tag && <span className="rbar-tag">{b.tag}</span>}</span>
            {b.detail && <span className="rbar-detail">{b.detail}</span>}
          </div>
          <div className="rbar-track" aria-hidden>
            <span className="rbar-fill" style={{ width: `${Math.max(0.5, b.value * 100)}%` }} />
            {b.ci && <span className="rbar-ci" style={{ left: `${b.ci[0] * 100}%`, width: `${Math.max(0.5, (b.ci[1] - b.ci[0]) * 100)}%` }} />}
          </div>
          <div className="rbar-value">
            <span className="num">{pct(b.value)}</span>
            {b.note && <span className="rbar-note">{b.note}</span>}
            <span className="sr-only">{b.ci ? `, likely range ${pct(b.ci[0])} to ${pct(b.ci[1])}` : ''}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

const rangeKey = <span className="range-key"><span className="range-swatch" aria-hidden /> likely range</span>

export function FeaturesViz({ f }: { f: FeaturesFinding }) {
  const choices = [
    { value: 'probe', label: 'Tumour detector', v: f.probe.auroc, ci: f.probe.ci },
    ...(f.text ? [{ value: 'text', label: 'Text prompt', v: f.text.auroc, ci: f.text.ci }] : []),
    { value: 'coin', label: 'Coin flip', v: 0.5, ci: null },
  ]
  const [sel, setSel] = useState('probe')
  const c = choices.find((x) => x.value === sel) ?? choices[0]
  const n = Math.round(c.v * 100)
  return (
    <Viz title="100 random tumour–healthy pairs"
      controls={<Segmented label="Score with" value={sel} onChange={setSel} options={choices.map((x) => ({ value: x.value, label: x.label }))} />}
      foot={<>Each square is one pair: a tumour tile and a healthy tile from the {f.slides} test slides ({f.tumourTiles.toLocaleString()} tumour tiles of {f.tiles.toLocaleString()}).</>}>
      <div className="pair-wrap">
        <div className="pair-grid" role="img" aria-label={`${c.label}: tumour tile scored higher in ${n} of 100 pairs`}>
          {Array.from({ length: 100 }, (_, i) => <span key={i} className={`pair ${i < n ? 'is-right' : ''}`} style={{ transitionDelay: `${i * 3}ms` }} />)}
        </div>
        <div className="pair-side">
          <div className="pair-count"><span className="pair is-right" aria-hidden /><b className="num">{n}</b><span>tumour tile scored higher (right)</span></div>
          <div className="pair-count"><span className="pair" aria-hidden /><b className="num">{100 - n}</b><span>healthy tile scored higher (wrong)</span></div>
          <p className="viz-note">
            {c.value === 'coin' ? 'Guessing gets about half the pairs right. That is the floor any real score has to beat.'
              : <>Likely range: <b className="num">{Math.round((c.ci?.[0] ?? c.v) * 100)}–{Math.min(100, Math.round((c.ci?.[1] ?? c.v) * 100))}</b> pairs out of 100.</>}
          </p>
        </div>
      </div>
    </Viz>
  )
}

export function ArtifactsViz({ f }: { f: ArtifactsFinding }) {
  return (
    <Viz title="What the filter caught on tiles we damaged on purpose"
      foot={<>{f.tiles.toLocaleString()} training tiles with blur or pen strokes added by software. Real damaged tiles still need hand labels.</>}>
      <Bars label="Damage caught by type" items={[
        { key: 'blur', label: 'Blurred tiles caught', value: f.blur, highlight: true },
        { key: 'ink', label: 'Pen-ink tiles caught', value: f.ink },
        { key: 'clean', label: 'Clean tiles flagged by mistake', detail: 'Lower is better', value: f.falseFlag },
      ]} />
    </Viz>
  )
}

export function DisagreementViz({ f }: { f: DisagreementFinding }) {
  return (
    <Viz title="Share of the AI’s mistakes a reviewer would see, checking 15% of tiles"
      foot={<>{f.errors} mistakes among {f.tiles.toLocaleString()} lymph-node tiles. {rangeKey}</>}>
      <Bars label="Mistakes found by each warning sign" items={f.signals.map((s) => ({
        key: s.key, label: s.label, detail: s.detail, value: s.rate, ci: s.ci, highlight: s.chosen,
        tag: s.chosen ? 'Used by Claripath' : s.key === 'disagreement' ? 'Idea tested' : undefined,
        note: `${Math.round(s.rate * f.errors)} of ${f.errors}`,
      }))} />
    </Viz>
  )
}

export function UnseenViz({ f }: { f: UnseenFinding }) {
  const [budget, setBudget] = useState(f.budgets.find((b) => b.budget === 1)?.budget ?? f.budgets[0].budget)
  const b = f.budgets.find((x) => x.budget === budget) ?? f.budgets[0]
  const looked = Math.max(0, f.tumourBenignCalls - f.searchMisses)
  const share = f.tumourBenignCalls ? f.searchMisses / f.tumourBenignCalls : 0
  const fmt = (n: number) => (n === 0.5 ? '½' : String(n))
  return (
    <div className="viz-stack">
      <Viz title={`Why tumours were missed (${f.tumourBenignCalls} reads that called a tumour slide benign)`}>
        <div className="split-bar" role="img" aria-label={`${f.searchMisses} never looked at, ${looked} looked at but not recognised`}>
          <span className="split-a" style={{ width: `${share * 100}%` }}>{f.searchMisses} never looked at</span>
          <span className="split-b" style={{ width: `${(1 - share) * 100}%` }}>{looked}</span>
        </div>
        <div className="pair-legend">
          <span><span className="key key-a" aria-hidden /> Tumour was never looked at <b className="num">{pct(share)}</b></span>
          <span><span className="key key-b" aria-hidden /> Looked at, but not called</span>
        </div>
      </Viz>
      <Viz title="Never-looked-at tumours flagged"
        controls={<Segmented label="Max alerts per read" value={budget} onChange={setBudget}
          options={f.budgets.map((x) => ({ value: x.budget, label: fmt(x.budget) }))} />}
        foot={<>Budget = the most alert regions allowed per benign read{b.alertsPerRead !== null ? `; Claripath actually raised ${b.alertsPerRead.toFixed(2)}` : ''}. {rangeKey}</>}>
        <Bars label="Search misses caught by each method" items={b.methods.map((m) => ({
          key: m.key, label: m.label, detail: m.detail, value: m.rate, ci: m.ci, highlight: m.key === 'ai_unseen',
          note: m.key === 'colleague_read' ? 'full extra read' : undefined,
        }))} />
      </Viz>
    </div>
  )
}

export function PolicyViz({ f }: { f: PolicyFinding }) {
  const [sel, setSel] = useState(f.options.find((o) => o.key === 'majority_5')?.key ?? f.options[0].key)
  const o = f.options.find((x) => x.key === sel) ?? f.options[0]
  const ref = f.options.find((x) => x.key === 'double_arbitrated')
  // plot geometry in CSS pixels: the chart is drawn at its real width so labels never shrink on phones
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const width = useWidth(box)
  const W = Math.round(Math.max(220, Math.min(680, width || 560))), H = W < 420 ? 200 : 230, L = 40, R = 14, T = 14, B = 34
  const xMax = Math.ceil(Math.max(...f.options.map((x) => x.reads)) / 100) * 100 + 50
  const yMin = Math.floor((Math.min(...f.options.map((x) => x.ci?.[0] ?? x.agreement)) * 100 - 2) / 5) * 5
  const x = (v: number) => L + (v / xMax) * (W - L - R)
  const y = (v: number) => T + (1 - (v * 100 - yMin) / (100 - yMin)) * (H - T - B)
  const yTicks = Array.from({ length: Math.floor((100 - yMin) / 5) + 1 }, (_, i) => yMin + i * 5)
  const step = W < 420 ? 200 : 100 // fewer ticks when narrow
  const xTicks = Array.from({ length: Math.floor(xMax / step) + 1 }, (_, i) => i * step)
  // label sits above the selected point (below it near the top edge), clear of neighbours on the line
  const narrow = W < 420
  const labelRight = x(o.reads) < W - (narrow ? 60 : 170)
  const labelY = y(o.agreement) < T + 30 ? y(o.agreement) + 22 : y(o.agreement) - 14
  return (
    <Viz title="More readers: better agreement, more work"
      controls={<Segmented label="Readers" value={sel} onChange={setSel} options={f.options.map((p) => ({ value: p.key, label: p.short }))} />}
      foot={<>{f.aiTested ? '' : 'AI as a supporting reader has not been tested yet; it will appear here once run (never simulated). '}Prostate patches graded by 7 residents against an expert reference.</>}>
      <div className="policy-stats">
        <div><span className="policy-stat num">{pct(o.agreement, 1)}</span><span className="policy-stat-label">agree with the expert</span></div>
        <div><span className="policy-stat num">{Math.round(o.reads)}</span><span className="policy-stat-label">human reads per 100 cases</span></div>
        <div className="policy-name">{o.label}</div>
      </div>
      <div ref={setBox} className="policy-plot-box">
      <svg className="policy-plot" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Agreement against reads per 100 cases. ${f.options.map((p) => `${p.label}: ${pct(p.agreement, 1)} at ${Math.round(p.reads)} reads`).join('; ')}`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t / 100)} y2={y(t / 100)} className="grid" />
            <text x={L - 8} y={y(t / 100) + 4} className="tick" textAnchor="end">{t}%</text>
          </g>
        ))}
        {xTicks.map((t) => <text key={t} x={x(t)} y={H - B + 18} className="tick" textAnchor="middle">{t}</text>)}
        <text x={(L + W - R) / 2} y={H - 2} className="axis" textAnchor="middle">human reads per 100 cases</text>
        {ref && (
          <g>
            <line x1={L} x2={W - R} y1={y(ref.agreement)} y2={y(ref.agreement)} className="ref" />
            <text x={W - R} y={y(ref.agreement) + 14} className="ref-label" textAnchor="end">double reading</text>
          </g>
        )}
        <polyline className="trend" points={f.options.map((p) => `${x(p.reads)},${y(p.agreement)}`).join(' ')} />
        {f.options.map((p) => (
          <g key={p.key} className={`pt ${p.key === sel ? 'is-selected' : ''}`} onClick={() => setSel(p.key)}>
            {p.ci && <line x1={x(p.reads)} x2={x(p.reads)} y1={y(p.ci[0])} y2={y(p.ci[1])} className="pt-ci" />}
            <circle cx={x(p.reads)} cy={y(p.agreement)} r={p.key === sel ? 7 : 5} className="pt-dot" />
            <circle cx={x(p.reads)} cy={y(p.agreement)} r={14} className="pt-hit" />
          </g>
        ))}
        <text x={x(o.reads) + (labelRight ? -6 : 6)} y={labelY} className="pt-label" textAnchor={labelRight ? 'start' : 'end'}>
          {narrow ? pct(o.agreement, 1) : `${o.label} · ${pct(o.agreement, 1)}`}
        </text>
      </svg>
      </div>
      {f.residentRange && (
        <p className="viz-note">Individual residents on their own ranged from <b className="num">{pct(f.residentRange[0])}</b> to <b className="num">{pct(f.residentRange[1])}</b>, so a single read depends heavily on who does it.</p>
      )}
    </Viz>
  )
}
