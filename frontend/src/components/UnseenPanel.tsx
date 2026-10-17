import type { Coverage, Rect, Region, Signout } from '../types'
import Exemplars from './Exemplars'

interface Props {
  coverage: Coverage | null
  signout: Signout | null
  onJump: (r: Rect, what: string) => void
  activeAlert: string | null
}

const LIGHT_TEXT: Record<string, string> = {
  green: 'No high-risk tissue left unviewed',
  amber: 'Some unviewed tissue scores moderately high',
  red: 'Unviewed tissue scores high: please look before signing out',
  unavailable: 'Coverage check unavailable',
  not_required: 'Not a benign sign-out: coverage check not required',
}

export default function UnseenPanel({ coverage, signout, onJump, activeAlert }: Props) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Unseen tissue</h3>
        <span className="muted small">what you have not looked at</span>
      </div>
      {coverage ? (
        <>
          <div className="cov">
            <div className="cov-track"><div className="cov-fill" style={{ width: `${coverage.seen_share * 100}%` }} /></div>
            <span className="small"><b>{Math.round(coverage.seen_share * 100)}%</b> of tissue viewed at ≥{coverage.params.min_magnification}×</span>
          </div>
          <p className="small muted">
            {coverage.mode === 'viewport' ? 'Viewport tracking' : 'Eye-tracking'}: {coverage.params.definition}. {coverage.n_events} events.
          </p>
        </>
      ) : <p className="small muted">Pan and zoom the slide; viewed tissue is tracked automatically.</p>}
      {signout && (
        <div className={`light light-${signout.light}`}>
          <div className="light-dot" />
          <div>
            <strong>{LIGHT_TEXT[signout.light]}</strong>
            {signout.unseen_risk !== null && (
              <div className="small">highest unseen risk {Math.round(signout.unseen_risk * 100)}% · {Math.round((signout.unseen_tissue_share ?? 0) * 100)}% of tissue unviewed</div>
            )}
            {signout.thresholds.source === 'default_unvalidated' && (
              <div className="small warn-text">Light cut-offs are defaults ({signout.thresholds.lo}/{signout.thresholds.hi}), not yet fit on validation slides.</div>
            )}
            {signout.reason && <div className="small muted">{signout.reason}</div>}
          </div>
        </div>
      )}
      {signout?.regions.map((r: Region) => (
        <div key={r.region_id} className={`alert ${activeAlert === r.region_id ? 'active' : ''} ${r.alert_status === 'revisited' ? 'revisited' : ''}`}>
          <div className="alert-head">
            <b>Unviewed region {r.rank}</b>
            <span>risk {Math.round((r.risk ?? 0) * 100)}% · {r.n_tiles} tiles</span>
            <button className="btn small" onClick={() => onJump(r, `alert:${r.region_id}`)}>Go to region</button>
          </div>
          {r.alert_status === 'revisited' && <div className="small ok-text">revisited</div>}
          <Exemplars ex={r.exemplars} title="Compare with labelled tiles" />
        </div>
      ))}
    </section>
  )
}
