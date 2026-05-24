/**
 * RecordingIndicator.jsx — visible REC badge + remaining-quota countdown.
 *
 * Polls `GET /api/meet/recordings/{id}` while a recording is in progress to
 * pick up:
 *   • `status` ∈ 'starting' | 'recording' | 'stopped' | 'failed'
 *   • `quotaMinutesRemaining` — the workspace's recording quota minutes left
 *     (returned by the cloud, refreshes each tick)
 *   • `elapsedSeconds` — how long the active recording has been running
 *
 * The poll is gentle (every 10s) so we never hammer the cloud. If the endpoint
 * 404s (no recording with that id) we shut down quietly.
 *
 * Display:
 *   • Filled red dot + pulsing animation + "REC HH:MM:SS"
 *   • When quotaMinutesRemaining is known and < 60min, shows "(N min left)"
 *     in warning color so the host can stop before they run out
 *
 * Props:
 *   recordingId — backend id from POST /api/meet/recordings (or null)
 *   baseURL     — same-origin '' by default
 *   onStopped   — fires when the server reports status='stopped' or 'failed'
 */
import { useEffect, useRef, useState } from 'react'
import { Circle } from 'lucide-react'

const POLL_MS = 10_000

function formatHMS(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00'
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

export default function RecordingIndicator({ recordingId, baseURL = '', onStopped }) {
  const [status, setStatus] = useState('starting')
  const [elapsed, setElapsed] = useState(0)
  const [quotaMin, setQuotaMin] = useState(null)
  const startedAtRef = useRef(Date.now())
  const tickRef = useRef(null)

  useEffect(() => {
    if (!recordingId) return undefined
    startedAtRef.current = Date.now()
    setStatus('starting')
    setElapsed(0)

    let cancelled = false

    async function poll() {
      try {
        const r = await fetch(
          `${baseURL}/api/meet/recordings/${encodeURIComponent(recordingId)}`,
          { credentials: 'include' },
        )
        if (cancelled) return
        if (r.status === 404) {
          setStatus('stopped')
          onStopped?.()
          return
        }
        if (!r.ok) return
        const j = await r.json().catch(() => null)
        if (!j || cancelled) return
        const newStatus = String(j.status || 'recording')
        setStatus(newStatus)
        if (typeof j.elapsedSeconds === 'number') setElapsed(j.elapsedSeconds)
        if (typeof j.quotaMinutesRemaining === 'number') {
          setQuotaMin(j.quotaMinutesRemaining)
        }
        if (newStatus === 'stopped' || newStatus === 'failed') {
          onStopped?.()
        }
      } catch {
        /* network hiccup — keep showing the badge using local tick */
      }
    }

    // local 1Hz tick so elapsed advances between polls
    tickRef.current = setInterval(() => {
      if (cancelled) return
      setElapsed((e) => e + 1)
    }, 1000)

    poll()
    const pollHandle = setInterval(poll, POLL_MS)

    return () => {
      cancelled = true
      clearInterval(pollHandle)
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [recordingId, baseURL, onStopped])

  if (!recordingId) return null
  if (status === 'stopped' || status === 'failed') return null

  const quotaLow = typeof quotaMin === 'number' && quotaMin < 60
  const quotaCritical = typeof quotaMin === 'number' && quotaMin < 10

  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-2xs font-medium tracking-tightish border',
        quotaCritical
          ? 'bg-danger/25 text-danger border-danger/40'
          : 'bg-danger/15 text-danger border-danger/30',
      ].join(' ')}
      aria-live="polite"
      data-testid="recording-indicator"
      title={
        typeof quotaMin === 'number'
          ? `Recording — ${quotaMin} quota minute(s) remaining`
          : 'Recording'
      }
    >
      <Circle
        size={9}
        fill="currentColor"
        className="animate-pulse"
        aria-hidden
      />
      <span>REC</span>
      <span className="font-mono text-[11px]">{formatHMS(elapsed)}</span>
      {typeof quotaMin === 'number' && (
        <span
          className={[
            'ml-1 text-[10px] uppercase tracking-eyebrow',
            quotaLow ? 'text-warning' : 'text-paper/60',
          ].join(' ')}
          data-testid="recording-quota"
        >
          {quotaMin} min left
        </span>
      )}
    </span>
  )
}
