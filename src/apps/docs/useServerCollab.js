/**
 * useServerCollab — React hook wiring the server-mediated collaboration session
 * (YServerCollabSession) into the Docs editor's Y.Doc.
 *
 * This is the CLOUD / account collaboration path: an ACL-gated server relay that
 * persists the document's Yjs updates authoritatively, so two editors on the
 * account path converge and stay saved even with ZERO p2p peers, and a late
 * joiner catches up from the server.
 *
 * ── p2p-vs-server decision (unchanged) ─────────────────────────────────────
 * The E2E p2p path (a `#vp2p=` invite fragment or "Collaborate via link") is
 * end-to-end encrypted and its updates must NEVER traverse the readable server,
 * so this hook is DISABLED whenever that session is active (`e2eActive`). In
 * every other case the server session runs; it is the fallback that keeps
 * collaboration working when no p2p peer is reachable.
 *
 * ── What the caller must do ────────────────────────────────────────────────
 * Nothing, per keystroke. The document IS the Y.Doc: local edits flow out of it
 * and remote updates flow into it, and y-prosemirror keeps the editor in step.
 * There is no onLocalText/onRemoteText contract any more — that text-diff
 * contract was the bug (it could not carry formatting, and its offsets did not
 * map to document positions).
 *
 * The caller passes the Y context and the document's authoritative ProseMirror
 * JSON (`seedJSON`, from models.File.Content) which is used ONLY to seed a
 * document the server has no Yjs state for — a brand-new doc, or an existing one
 * being upgraded from the legacy text-CRDT log (see yServerSession.js).
 *
 * `ready` goes true once the document is hydrated (bootstrapped and/or seeded).
 * The editor must not be editable before that: typing into an empty document
 * that is about to be hydrated would fork it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { YServerCollabSession } from '../../lib/crdt/yServerSession.js'

function getOrCreatePeerId() {
  try {
    let id = sessionStorage.getItem('vulos_peer_id')
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('vulos_peer_id', id) }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/**
 * @param {object} opts
 * @param {string} opts.fileId
 * @param {object} opts.ctx        { ydoc, shadow, schema } (createYContext)
 * @param {object} opts.seedJSON   authoritative PM JSON; null until the file loads
 * @param {boolean} [opts.enabled=true]
 * @param {boolean} [opts.e2eActive=false]
 */
export function useServerCollab({ fileId, ctx, seedJSON, enabled = true, e2eActive = false }) {
  const [active, setActive] = useState(false)
  const [live, setLive] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [degraded, setDegraded] = useState(false)
  const [ready, setReady] = useState(false)
  const [roster, setRoster] = useState([])
  const sessionRef = useRef(null)
  const liveTimerRef = useRef(null)
  // The seed is only read at join time; keep it in a ref so a later re-render
  // (autosave updating the file object) cannot re-run the join effect.
  const seedRef = useRef(seedJSON)
  seedRef.current = seedJSON

  const hasSeed = seedJSON != null

  useEffect(() => {
    if (!enabled || e2eActive || !fileId || !ctx) { setActive(false); return }
    // Wait for the document's authoritative content: joining before it is known
    // would seed an EMPTY document over a real one.
    if (!hasSeed) return
    if (typeof window === 'undefined') return

    let cancelled = false
    const session = new YServerCollabSession({ fileId, peerId: getOrCreatePeerId(), ctx })

    session.addEventListener('readonly', () => { if (!cancelled) setReadOnly(true) })
    session.addEventListener('presence', (ev) => {
      if (!cancelled) setRoster(ev.detail?.roster || [])
    })

    sessionRef.current = session
    setActive(true)

    session.join({ seedJSON: seedRef.current })
      .then((res) => {
        if (cancelled) return
        setDegraded(!!res.degraded)
        setReady(true)
      })
      .catch((err) => {
        // Never leave the editor locked out: a failed join degrades to local-only.
        console.warn('[y-collab] join failed (local-only):', err?.message)
        if (!cancelled) { setDegraded(true); setReady(true) }
      })

    liveTimerRef.current = setInterval(() => {
      if (!cancelled) setLive(!!session.live)
    }, 1000)

    return () => {
      cancelled = true
      if (liveTimerRef.current) { clearInterval(liveTimerRef.current); liveTimerRef.current = null }
      try { session.leave() } catch { /* ignore */ }
      sessionRef.current = null
      setActive(false)
      setLive(false)
      setReadOnly(false)
      setDegraded(false)
      setReady(false)
      setRoster([])
    }
  }, [fileId, enabled, e2eActive, ctx, hasSeed])

  const broadcastPresence = useCallback((presence) => {
    sessionRef.current?.setPresence?.(presence)
  }, [])

  return { active, live, readOnly, degraded, ready, roster, broadcastPresence, session: sessionRef }
}
