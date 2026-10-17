import { useEffect, useState } from 'react'
import { api } from '../api'

interface Headline { label: string; value: string; ci?: string; note?: string; status?: 'pass' | 'fail' | 'info' }
interface EvalDoc { title?: string; measure?: string; dataset?: string; scope?: string; headline?: Headline[]; caveats?: string[]; [k: string]: unknown }

export default function EvalView() {
  const [data, setData] = useState<Record<string, EvalDoc> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { api.evalSummary().then((d) => setData(d as Record<string, EvalDoc>)).catch((e) => setErr(e.message)) }, [])
  if (err) return <div className="eval"><div className="notice warn">{err}</div></div>
  if (!data) return <div className="eval"><p className="muted">Loading…</p></div>
  const docs = Object.entries(data).filter(([, d]) => d && typeof d === 'object')
  return (
    <div className="eval">
      <h2>Evaluation results</h2>
      <p className="muted small">
        Each measure is tested on the dataset that fits it (lymph node, prostate, colon). These are separate module-level
        evaluations, not an end-to-end clinical validation. Numbers come straight from <code>bundle/eval/*.json</code>.
      </p>
      {docs.length === 0 && <div className="notice">No evaluation outputs yet. Run <code>python -m secondlook.eval.run_all</code>.</div>}
      <div className="eval-grid">
        {docs.map(([key, d]) => (
          <div key={key} className="eval-card">
            <div className="eval-head">
              <h3>{d.title ?? key}</h3>
              {d.measure && <span className="chip">{d.measure}</span>}
            </div>
            {d.dataset && <div className="small muted">{d.dataset}</div>}
            {d.scope && <div className="small warn-text">{d.scope}</div>}
            {d.headline?.map((h) => (
              <div key={h.label} className={`headline ${h.status ?? ''}`}>
                <span>{h.label}</span>
                <b>{h.value}</b>
                {h.ci && <span className="muted small">{h.ci}</span>}
                {h.note && <div className="small muted">{h.note}</div>}
              </div>
            ))}
            {d.caveats && d.caveats.length > 0 && (
              <ul className="caveats">{d.caveats.map((c) => <li key={c} className="small">{c}</li>)}</ul>
            )}
            <button className="link small" onClick={() => setOpen(open === key ? null : key)}>{open === key ? 'hide' : 'show'} raw JSON</button>
            {open === key && <pre className="raw">{JSON.stringify(d, null, 1)}</pre>}
          </div>
        ))}
      </div>
    </div>
  )
}
