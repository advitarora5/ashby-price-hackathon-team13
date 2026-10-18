import { CircleCheck, Crosshair } from 'lucide-react'
import type { Coverage, Rect, Region, Signout } from '../types'
import { LIGHT, statusOf } from '../lib/status'
import { score } from '../lib/format'
import Exemplars from './Exemplars'
import { Button } from './ui/Button'

interface Props {
  coverage: Coverage | null
  signout: Signout | null
  onJump: (r: Rect, what: string) => void
  activeAlert: string | null
}

export default function UnseenPanel({ coverage, signout, onJump, activeAlert }: Props) {
  const light = signout ? statusOf(LIGHT, signout.light) : null
  const LightIcon = light?.icon
  return (
    <section className="side-panel" aria-labelledby="unseen-title">
      <div className="side-panel-head">
        <h2 id="unseen-title">Unseen areas</h2>
        <span className="muted xs">tissue you have not viewed yet</span>
      </div>
      {coverage ? (
        <>
          <div className="cov">
            <div className="cov-track" aria-hidden><div className="cov-fill" style={{ width: `${coverage.seen_share * 100}%` }} /></div>
            <span className="small"><b className="num">{Math.round(coverage.seen_share * 100)}%</b> of tissue viewed at ≥{coverage.params.min_magnification}×</span>
          </div>
          <p className="xs muted">
            {coverage.mode === 'viewport' ? 'Viewport tracking' : 'Eye-tracking'}: {coverage.params.definition}. {coverage.n_events} events.
          </p>
        </>
      ) : <p className="small muted">Pan and zoom the slide; viewed tissue is tracked automatically.</p>}
      {signout && light && LightIcon && (
        <div className={`light tone-${light.tone}`} role="status">
          <LightIcon size={18} aria-hidden />
          <div>
            <strong>{light.label}</strong>
            {signout.unseen_risk !== null && (
              <div className="small num">Highest unviewed-tissue score {score(signout.unseen_risk)} · {Math.round((signout.unseen_tissue_share ?? 0) * 100)}% of tissue not viewed</div>
            )}
            {signout.thresholds.source === 'default_unvalidated'
              ? <div className="small warn-text">Cut-offs are defaults ({signout.thresholds.lo}/{signout.thresholds.hi}), not yet fit on validation slides.</div>
              : signout.thresholds.lo !== undefined && <div className="xs muted num">Thresholds {signout.thresholds.lo} / {signout.thresholds.hi} ({signout.thresholds.source})</div>}
            {signout.reason && <div className="small muted">{signout.reason}</div>}
          </div>
        </div>
      )}
      {signout?.regions.map((r: Region) => (
        <div key={r.region_id} className={`alert ${activeAlert === r.region_id ? 'is-active' : ''} ${r.alert_status === 'revisited' ? 'is-revisited' : ''}`}>
          <div className="alert-head">
            <b>Not yet viewed · region {r.rank}</b>
            <span className="num muted">score {score(r.risk)} · {r.n_tiles} tiles</span>
            <Button size="sm" icon={Crosshair} onClick={() => onJump(r, `alert:${r.region_id}`)}>Go to region</Button>
          </div>
          {r.alert_status === 'revisited' && <div className="small ok-text"><CircleCheck size={13} aria-hidden /> Revisited</div>}
          <Exemplars ex={r.exemplars} title="Compare with labelled tiles" />
        </div>
      ))}
    </section>
  )
}
