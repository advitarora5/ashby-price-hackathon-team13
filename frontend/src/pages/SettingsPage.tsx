import type { Health } from '../types'
import { BRAND } from '../brand'
import { SESSION_ID } from '../api'
import { absoluteTime } from '../lib/format'
import Panel from '../components/ui/Panel'

/** Turn known provenance IDs into readable text; unknown IDs are shown as-is. */
function humanSource(src?: string) {
  if (!src) return ''
  const m = src.match(/^pathogaze_fit:(\d+)_benign_reads:budgets_([\d.]+)_and_([\d.]+)$/)
  if (m) return `fit on ${m[1]} PathoGaze benign reads (alert budgets ${m[2]} and ${m[3]} per read)`
  const d = src.match(/^disagreement_eval (\w+): disagreement ([\d.]+) vs entropy ([\d.]+) \((\d+) slides?\)$/)
  if (d) return `evaluation on ${d[1].toUpperCase()}: uncertainty (entropy) caught ${Math.round(+d[3] * 1000) / 10}% of model errors vs ${Math.round(+d[2] * 1000) / 10}% for disagreement (${d[4]} slides)`
  if (src === 'default_unvalidated') return 'defaults, not fit on validation data'
  return src
}

interface Props { blindAll: boolean; onBlindAll: (v: boolean) => void; health: Health | null }

export default function SettingsPage({ blindAll, onBlindAll, health }: Props) {
  const light = health?.thresholds?.light
  const routing = health?.thresholds?.routing_signal
  return (
    <div className="page">
      <div className="page-inner page-narrow">
        <header className="page-header">
          <div>
            <h1>Settings</h1>
            <div className="page-context"><span>Review preferences for this browser, plus the data and thresholds the app is running with.</span></div>
          </div>
        </header>

        <Panel title="Review workflow" id="st-review">
          <div className="setting-row">
            <div className="setting-text">
              <label htmlFor="blind-all" className="setting-label">Blind-first for all cases</label>
              <p className="setting-help" id="blind-all-help">
                Record your own assessment before any AI evidence is shown, on every case. Slow-path cases are always blind-first.
                Applies to the next case you open; a read already open keeps its mode.
              </p>
            </div>
            <label className="switch">
              <input id="blind-all" type="checkbox" role="switch" aria-describedby="blind-all-help" checked={blindAll}
                onChange={(e) => onBlindAll(e.target.checked)} />
              <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
              <span className="switch-state">{blindAll ? 'On' : 'Off'}</span>
            </label>
          </div>
        </Panel>

        <Panel title="Data and thresholds" id="st-data">
          <dl className="kv-list">
            <div><dt>Status</dt><dd>{health ? (health.ok ? 'Backend reachable' : 'Backend reports a problem') : 'Checking…'}</dd></div>
            <div><dt>Provenance</dt><dd>{health?.provenance ?? '—'}</dd></div>
            <div><dt>Cases in bundle</dt><dd className="num">{health?.cases ?? '—'}</dd></div>
            <div><dt>Bundle updated</dt><dd>{health?.manifest_updated ? absoluteTime(health.manifest_updated) : '—'}</dd></div>
            <div><dt>Routing signal</dt><dd>{routing?.signal === 'entropy' ? 'Model uncertainty (normalised entropy)' : routing?.signal ?? '—'}
              {routing?.source && <div className="muted small" title={routing.source}>{humanSource(routing.source)}</div>}</dd></div>
            <div><dt>Sign-out light thresholds</dt><dd>
              {light ? <>amber ≥ <span className="num">{light.lo}</span>, red ≥ <span className="num">{light.hi}</span>
                <div className="muted small" title={light.source}>{humanSource(light.source)}</div></> : '—'}
            </dd></div>
            <div><dt>Session</dt><dd className="mono">{SESSION_ID}</dd></div>
          </dl>
        </Panel>

        <p className="small muted footnote">{BRAND.name} · {BRAND.descriptor}. {BRAND.researchNoticeLong}</p>
      </div>
    </div>
  )
}
