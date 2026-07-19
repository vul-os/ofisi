// fabricSignaling.js — real network signaling for cross-device WebRTC calls,
// with an in-browser BroadcastChannel same-origin optimisation.
//
// Strategy:
//   1. Detect whether a peering WebSocket URL is configured
//      (window.__VULOS_ENDPOINTS__.signalingUrl or VITE_SIGNALING_URL env var,
//      or derived from window.location).
//   2. If yes → open a SignalingClient and adapt its EventTarget API to
//      the lightweight on/off/emit surface that rtc.js expects.
//   3. If not (standalone dev loop, no host) → fall back to BroadcastChannel
//      so in-browser same-origin multi-tab negotiation still works.
//
// Signaling envelope (call layer, used by rtc.js):
//   { kind: 'sdp'|'ice'|'screen-share'|..., to?: peerId,
//     from: peerId, data: {...} }
//
// On the real WebSocket path SignalingClient wraps those as:
//   { channel: "signal", from: peerId,
//     payload: { type: kind, session, to, data } }

import { SignalingClient } from '../signaling.js'
import { SignalingError } from '../errors.js'
import { Emitter } from './emitter.js'
import { fetchIce, resolveStunFallback } from './ice.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

function _newPeerId(identity) {
  return identity?.peerId || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()))
}

/**
 * Resolve a peering WebSocket URL from the environment.
 *
 * Resolution order:
 *   1. window.__VULOS_ENDPOINTS__.signalingUrl  (runtime injection by OS shell)
 *   2. VITE_SIGNALING_URL                       (build-time env var)
 *   3. Derived from window.location             (wss://<host>/api/peering/stream)
 *      — skipped in Node / test environments where window.location is absent.
 *
 * Returns null when no host can be determined (unit tests, SSR, pure offline).
 * @returns {string|null}
 */
function _resolveSignalingUrl() {
  try {
    const injected = typeof window !== 'undefined' && window.__VULOS_ENDPOINTS__
    if (injected && injected.signalingUrl) return injected.signalingUrl

    const envUrl =
      (typeof import.meta !== 'undefined' &&
        import.meta.env &&
        import.meta.env.VITE_SIGNALING_URL) ||
      ''
    if (envUrl) return envUrl

    // Derive from the page origin — works when the SDK is loaded from the OS
    // shell and the host serves /api/peering/stream on the same origin.
    if (typeof window !== 'undefined' && window.location && window.location.hostname) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${proto}//${window.location.host}/api/peering/stream`
    }
  } catch { /* non-browser environment */ }
  return null
}

// ─── Real network signaling session (cross-device) ───────────────────────────

/**
 * Wrap a SignalingClient into the lightweight on/off/emit session surface that
 * rtc.js (Call) and other callers expect.
 *
 * The session object is symmetric with the BroadcastChannel stub:
 *   { peerId, identity, transport, state,
 *     send(msg), on(ev,cb), off(ev,cb), close() }
 *
 * Events emitted:
 *   'peer-join'  (peerId, identity)
 *   'peer-leave' (peerId)
 *   'message'    (msg)    — sdp / ice / screen-share / etc.
 *   'state'      (string) — 'connecting'|'connected'|'reconnecting'|'closed'
 *
 * @param {string} sessionId
 * @param {object|null} identity
 * @param {string} signalingUrl
 * @returns {Promise<object>} session
 */
