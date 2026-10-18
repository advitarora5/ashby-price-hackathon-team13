import type { Exemplars as Ex } from '../types'

export default function Exemplars({ ex, title = 'Similar labelled tiles (other slides)' }: { ex: Ex | null | undefined; title?: string }) {
  if (!ex) return null
  if (!ex.available) return <p className="xs muted">Examples unavailable: {ex.reason}</p>
  return (
    <div className="exemplars">
      <div className="xs muted strong">{title}</div>
      <div className="ex-row">
        {(['tumor', 'benign'] as const).map((lab) => (
          <div key={lab} className="ex-col">
            <div className={`ex-label ${lab}`}>{lab === 'tumor' ? 'Labelled tumour' : 'Labelled benign'}</div>
            <div className="ex-imgs">
              {ex[lab].length === 0 && <span className="xs muted">none</span>}
              {ex[lab].map((e) => (
                <figure key={e.exemplar_id}>
                  <img src={e.image_url} alt={`${lab} example from ${e.slide_id}`} loading="lazy" />
                  <figcaption title={`${e.slide_id} · similarity ${e.similarity.toFixed(2)}`}>{e.slide_id} · {e.similarity.toFixed(2)}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
