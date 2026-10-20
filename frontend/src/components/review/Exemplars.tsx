import { useState } from 'react'
import { X } from 'lucide-react'
import type { Exemplar, Exemplars as Ex } from '../../types'

/** Labelled look-alike tiles. Similarity is always visible; click a tile to enlarge it. */
export default function Exemplars({ ex, title = 'Similar labelled tiles (other slides)' }: { ex: Ex | null | undefined; title?: string }) {
  const [big, setBig] = useState<Exemplar | null>(null)
  if (!ex) return null
  if (!ex.available) return <p className="xs muted">Examples unavailable: {ex.reason}</p>
  const best = (l: 'tumor' | 'benign') => Math.max(0, ...ex[l].map((e) => e.similarity))
  const tied = ex.tumor.length > 0 && ex.benign.length > 0 && Math.abs(best('tumor') - best('benign')) < 0.03
  return (
    <div className="exemplars">
      <div className="xs muted strong">{title}</div>
      {big && (
        <figure className="ex-big">
          <img src={big.image_url} alt={`${big.label} example from slide ${big.slide_id}, enlarged`} />
          <figcaption>
            <span>{big.label === 'tumor' ? 'Tumour' : 'Benign'} tile · slide {big.slide_id}</span>
            <span className="num">similarity {big.similarity.toFixed(2)}</span>
          </figcaption>
          <button type="button" className="ex-close" aria-label="Close enlarged example" onClick={() => setBig(null)}><X size={14} aria-hidden /></button>
        </figure>
      )}
      <div className="ex-row">
        {(['tumor', 'benign'] as const).map((lab) => (
          <div key={lab} className="ex-col">
            <div className={`ex-label ${lab}`}>{lab === 'tumor' ? 'Labelled tumour' : 'Labelled benign'}</div>
            <div className="ex-imgs">
              {ex[lab].length === 0 && <span className="xs muted">none</span>}
              {ex[lab].map((e) => (
                <button type="button" key={e.exemplar_id} className={`ex-tile ${big?.exemplar_id === e.exemplar_id ? 'is-active' : ''}`}
                  onClick={() => setBig(big?.exemplar_id === e.exemplar_id ? null : e)} aria-label={`Enlarge ${lab} example from slide ${e.slide_id}, similarity ${e.similarity.toFixed(2)}`}>
                  <img src={e.image_url} alt="" loading="lazy" />
                  <span className="ex-sim num">sim {e.similarity.toFixed(2)}</span>
                  <span className="ex-slide mono" title={`slide ${e.slide_id}`}>{e.slide_id}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {tied && <p className="xs muted">Tumour and benign examples are about equally similar; they don’t favour either label.</p>}
      <p className="xs muted">“Benign” tiles can come from tumour slides (slide names start with tumor_); the label is the tile’s.</p>
    </div>
  )
}