async function networkSession(sessionId, identity, signalingUrl) {
  const em = new Emitter()
  const peerId = _newPeerId(identity)
  const peers = new Set()
  let state = 'connecting'

  const setState = (s) => { state = s; em.emit('state', s) }

  // ── Per-session ECDSA P-256 signing key ─────────────────────────────────────
  // Generate a non-extractable private key for signing outgoing signaling frames.
  // The corresponding public key is published in the 'join' frame (depositPubKey)
  // and embedded in every offer/answer frame (pubKey), enabling peers to perform
  // TOFU import and verify subsequent frames, achieving:
  //
  //   • PEER IDENTITY BINDING — including `from` in the canonical message means
  //     a server that stamps the wrong `from` breaks verification.
  //   • DTLS FINGERPRINT PINNING — including `sdp` in the canonical message pins
  //     the DTLS fingerprint so a MITM cannot replace the SDP after signing.
  //
  // Falls back to unsigned signaling when WebCrypto is unavailable (non-secure
  // context, very old browser).  Peers with requirePeerAuth=false (the default
  // for the call path) will still accept unsigned frames.
  let _sessionKeyPair = null
  let _sessionPubKeyB64 = null
  try {
    _sessionKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,          // private key non-extractable
      ['sign', 'verify'],
    )
    const rawPub = await crypto.subtle.exportKey('raw', _sessionKeyPair.publicKey)
    _sessionPubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(rawPub)))
  } catch (err) {
    // WebCrypto unavailable — outgoing frames will be unsigned.
    // Peers whose keys are already stored will drop our frames; peers with
    // requirePeerAuth=false (including all call-path sessions) will accept them.
    console.warn('[fabricSignaling] WebCrypto unavailable; frames will be unsigned:', err.message)
  }

  const sc = new SignalingClient({
    signalingUrl,
    sessionId,
    peerId,
    authToken: identity?.authToken || null,
    // Publish the per-session signing public key in the 'join' frame so peers
    // can TOFU-import it and verify subsequent offer/answer/ice frames from us.
    getDepositPubKey: () => _sessionPubKeyB64,
    // Sign every outgoing offer/answer/ice frame.  Including the SDP in the
    // canonical message (for sdp-kind frames) pins the DTLS fingerprint.
    signFrame: _sessionKeyPair
      ? async (msg) => {
          const sigBuf = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            _sessionKeyPair.privateKey,
            new TextEncoder().encode(msg),
          )
          return btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
        }
      : null,
    // requirePeerAuth=false: the call layer accepts unsigned frames from peers
    // that have not yet adopted the signed protocol.  Peers whose keys ARE
    // stored are always verified regardless of this flag.
    requirePeerAuth: false,
  })

  // Bridge SignalingClient EventTarget events to the Emitter interface.
  sc.addEventListener('signaling-open', () => {
    setState('connected')
    // Announce ourselves so peers already in the session learn about us.
    sc.signal('join', null, { identity })
  })

  sc.addEventListener('signaling-close', () => {
    setState('reconnecting')
  })

  sc.addEventListener('signal', (ev) => {
    const { from, payload } = ev.detail
    if (!payload) return

    // Peer lifecycle signals.
    if (payload.type === 'join') {
      if (!peers.has(from)) {
        peers.add(from)
        em.emit('peer-join', from, payload.identity || null)
      }
      return
    }
    if (payload.type === 'leave') {
      if (peers.delete(from)) em.emit('peer-leave', from)
      return
    }

    // Media / data payloads: translate back to the call-layer envelope so
    // PeerConn.handleSignal() in rtc.js receives a consistent shape.
    const msg = {
      kind: payload.type,    // 'sdp', 'ice', 'screen-share', etc.
      from,
      to: payload.to || null,
      data: payload.data || {},
      identity: payload.identity || null,
    }
    em.emit('message', msg)
  })

  sc.connect()

  return {
    peerId,
    identity,
    transport: 'ws',
    get state() { return state },

    /**
     * Send a signaling message to a specific peer (or broadcast when to is
     * omitted). The call layer passes { kind, to?, data, identity? }.
     *
     * When the per-session signing key is available, sdp and candidate fields
     * are mirrored to the SignalingClient payload top level so _canonical() can
     * include them in the signed message.  This pins the DTLS fingerprint for
     * sdp-kind frames and binds ICE candidates to the per-session identity.
     * The nested `data` object is preserved unchanged for the receiving call layer.
     *
     * @param {{ kind: string, to?: string, data?: object, identity?: object }} msg
     */
    send(msg) {
      const extra = { data: msg.data, identity: msg.identity }
      if (_sessionPubKeyB64) {
        // Publish our pubkey in every frame so late-joining peers can TOFU-import
        // it from the first offer/answer they receive (handles out-of-order delivery).
        extra.pubKey = _sessionPubKeyB64
        // Mirror payload fields so the signed canonical message covers them.
        if (msg.data?.sdp)       extra.sdp       = msg.data.sdp
        if (msg.data?.candidate) extra.candidate  = msg.data.candidate
      }
      sc.signal(msg.kind, msg.to || null, extra)
    },

    on: em.on.bind(em),
    off: em.off.bind(em),

    close() {
      sc.close()
      setState('closed')
    },
  }
}

