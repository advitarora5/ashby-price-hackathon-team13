import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, Crosshair, History } from 'lucide-react'
import type { Coverage, Rect, Region, Signout } from '../../types'
import { LIGHT, statusOf } from '../../lib/status'
import { score, share } from '../../lib/format'
import Exemplars from './Exemplars'
import { Button } from '../ui/Button'

interface Props {
  coverage: Coverage | null
  /** most recent check (may be "not required" after a revision to a positive call) */
  latest: Signout | null
  /** most recent check that produced alerts; kept so a re-check never erases them */
  alertCheck: Signout | null
  finalDecision: string | null
  onJump: (r: Rect, what: string) => void
  activeAlert: string | null
  zoomMag: number | null
  canRunCheck: boolean
  /** why the check cannot run yet, when the call is recorded but notes or feature verdicts are missing */
  checkTodo: string[]
  onRunCheck: () => void
  replay: ReactNode
  replayActive: boolean
}

function Light({ s, label }: { s: Signout; label?: string }) {
  const light = statusOf(LIGHT, s.light)
  const Icon = light.icon
  return (
    <div className={`light tone-${light.tone}`} role="status">
      <Icon size={18} aria-hidden />
      <div>
        {label && <div className="xs">{label}</div>}
        <strong>{light.label}</strong>
        {s.unseen_risk !== null && (
          <div className="small num">Highest probe score in unviewed tissue: {score(s.unseen_risk)}{s.unseen_tissue_share !== null ? ` · ${share(s.unseen_tissue_share)} of tissue not viewed` : ''}</div>
        )}
        {s.thresholds.source === 'default_unvalidated'
          ? <div className="small">Cut-offs are defaults ({s.thresholds.lo}/{s.thresholds.hi}), not yet fit on validation slides.</div>
          : s.thresholds.lo !== undefined && <div className="xs num">Amber from {s.thresholds.lo}, red from {s.thresholds.hi} (fit on recorded PathoGaze reads)</div>}
        {s.reason && <div className="small">{s.reason}</div>}
      </div>
    </div>
  )
}

/** Attention tracking: what has been viewed, and the unseen-tissue check that runs before a research sign-out. */
export default function UnseenTab({ coverage, latest, alertCheck, finalDecision, onJump, activeAlert, zoomMag, canRunCheck, checkTodo, onRunCheck, replay, replayActive }: Props) {
  const [showReplay, setShowReplay] = useState(replayActive)
  const minMag = coverage?.params.min_magnification ?? 10
  const recheckDiffers = latest && alertCheck && latest !== alertCheck
  return (
    <div className="tab-stack">
      <section className="sub" aria-labelledby="un-cov">
        <div className="sub-head"><h3 id="un-cov">Tissue viewed {replayActive && <span className="badge tone-accent">replay</span>}</h3></div>
        {coverage ? (
          <>
            <div className="cov">
              <div className="cov-track" aria-hidden><div className="cov-fill" style={{ width: `${Math.max(coverage.seen_share > 0 ? 1 : 0, coverage.seen_share * 100)}%` }} /></div>
              <span className="small"><b className="num">{share(coverage.seen_share)}</b> viewed at ≥{minMag}× <span className="muted num">({coverage.seen_tiles.toLocaleString()} of {coverage.tissue_tiles.toLocaleString()} tissue tiles)</span></span>
            </div>
            <p className="xs muted">
              {coverage.mode === 'viewport' ? 'Viewport tracking' : 'Eye-tracking'}: {coverage.params.definition}.
              {zoomMag !== null && zoomMag < minMag && <> You are at {zoomMag.toFixed(1)}×; tissue only counts at ≥{minMag}×.</>}
            </p>
          </>
        ) : <p className="small muted">Pan and zoom the slide; tissue you view at ≥{minMag}× is tracked automatically.</p>}
      </section>

      <section className="sub" aria-labelledby="un-check">
        <div className="sub-head"><h3 id="un-check">Unseen-tissue check</h3></div>
        {!latest && (
          <>
            <p className="small muted">
              Before a research sign-out, the check looks for tissue you have not viewed that the tumour probe scores highly,
              and points you to at most two regions.
            </p>
            {canRunCheck && checkTodo.length === 0
              ? <Button variant="secondary" size="sm" onClick={onRunCheck}>Run research sign-out check</Button>
              : <p className="xs muted">{canRunCheck ? `Before the check, record: ${checkTodo.join(', ')}.` : 'Available after you record your initial assessment.'}</p>}
          </>
        )}
        {alertCheck && <Light s={alertCheck} label={recheckDiffers ? 'Check on your initial call' : undefined} />}
        {recheckDiffers && latest && (
          <div className="history-note small">
            <strong>Re-check{finalDecision ? ` on your final call (${finalDecision})` : ''}:</strong> {statusOf(LIGHT, latest.light).label.toLowerCase()}.
            {latest.light === 'not_required' && ' The check applies to benign calls only; the earlier alerts and your revisits are kept below.'}
          </div>
        )}
        {!alertCheck && latest && <Light s={latest} />}
        {alertCheck?.regions.map((r: Region) => {
          const revisited = r.alert_status === 'revisited'
          return (
            <div key={r.region_id} className={`alert ${activeAlert === r.region_id ? 'is-active' : ''} ${revisited ? 'is-revisited' : ''}`}>
              <div className="alert-head">
                <b>{revisited ? `Region ${r.rank} · revisited` : `Not yet viewed · region ${r.rank}`}</b>
                <span className="num muted">probe score {score(r.risk)} · {r.n_tiles} tiles</span>
                <Button size="sm" icon={Crosshair} onClick={() => onJump(r, `alert:${r.region_id}`)}>Go to region</Button>
              </div>
              {revisited
                ? <div className="small ok-text"><CircleCheck size={13} aria-hidden /> Viewed at ≥{minMag}× since the alert</div>
                : <div className="xs muted">Go to region lands at ≥{minMag}×; view at least half of it to mark it revisited.</div>}
              <Exemplars ex={r.exemplars} title="Compare with labelled tiles" />
            </div>
          )
        })}
      </section>

      <section className="sub">
        <button type="button" className="disclosure" aria-expanded={showReplay} onClick={() => setShowReplay(!showReplay)}>
          {showReplay ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <History size={14} aria-hidden /> Teaching: replay a recorded read
        </button>
        {showReplay && replay}
      </section>
    </div>
  )
}
