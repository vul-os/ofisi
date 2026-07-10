/**
 * useServerCollab — React hook wiring the WAVE37 server-mediated collaboration
 * session (ServerCollabSession) into a TipTap-backed editor.
 *
 * This is the CLOUD / account collaboration path: an ACL-gated server relay that
 * persists CRDT ops authoritatively, so two editors on the account path converge
 * and the doc stays saved even with ZERO p2p peers, and a late joiner catches up
 * from the server. It is ADDITIVE and orthogonal to both:
 *   • the cloud DocsCollabSession (p2p fabric, plaintext) and
 *   • the E2E P2PCollabSession (invite-link, encrypted).
 *
 * ── p2p-vs-server decision ──────────────────────────────────────────────────
 * The E2E p2p path (opened by a `#vp2p=` invite fragment or "Collaborate via
 * link") is E2E-ENCRYPTED and its ops must NEVER traverse the readable server.
 * So this hook is DISABLED whenever the E2E p2p session is active (`e2eActive`).
 * In every other case — the normal account path — the server session runs, and
 * it is precisely the fallback that keeps collaboration working when the p2p
 * fabric can't reach a relay/peer (its degrade-to-local-only gap). The two are
 * complementary: local edits fan out to BOTH the fabric DocsCollabSession and
 * this server session; because TextCRDT.apply is idempotent/commutative, ops
 * arriving from either transport converge with no double-apply.
 *
 * Graceful: if the server route is absent/unreachable (self-host without the
 * endpoint, offline), join()'s bootstrap fails soft and the editor keeps working
 * locally (autosave still persists via the doc service).
 *
 * Returns { active, live, readOnly, onLocalText } where onLocalText(prev, next)
 * must be called from the editor's onUpdate, and remote converged text is pushed
 * via the onRemoteText callback the caller supplies.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ServerCollabSession } from '../../lib/crdt/serverSession.js'

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
 * @param {(text: string) => void} opts.onRemoteText  apply converged text to editor
 * @param {boolean} [opts.enabled=true]   master switch (e.g. off in single-user)
 * @param {boolean} [opts.e2eActive=false] true when the E2E p2p session is live —
 *                                          the server path is suppressed so
 *                                          encrypted ops never hit the server.
 */
export function useServerCollab({ fileId, onRemoteText, enabled = true, e2eActive = false }) {
  const [active, setActive] = useState(false)
  const [live, setLive] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  // Server-mediated presence roster (accountId → identity + cursor). This makes
  // "who is here" + live cursors work on the CLOUD path — i.e. even when the p2p
  // fabric can't reach a relay/peer, so presence is no longer p2p-only.
  const [roster, setRoster] = useState([])
  const sessionRef = useRef(null)
  const onRemoteTextRef = useRef(onRemoteText)
  onRemoteTextRef.current = onRemoteText
  const liveTimerRef = useRef(null)

  useEffect(() => {
    // Suppress the server path while the E2E p2p session is active — its ops are
    // encrypted and must not be routed through the readable server.
    if (!enabled || e2eActive || !fileId) {
      setActive(false)
      return
    }
    if (typeof window === 'undefined') return

    let cancelled = false
    const peerId = getOrCreatePeerId()
    const session = new ServerCollabSession({ fileId, peerId })

    session.addEventListener('change', (ev) => {
      if (ev.detail?.remote) onRemoteTextRef.current?.(ev.detail.text)
    })
    session.addEventListener('readonly', () => { if (!cancelled) setReadOnly(true) })
    session.addEventListener('presence', (ev) => {
      if (!cancelled) setRoster(ev.detail?.roster || [])
    })

    sessionRef.current = session
    setActive(true)

    session.join().catch((err) => {
      // Bootstrap/stream unavailable — non-fatal, editor stays local (autosave).
      console.warn('[server-collab] join failed (local-only):', err?.message)
    })

    // Poll the session's live flag (SSE open/close) so the UI can reflect it.
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
      setRoster([])
    }
  }, [fileId, enabled, e2eActive])

  // Push a local editor text change into the server CRDT session.
  const onLocalText = useCallback((prevText, nextText) => {
    const s = sessionRef.current
    if (!s) return []
    return s.applyLocal(prevText, nextText)
  }, [])

  // Announce the local cursor/selection + identity to the other viewers over the
  // server path. Debounced inside the session. No-op when the session is absent.
  const broadcastPresence = useCallback((presence) => {
    sessionRef.current?.setPresence?.(presence)
  }, [])

  return { active, live, readOnly, roster, onLocalText, broadcastPresence, session: sessionRef }
}