// ─── BroadcastChannel fallback (same-origin multi-tab, no network) ───────────

/**
 * Same-origin BroadcastChannel signaling stub for dev loops, Storybook, unit
 * tests, and any context where no peering WebSocket is reachable.
 *
 * transport === 'bc-stub' so callers can detect the mode and warn.
 * @param {string} sessionId
 * @param {object|null} identity
 * @returns {object} session
 */
function bcSession(sessionId, identity) {
  const em = new Emitter()
  const peerId = _newPeerId(identity)
  const ch = new BroadcastChannel(`vulos-call:${sessionId}`)
  const peers = new Set()
  let state = 'connecting'

  const setState = (s) => { state = s; em.emit('state', s) }

  ch.onmessage = (ev) => {
    const m = ev.data
    if (!m || m.from === peerId) return
    if (m.kind === 'hello') {
      if (!peers.has(m.from)) { peers.add(m.from); em.emit('peer-join', m.from, m.identity) }
      // Reply so the new peer learns about us.
      ch.postMessage({ kind: 'hello-ack', from: peerId, identity, to: m.from })
      return
    }
    if (m.kind === 'hello-ack' && m.to === peerId) {
      if (!peers.has(m.from)) { peers.add(m.from); em.emit('peer-join', m.from, m.identity) }
      return
    }
    if (m.kind === 'bye') {
      if (peers.delete(m.from)) em.emit('peer-leave', m.from)
      return
    }
    if (m.to && m.to !== peerId) return
    em.emit('message', m)
  }

  // Announce after the current microtask — identical timing to the WS path.
  setTimeout(() => {
    ch.postMessage({ kind: 'hello', from: peerId, identity })
    setState('local') // BroadcastChannel stub — no network transport
  }, 0)

  return {
    peerId,
    identity,
    transport: 'bc-stub',
    get state() { return state },
    send(msg) { ch.postMessage({ ...msg, from: peerId }) },
    on: em.on.bind(em),
    off: em.off.bind(em),
    close() {
      try { ch.postMessage({ kind: 'bye', from: peerId }) } catch {}
      try { ch.close() } catch {}
      setState('closed')
    },
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Join a call signaling session.
 *
 * Prefers the real WebSocket peering path (transport: 'ws') for cross-device
 * calls. Falls back to the BroadcastChannel stub (transport: 'bc-stub') only
 * when no signaling URL can be resolved — i.e. the SDK is running in a
 * standalone dev loop, a unit test, or a fully offline context where the OS
 * shell has not injected window.__VULOS_ENDPOINTS__.signalingUrl and
 * VITE_SIGNALING_URL is not set.
 *
 * Note: window.location-based derivation means that in normal browser
 * deployments (the OS shell served from the same origin as the peering backend)
 * the real network path is used automatically, without any explicit
 * configuration.
 *
 * @param {string} sessionId
 * @param {object|null} identity  — may carry .peerId and/or .authToken
 * @returns {Promise<object>} session
 *   { peerId: string, transport: 'ws'|'bc-stub', state: string,
 *     send(msg), on(ev,cb), off(ev,cb), close() }
 */
export async function joinSignalingSession(sessionId, identity) {
  const signalingUrl = _resolveSignalingUrl()
  if (signalingUrl) {
    return networkSession(sessionId, identity, signalingUrl)
  }
  // No network host available — same-origin tab stub only.
  if (typeof BroadcastChannel !== 'undefined') {
    return bcSession(sessionId, identity)
  }
  // Neither available (SSR / Node without polyfill).
  throw new SignalingError(
    '[fabricSignaling] No signaling transport available. ' +
    'Set window.__VULOS_ENDPOINTS__.signalingUrl or VITE_SIGNALING_URL, ' +
    'or ensure the SDK runs in a browser context.',
    { code: 'NO_TRANSPORT' },
  )
}

// Fetch TURN/STUN credentials from the cloud (OFFICE-20 path). Server endpoint
// mirrors what the OS fabric uses. The fallback is host-provided ICE only (no
// third-party reach-out) unless the operator opts into a public STUN server —
// see resolveStunFallback() in ice.js.
export function fetchIceServers() {
  return fetchIce('/api/turn/credentials', {
    responseKey: 'iceServers',
    fetchOptions: { credentials: 'include' },
    fallbackIceServers: resolveStunFallback(),
  })
}
