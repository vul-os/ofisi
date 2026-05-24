/**
 * CaptionsPanel.jsx — Live transcript side-panel consuming the MEET-TRANSCRIPT-01
 * SSE stream from vulos OS.
 *
 * Endpoint: `GET /api/meet/transcribe/stream/{room}` — Server-Sent Events.
 * Each event payload is JSON of the shape
 *   { ts: <unix-ms>, speakerId: string, speakerName: string, text: string,
 *     final?: boolean }
 *
 * Behaviour:
 *   • Subscribes via `EventSource` while the panel is open.
 *   • Auto-scrolls to the latest line unless the user has scrolled up
 *     (preserve "read position" — re-enable auto-scroll on jump-to-latest).
 *   • Renders speaker attribution with a stable per-speaker color hash.
 *   • Falls back to a placeholder when no captions have arrived yet.
 *   • Caps in-memory buffer to MAX_LINES so multi-hour calls don't OOM.
 *   • Tolerates server downtime: EventSource auto-reconnects; we show a
 *     subtle "Reconnecting…" banner while disconnected.
 *
 * Props:
 *   roomId    — the meet room id (passed through to the stream URL)
 *   open      — controlled visibility
 *   onClose   — fires when the user clicks the close button
 *   baseURL   — optional override (defaults to '' = same-origin via the
 *               configured cloud↔LAN endpoint failover)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Captions as CaptionsIcon } from 'lucide-react'
import DOMPurify from 'dompurify'

const MAX_LINES = 500
// `final` lines are kept; interim partials replace the previous interim from
// the same speaker so the panel doesn't flicker.

function speakerColor(speakerId) {
  // Stable hash → hue. Avoids generic Tailwind colors; emits HSL warm-spectrum.
  let h = 0
  for (let i = 0; i < speakerId.length; i++) {
    h = ((h << 5) - h + speakerId.charCodeAt(i)) | 0
  }
  const hue = Math.abs(h) % 360
  return `hsl(${hue}, 55%, 70%)`
}

function safeText(text) {
  if (typeof text !== 'string') return ''
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
}

function formatTime(ts) {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function CaptionsPanel({ roomId, open, onClose, baseURL = '' }) {
  const [lines, setLines] = useState([])
  // streamState: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  const [streamState, setStreamState] = useState('idle')
  const listRef = useRef(null)
  const autoScrollRef = useRef(true)

  useEffect(() => {
    if (!open || !roomId) {
      setStreamState('idle')
      return
    }
    if (typeof EventSource === 'undefined') {
      setStreamState('error')
      return
    }
    const url = `${baseURL}/api/meet/transcribe/stream/${encodeURIComponent(roomId)}`
    setStreamState('connecting')
    const es = new EventSource(url, { withCredentials: true })
    es.onopen = () => setStreamState('open')
    es.onerror = () => setStreamState('error')
    es.onmessage = (e) => {
      let payload
      try { payload = JSON.parse(e.data) } catch { return }
      if (!payload || typeof payload.text !== 'string') return
      const entry = {
        ts: Number(payload.ts) || Date.now(),
        speakerId: String(payload.speakerId || 'unknown'),
        speakerName: String(payload.speakerName || payload.speakerId || 'Speaker'),
        text: safeText(payload.text),
        final: payload.final !== false,
      }
      setLines((prev) => {
        let next
        if (!entry.final) {
          // Replace the last interim from this speaker, if any.
          const lastIdx = [...prev].reverse().findIndex(
            (l) => l.speakerId === entry.speakerId && !l.final,
          )
          if (lastIdx >= 0) {
            const realIdx = prev.length - 1 - lastIdx
            next = [...prev.slice(0, realIdx), entry, ...prev.slice(realIdx + 1)]
          } else {
            next = [...prev, entry]
          }
        } else {
          // Final: replace this speaker's trailing interim with the final.
          const lastIdx = [...prev].reverse().findIndex(
            (l) => l.speakerId === entry.speakerId && !l.final,
          )
          if (lastIdx >= 0) {
            const realIdx = prev.length - 1 - lastIdx
            next = [...prev.slice(0, realIdx), entry, ...prev.slice(realIdx + 1)]
          } else {
            next = [...prev, entry]
          }
        }
        if (next.length > MAX_LINES) next = next.slice(next.length - MAX_LINES)
        return next
      })
    }
    return () => {
      try { es.close() } catch { /* noop */ }
      setStreamState('closed')
    }
  }, [open, roomId, baseURL])

  // Auto-scroll to the latest line unless the user has scrolled up.
  useEffect(() => {
    if (!autoScrollRef.current) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    autoScrollRef.current = distFromBottom < 40
  }

  const jumpToLatest = () => {
    const el = listRef.current
    if (!el) return
    autoScrollRef.current = true
    el.scrollTop = el.scrollHeight
  }

  const speakerColors = useMemo(() => {
    const m = {}
    for (const l of lines) {
      if (!m[l.speakerId]) m[l.speakerId] = speakerColor(l.speakerId)
    }
    return m
  }, [lines])

  if (!open) return null

  return (
    <aside
      className="w-72 border-l border-paper/10 flex flex-col overflow-hidden bg-paper/[.02]"
      data-testid="captions-panel"
      aria-label="Live captions panel"
    >
      <header className="h-11 px-3 flex items-center gap-2 border-b border-paper/10 text-paper">
        <CaptionsIcon size={14} className="text-accent" />
        <span className="text-2xs uppercase tracking-eyebrow font-semibold text-paper/70">
          Live captions
        </span>
        {streamState === 'connecting' && (
          <span className="text-2xs text-paper/40 tracking-tightish">Connecting…</span>
        )}
        {streamState === 'error' && (
          <span className="text-2xs text-warning tracking-tightish">Reconnecting…</span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close captions"
          className="ml-auto inline-flex items-center justify-center w-6 h-6 rounded-sm text-paper/60 hover:text-paper hover:bg-paper/10"
        >
          <X size={14} />
        </button>
      </header>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-sm"
        data-testid="captions-list"
      >
        {lines.length === 0 && streamState !== 'error' && (
          <div className="text-paper/40 text-xs tracking-tightish italic py-4">
            Waiting for transcript…
          </div>
        )}
        {lines.length === 0 && streamState === 'error' && (
          <div className="text-warning text-xs tracking-tightish py-4">
            Transcript stream unavailable. Retrying in the background.
          </div>
        )}
        {lines.map((l, i) => (
          <div key={`${l.speakerId}:${l.ts}:${i}`} className="leading-snug">
            <div className="flex items-baseline gap-2">
              <span
                className="font-medium tracking-tightish"
                style={{ color: speakerColors[l.speakerId] }}
              >
                {l.speakerName}
              </span>
              <span className="text-[10px] text-paper/35 tracking-tightish">
                {formatTime(l.ts)}
              </span>
              {!l.final && (
                <span className="text-[10px] text-paper/35 italic">…</span>
              )}
            </div>
            <p
              className={[
                'text-paper/85 text-sm leading-snug tracking-tightish',
                !l.final ? 'opacity-70' : '',
              ].join(' ')}
            >
              {l.text}
            </p>
          </div>
        ))}
      </div>

      {!autoScrollRef.current && lines.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="m-2 inline-flex items-center justify-center h-7 px-3 rounded-md text-2xs tracking-tightish bg-accent text-white hover:bg-accent-hover"
        >
          Jump to latest
        </button>
      )}
    </aside>
  )
}
