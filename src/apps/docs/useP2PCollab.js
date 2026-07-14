/**
 * useP2PCollab — React hook wiring the secure P2P collab session into a
 * TipTap-backed editor (WAVE-25).
 *
 * Two entry points:
 *   • JOIN: the current URL carries a `#vp2p=…` invite fragment → join that room
 *     (rw or ro per the invite's capability). This is what opening a shared link
 *     does.
 *   • SHARE: the user clicks "Collaborate via link" → create() a fresh room and
 *     surface rw/ro links (see startShare()).
 *
 * This is ADDITIVE and orthogonal to the existing cloud/account collab session
 * (DocsCollabSession in DocsEditor.jsx). When there is no invite fragment and no
 * active share, this hook is inert and the cloud path is unaffected.
 *
 * The hook returns:
 *   { active, cap, readOnly, roomId, peers, links, peeringUnavailable,
 *     startShare, rotate, leave, onLocalText }
 * where onLocalText(prev, next) must be called from the editor's onUpdate (it is
 * a no-op for ro peers) and remote text changes are pushed via the onRemoteText
 * callback the caller supplies.
 *
 * HONESTY GUARD: a standalone Office binary never mounts `/api/peering/*`
 * (see main.go). Both entry points probe that BEFORE touching the fabric:
 *   • JOIN: if unreachable, we never attempt the session — instead of a silent
 *     no-op (the previous behaviour: a console.warn nobody sees, the visitor
 *     left wondering why nothing happened), `peeringUnavailable` flips true so
 *     the caller can show a clear message.
 *   • SHARE: if unreachable, startShare() rejects BEFORE minting a session, so
 *     the share modal never sits in an infinite "Preparing room…" spinner —
 *     callers should render `peeringUnavailable` as an explicit unavailable
 *     state instead (see P2PShareModal's `unavailable` prop).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { P2PCollabSession } from '../../lib/crdt/p2pSession.js'
import { probePeeringAvailable } from '../../lib/collab/peeringAvailability.js'
import { resolveReachableBase } from '../../lib/collab/reachableBase.js'

/** True when the current location carries a P2P invite fragment. */
export function hasInviteInLocation() {
  if (typeof window === 'undefined') return false
  return /(?:^|[#&?])vp2p=/.test(window.location.hash || '')
}

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
 * @param {boolean} [opts.autoJoinFromLink=true]
 * @param {boolean} [opts.enabled=true]  master switch. When false the hook is
 *   fully inert: no invite is joined, no room can be minted, no op is ever sent
 *   or applied. `collabDisabled` is returned so the caller can say so honestly
 *   instead of rendering a share affordance that silently does nothing.
 */
export function useP2PCollab({ fileId, onRemoteText, autoJoinFromLink = true, enabled = true }) {
  const [active, setActive] = useState(false)
  const [cap, setCap] = useState(null)          // 'rw' | 'ro'
  const [roomId, setRoomId] = useState(null)
  const [peers, setPeers] = useState({})        // peerId → state
  const [links, setLinks] = useState(null)      // { rwLink, roLink } when sharing
  // true once we've established the peering fabric (/api/peering/*) is NOT
  // reachable on this origin — i.e. a standalone Office binary. Callers should
  // surface this explicitly (toast / modal banner) rather than fail silently.
  const [peeringUnavailable, setPeeringUnavailable] = useState(false)
  const sessionRef = useRef(null)
  const onRemoteTextRef = useRef(onRemoteText)
  onRemoteTextRef.current = onRemoteText

  const wireSession = useCallback((session) => {
    session.addEventListener('change', (ev) => {
      if (ev.detail?.remote) onRemoteTextRef.current?.(ev.detail.text)
    })
    session.addEventListener('state', (ev) => {
      const { peerId, state } = ev.detail
      setPeers((prev) => ({ ...prev, [peerId]: state }))
    })
  }, [])

  const teardown = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.leave() } catch { /* ignore */ }
      sessionRef.current = null
    }
    setActive(false)
    setCap(null)
    setRoomId(null)
    setPeers({})
    setLinks(null)
  }, [])

  // ── auto-join when the URL carries an invite fragment ──────────────────────
  useEffect(() => {
    if (!enabled) return          // co-editing disabled → never touch the fabric
    if (!autoJoinFromLink) return
    if (!hasInviteInLocation()) return
    let cancelled = false
    const peerId = getOrCreatePeerId()
    const inviteLink = window.location.href

    ;(async () => {
      // Probe BEFORE touching the fabric: a standalone server never mounts
      // /api/peering/*, so a session here would silently never connect anyone
      // (see the HONESTY GUARD note above). Surface that explicitly instead of
      // just a console.warn nobody sees.
      const available = await probePeeringAvailable()
      if (cancelled) return
      if (!available) {
        console.warn('[p2p] invite link opened, but this server does not serve the ' +
          'peering fabric (/api/peering/*) — a standalone Office binary cannot make a ' +
          'P2P connection. Staying in local/cloud mode.')
        setPeeringUnavailable(true)
        return
      }
      try {
        const session = await P2PCollabSession.fromInvite({ inviteLink, peerId, fileId })
        if (cancelled) { session.leave(); return }
        wireSession(session)
        sessionRef.current = session
        setCap(session.cap)
        setRoomId(session.roomId)
        setActive(true)
        await session.join()
      } catch (err) {
        // A malformed/tampered invite fails closed — we simply don't enter P2P
        // mode (the editor stays in normal local/cloud mode).
        console.warn('[p2p] join from link failed:', err?.message)
        if (!cancelled) teardown()
      }
    })()

    return () => { cancelled = true }
  }, [enabled, autoJoinFromLink, fileId, wireSession, teardown])

  // ── SHARE: mint a fresh room and expose rw/ro links ────────────────────────
  const startShare = useCallback(async () => {
    // Co-editing disabled for this deployment: refuse to mint a room rather than
    // hand the user links that would look real and never sync anything.
    if (!enabled) throw new Error('collab-disabled')

    // Probe BEFORE minting a room: on a standalone server the room's invite
    // links would look real but never connect anyone (no peering fabric to
    // rendezvous over). Reject up front so the caller's share modal can render
    // an explicit "unavailable" state instead of an infinite spinner waiting
    // for `links` that will never arrive.
    const available = await probePeeringAvailable()
    if (!available) {
      setPeeringUnavailable(true)
      throw new Error('peering-unavailable')
    }
    setPeeringUnavailable(false)

    // If we're already in a room (joined via link as rw), reuse it — but the
    // simple, predictable behaviour is: sharing always (re)creates a room the
    // local user OWNS as rw. If a session already exists, tear it down first.
    if (sessionRef.current) {
      try { sessionRef.current.leave() } catch { /* ignore */ }
      sessionRef.current = null
    }
    const peerId = getOrCreatePeerId()
    // NAT reachability: build the invite base from Office's externally-reachable
    // origin (VULOS_OFFICE_PUBLIC_URL via /api/reachability) so a link handed to
    // an EXTERNAL peer targets a URL they can actually reach — not a LAN-only
    // address the owner happened to load Office over. Falls back to
    // window.location.origin when no public URL is configured (unchanged).
    const reachable = await resolveReachableBase()
    const pathname = typeof window !== 'undefined' && window.location
      ? window.location.pathname
      : '/'
    const originBase = reachable || (typeof window !== 'undefined' ? window.location.origin : '')
    const baseUrl = originBase ? `${originBase}${pathname}` : undefined
    const { session, rwLink, roLink, roomId: rid } = await P2PCollabSession.create({
      peerId, fileId, baseUrl,
    })
    wireSession(session)
    sessionRef.current = session
    setCap('rw')
    setRoomId(rid)
    setLinks({ rwLink, roLink })
    setActive(true)
    await session.join()
    return { rwLink, roLink, roomId: rid }
  }, [enabled, fileId, wireSession])

  // Rotate the room key (revoke old links) by minting a brand-new room.
  const rotate = useCallback(async () => {
    return startShare()
  }, [startShare])

  // Push a local editor text change into the P2P CRDT (no-op for ro peers, and
  // no-op entirely when co-editing is disabled — nothing may leave this tab).
  const onLocalText = useCallback((prevText, nextText) => {
    if (!enabled) return []
    const s = sessionRef.current
    if (!s) return []
    return s.applyLocal(prevText, nextText)
  }, [enabled])

  // Cleanup on unmount.
  useEffect(() => () => teardown(), [teardown])

  const readOnly = cap === 'ro'
  const peerCount = Object.values(peers).filter((s) => s === 'connected' || s === 'relay').length

  return {
    active, cap, readOnly, roomId, peers, peerCount, links, peeringUnavailable,
    // True when live co-editing is disabled for this build (VITE_DOCS_COLLAB=off).
    // Callers MUST surface this rather than showing an inert share affordance.
    collabDisabled: !enabled,
    // True when someone opened an invite link but co-editing is disabled — the
    // link cannot connect them and we owe them an explicit message.
    inviteIgnored: !enabled && hasInviteInLocation(),
    startShare, rotate, leave: teardown, onLocalText,
    session: sessionRef,
  }
}
