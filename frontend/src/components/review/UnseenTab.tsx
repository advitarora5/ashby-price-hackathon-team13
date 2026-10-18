import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, Crosshair, History } from 'lucide-react'
import type { Coverage, Rect, Region, Signout } from '../../types'
import { LIGHT, statusOf } from '../../lib/status'
import { score } from '../../lib/format'
import Exemplars from './Exemplars'
import { Button } from '../ui/Button'
import type { ReactNode } from 'react'

interface Props {
  coverage: Coverage | null
  signout: Signout | null
  onJump: (r: Rect, what: string) => void
  activeAlert: string | null
  zoomMag: number | null
  canRunCheck: boolean
  onRunCheck: () => void
  replay: ReactNode
  replayActive: boolean
}

/** Attention tracking: what has been viewed, and the unseen-tissue check that runs before a research sign-out. */
export default function UnseenTab({ coverage, signout, onJump, activeAlert, zoomMag, canRunCheck, onRunCheck, replay, replayActive }: Props) {
  const [showReplay, setShowReplay] = useState(replayActive)
  const light = signout ? statusOf(LIGHT, signout.light) : null
  const LightIcon = light?.icon
  const minMag = coverage?.params.min_magnification ?? 10
  return (
    <div className="tab-stack">
      <section className="sub" aria-labelledby="un-cov">
        <div className="sub-head"><h3 id="un-cov">Tissue viewed {replayActive && <span className="badge tone-accent">replay</span>}</h3></div>
        {coverage ? (
          <>
            <div className="cov">
              <div className="cov-track" aria-hidden><div className="cov-fill" style={{ width: `${coverage.seen_share * 100}%` }} /></div>
              <span className="small"><b className="num">{Math.round(coverage.seen_share * 100)}%</b> of tissue viewed at ≥{minMag}×</span>
            </div>
            <p className="xs muted">
              {coverage.mode === 'viewport' ? 'Viewport tracking' : 'Eye-tracking'}: {coverage.params.definition}. {coverage.n_events} viewing events.
              {zoomMag !== null && zoomMag < minMag && <> You are at {zoomMag.toFixed(1)}×; tissue only counts as viewed at ≥{minMag}×.</>}
            </p>
          </>
        ) : <p className="small muted">Pan and zoom the slide; tissue you view at ≥{minMag}× is tracked automatically.</p>}
      </section>

      <section className="sub" aria-labelledby="un-check">
        <div className="sub-head"><h3 id="un-check">Unseen-tissue check</h3></div>
        {!signout && (
          <>
            <p className="small muted">
              Before a research sign-out, the check looks for tissue you have not viewed that the tumour probe scores highly,
              and points you to at most two regions.
            </p>
            {canRunCheck
              ? <Button variant="secondary" size="sm" onClick={onRunCheck}>Run research sign-out check</Button>
              : <p className="xs muted">Available after you record your initial assessment.</p>}
          </>
        )}
        {signout && light && LightIcon && (
          <div className={`light tone-${light.tone}`} role="status">
            <LightIcon size={18} aria-hidden />
            <div>
              <strong>{light.label}</strong>
              {signout.unseen_risk !== null && (
                <div className="small num">Highest probe score in unviewed tissue: {score(signout.unseen_risk)} · {Math.round((signout.unseen_tissue_share ?? 0) * 100)}% of tissue not viewed</div>
              )}
              {signout.thresholds.source === 'default_unvalidated'
                ? <div className="small">Cut-offs are defaults ({signout.thresholds.lo}/{signout.thresholds.hi}), not yet fit on validation slides.</div>
                : signout.thresholds.lo !== undefined && <div className="xs num">Amber from {signout.thresholds.lo}, red from {signout.thresholds.hi} (fit on recorded PathoGaze reads)</div>}
              {signout.reason && <div className="small">{signout.reason}</div>}
            </div>
          </div>
        )}
        {signout?.regions.map((r: Region) => (
          <div key={r.region_id} className={`alert ${activeAlert === r.region_id ? 'is-active' : ''} ${r.alert_status === 'revisited' ? 'is-revisited' : ''}`}>
            <div className="alert-head">
              <b>Not yet viewed · region {r.rank}</b>
              <span className="num muted">probe score {score(r.risk)} · {r.n_tiles} tiles</span>
              <Button size="sm" icon={Crosshair} onClick={() => onJump(r, `alert:${r.region_id}`)}>Go to region</Button>
            </div>
            {r.alert_status === 'revisited'
              ? <div className="small ok-text"><CircleCheck size={13} aria-hidden /> Viewed since the alert</div>
              : <div className="xs muted">View at least half of this region at ≥{minMag}× to mark it as revisited.</div>}
            <Exemplars ex={r.exemplars} title="Compare with labelled tiles" />
          </div>
        ))}
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
