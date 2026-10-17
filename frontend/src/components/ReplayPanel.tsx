import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { RecordedRead, ReplayStep } from '../types'

interface Props {
  caseId: string
  onStep: (s: ReplayStep) => void
  onStart: () => void
  onStop: () => void
}

export default function ReplayPanel({ caseId, onStep, onStart, onStop }: Props) {
  const [reads, setReads] = useState<RecordedRead[]>([])
  const [sel, setSel] = useState<string>('')
  const [mode, setMode] = useState<'gaze' | 'viewport'>('gaze')
  const [replayId, setReplayId] = useState<string | null>(null)
  const [step, setStep] = useState<ReplayStep | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(25)
  const [err, setErr] = useState<string | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    setReads([]); setSel(''); setReplayId(null); setStep(null); setPlaying(false); setErr(null)
    api.recordedReads(caseId).then((r) => { setReads(r); if (r[0]) setSel(r[0].read_id) }).catch((e) => setErr(String(e.message)))
  }, [caseId])

  useEffect(() => {
    if (!playing || !replayId) return
    const t = window.setInterval(async () => {
      if (busy.current) return
      busy.current = true
      try {
        const s = await api.replayStep(replayId, speed)
        setStep(s); onStep(s)
        if (s.done) setPlaying(false)
      } catch (e) { setErr((e as Error).message); setPlaying(false) } finally { busy.current = false }
    }, 350)
    return () => window.clearInterval(t)
  }, [playing, replayId, speed, onStep])

  const start = async () => {
    setErr(null)
    try {
      const r = await api.replayStart(sel, mode)
      setReplayId(r.replay_read_id); setStep(null); onStart(); setPlaying(true)
    } catch (e) { setErr((e as Error).message) }
  }

  const randomMiss = () => {
    const benign = reads.filter((r) => r.decision.toLowerCase() === 'benign')
    if (!benign.length) { setErr('no benign recorded reads on this slide'); return }
    setSel(benign[Math.floor(Math.random() * benign.length)].read_id)
  }

  const cur = reads.find((r) => r.read_id === sel)
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Replay a recorded read</h3>
        <span className="muted small">PathoGaze eye-tracking, through the live coverage engine</span>
      </div>
      {err && <div className="notice warn">{err}</div>}
      {reads.length === 0 && !err && <p className="small muted">No recorded reads for this slide.</p>}
      {reads.length > 0 && (
        <>
          <div className="replay-controls">
            <select value={sel} onChange={(e) => setSel(e.target.value)} disabled={playing}>
              {reads.map((r) => (
                <option key={r.read_id} value={r.read_id}>
                  {r.reader_id.replace('pathogaze_', '')} · {r.experience_level ? (/^[<\d]/.test(r.experience_level) ? `${r.experience_level} yrs` : r.experience_level) : '?'} · called {r.decision} · {Math.round(r.seconds)}s
                </option>
              ))}
            </select>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'gaze' | 'viewport')} disabled={playing}>
              <option value="gaze">gaze (fixations)</option>
              <option value="viewport">viewport only</option>
            </select>
          </div>
          <div className="btn-row">
            <button className="btn small" onClick={randomMiss} disabled={playing}>Pick a random benign call</button>
            {!playing && <button className="btn primary small" onClick={start} disabled={!sel}>▶ Replay</button>}
            {playing && <button className="btn small" onClick={() => setPlaying(false)}>❚❚ Pause</button>}
            {!playing && replayId && step && !step.done && <button className="btn small" onClick={() => setPlaying(true)}>Resume</button>}
            {replayId && <button className="btn small" onClick={() => { setPlaying(false); setReplayId(null); setStep(null); onStop() }}>Exit replay</button>}
            <label className="small">speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                <option value={5}>slow</option><option value={25}>normal</option><option value={100}>fast</option>
              </select>
            </label>
          </div>
          {cur && <p className="small muted">The reader called this slide <b>{cur.decision}</b>. The sign-out check runs on that call when the replay ends.</p>}
          {step && (
            <div className="replay-progress">
              <div className="cov-track"><div className="cov-fill replay" style={{ width: `${(step.cursor / step.n_events) * 100}%` }} /></div>
              <span className="small">{step.cursor}/{step.n_events} events · {((step.t_ms ?? 0) / 1000).toFixed(0)} s · {Math.round(step.coverage.seen_share * 100)}% tissue seen</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}
