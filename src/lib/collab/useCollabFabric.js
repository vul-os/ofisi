/**
 * src/lib/collab/useCollabFabric.js — shared FabricClient lifecycle hook
 * (WAVE-27).
 *
 * Docs gets live presence because DocsCollabSession owns and joins a
 * FabricClient, then exposes it (`.fabric`) to useLiveCursors + usePresence.
 * Sheets (GridSession) and Slides (TreeSession) already accept a
 * `fabricClient`, but the editors passed `null`, so they had CRDT logic but no
 * transport — hence `fabric: null` into useLiveCursors and an empty roster.
 *
 * This hook centralises that lifecycle so Sheets and Slides light up presence
 * the same way Docs does, WITHOUT reinventing transport:
 *
 *   1. Create a FabricClient (same defaults as DocsCollabSession — origin-derived
 *      signaling URL, /api/peering/ice, same-origin relay).
 *   2. join() it; track joined/peer-state so the status pill can reflect Live /
 *      Reconnecting / Offline.
 *   3. Hand the SAME fabric to the caller so it can (a) wire it into the CRDT
 *      session for op sync and (b) feed useLiveCursors + usePresence.
 *
 * Fails graceful: if join() rejects (no peering backend configured, offline,
 * single-user), the editor keeps working locally — we simply surface an
 * `offline` status and an empty roster. No throws escape the hook.
 *
 * ADDITIVE & sync-safe: this hook does NOT change how ops are diffed/applied.
 * It only provisions the transport the existing CRDT session was already
 * designed to consume. When the peering backend is absent, behaviour is
 * identical to the previous `fabricClient: null` path (local-only).
 *
 * HONESTY GUARD: a standalone Office binary never mounts `/api/peering/*`
 * (see main.go), but FabricClient.join() resolves anyway — it fire-and-forgets
 * the signaling WebSocket connect and its ICE fetch silently falls back on a
 * 404. Without a check, `configured`/`joined` would flip true regardless, and
 * the Sheets/Slides status pill (deriveStatusPill in presenceCommon.js) would
 * settle on a false-positive "Live" for a session nobody can ever join. So we
 * probe the fabric's reachability BEFORE constructing a FabricClient at all;
 * when it is unreachable we never construct one, and `configured` stays
 * `false` — an honest, calm "Offline" — for the life of the mount.
 */

import { useEffect, useRef, useState } from 'react'
import { FabricClient } from '@vulos/relay-client/fabric'
import { probePeeringAvailable } from './peeringAvailability.js'

/**
 * @param {object} opts
 * @param {string}  opts.sessionId  - file id (fabric session key)
 * @param {string}  opts.peerId     - stable per-tab id (CRDT replicaId)
 * @param {boolean} [opts.enabled=true] - set false to stay fully local (no fabric)
 * @returns {{
 *   fabric: import('@vulos/relay-client/fabric').FabricClient | null,
 *   peers: Record<string, string>,
 *   joined: boolean,
 *   configured: boolean,
 * }}
 */
export function useCollabFabric({ sessionId, peerId, enabled = true }) {
  const [fabric, setFabric] = useState(null)
  const [peers, setPeers] = useState({})       // peerId → state
  const [joined, setJoined] = useState(false)
  const [configured, setConfigured] = useState(false)
  const fabricRef = useRef(null)

  useEffect(() => {
    if (!enabled || !sessionId || !peerId) return
    if (typeof window === 'undefined') return

    let cancelled = false
    let client = null
    let onState = null

    const wsBase = window.location.origin.replace(/^http/, 'ws') + '/api/peering/stream'

    ;(async () => {
      // Probe reachability BEFORE constructing a transport — see the HONESTY
      // GUARD note above. On a standalone server this resolves false and we
      // never touch FabricClient at all: configured/joined stay false, giving
      // an honest, calm "Offline" pill instead of a false "Live".
      const available = await probePeeringAvailable()
      if (cancelled) return
      if (!available) {
        console.info('[collab] peering fabric not reachable on this origin ' +
          '(standalone server, or offline) — presence/live-sync unavailable; editor stays local-only')
        return
      }

      try {
        client = new FabricClient({
          sessionId,
          peerId,
          signalingUrl: wsBase,
          iceUrl: '/api/peering/ice',
          relayBaseUrl: '',
          authToken: null,
        })
      } catch (err) {
        // FabricClient construction should not throw, but never let it break the
        // editor — degrade to local-only.
        console.warn('[collab] fabric init failed (local-only mode):', err?.message)
        return
      }
      if (cancelled) { try { client.leave() } catch { /* ignore */ }; return }

      fabricRef.current = client
      setFabric(client)
      setConfigured(true)

      onState = (ev) => {
        if (cancelled) return
        const { peerId: pid, state } = ev.detail || {}
        if (!pid) return
        setPeers((prev) => ({ ...prev, [pid]: state }))
      }
      client.addEventListener('state', onState)

      client.join()
        .then(() => { if (!cancelled) setJoined(true) })
        .catch((err) => {
          // No peering backend / offline / single-user — this is expected and
          // non-fatal. Presence stays empty; the editor is unaffected.
          console.warn('[collab] fabric join failed (single-user mode):', err?.message)
          if (!cancelled) { setJoined(false); setConfigured(false) }
        })
    })()

    return () => {
      cancelled = true
      if (client) {
        if (onState) client.removeEventListener('state', onState)
        try { client.leave() } catch { /* ignore */ }
      }
      fabricRef.current = null
      setFabric(null)
      setPeers({})
      setJoined(false)
      setConfigured(false)
    }
  }, [sessionId, peerId, enabled])

  return { fabric, peers, joined, configured }
}
