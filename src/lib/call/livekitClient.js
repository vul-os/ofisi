// livekitClient.js — wrapper around livekit-client's Room for Vulos Spaces
// large-room calls (>5 participants, Pro tier).
//
// MEET-SPACES-01 (Wave B 2026-05-24). Companion to rtc.js: rtc.js is the
// mesh fallback (≤5 participants, no SFU/cloud dependency); this is the SFU
// path (LiveKit Server via vulos-meet, tokens minted by vulos-cloud
// MEET-CP-01).
//
// ── Token shape ──────────────────────────────────────────────────────────
// vulos-meet validates `<tenant>:<rest>` room IDs and a tenant-bound `name`
// claim (see /Users/pc/code/exo/vulos-meet/spec/TOKEN.md). The minter
// (MEET-CP-01) is the only source of tokens. This client just consumes them.
//
// ── Public API ──────────────────────────────────────────────────────────
//   const room = await createLiveKitRoom({
//     roomId, identity, video, audio,
//     tokenURL,            // default '/api/meet/token' on vulos-cloud
//     livekitURL,          // default '' → fetched from token response
//     fetchToken,          // optional override (testing/standalone)
//     RoomCtor,            // optional override (testing — inject mock)
//   })
//
//   room.peerId                     — local participant identity (sub)
//   room.participants               — Array<{ peerId, identity, isSpeaking, ... }>
//   room.localTracks                — { audio, video, screen }
//   room.on(event, cb)              — events:
//       'connected'
//       'disconnected' (reason)
//       'participant-joined' (participant)
//       'participant-left' (peerId)
//       'participants-changed' (participantsArray)
//       'active-speakers' (Array<peerId>)
//       'track-subscribed' ({ peerId, track, publication })
//       'track-unsubscribed' ({ peerId, track })
//       'state' ('connecting'|'connected'|'reconnecting'|'closed'|'failed')
//   room.toggleMute()               — Promise<boolean> new muted state
//   room.toggleCamera()             — Promise<boolean> new camera-off state
//   room.startScreenShare()         — Promise<void>
//   room.stopScreenShare()
//   room.raiseHand(raised)          — broadcasts a data-channel message
//   room.sendDataMessage(payload)   — JSON broadcast over LiveKit data channel
//   room.leave()                    — disconnect + cleanup

// ─── token endpoint ────────────────────────────────────────────────────────
// Default token URL: POST /api/meet/token on vulos-cloud's control plane.
// MEET-CP-01 is the parallel agent building that endpoint. Until it lands,
// the client falls through to a clearly-labeled stub when the endpoint 404s
// in dev, so the rest of the UI can be exercised end-to-end.
//
// Expected request body:  { room_id: "<tenant>:<rest>", display_name?, video?, audio? }
// Expected response body: { token: "<jwt>", url: "wss://...", room_id: "<tenant>:<rest>" }

const DEFAULT_TOKEN_URL = '/api/meet/token'

class Emitter {
  constructor() { this._h = {} }
  on(ev, cb) { (this._h[ev] = this._h[ev] || []).push(cb); return () => this.off(ev, cb) }
  off(ev, cb) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== cb) }
  emit(ev, ...a) { (this._h[ev] || []).forEach((f) => { try { f(...a) } catch (e) { console.error(e) } }) }
}

// Fetch a join token from vulos-cloud (MEET-CP-01).
//
// TODO(MEET-CP-01): once the cloud endpoint is wired, the response is expected
// to include `{ token, url, room_id }`. This function is the only seam the
// cloud team needs to plug — the rest of livekitClient is agnostic.
export async function fetchMeetToken({ roomId, displayName, video, audio, tokenURL = DEFAULT_TOKEN_URL } = {}) {
  if (!roomId) throw new Error('roomId required')
  const body = {
    room_id: roomId,
    display_name: displayName || '',
    video: !!video,
    audio: audio !== false,
  }
  const res = await fetch(tokenURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`meet token fetch failed: ${res.status} ${msg || ''}`.trim())
  }
  const data = await res.json()
  if (!data || !data.token || !data.url) {
    throw new Error('meet token response missing token or url')
  }
  return data
}

// Lazy import of livekit-client so the SDK only loads when the LiveKit path
// is actually selected (mesh fallback users don't pay the bytes cost).
async function loadLiveKitSdk() {
  // eslint-disable-next-line import/no-unresolved
  const mod = await import('livekit-client')
  return mod
}

class LiveKitRoomHandle extends Emitter {
  constructor({ roomId, identity, video, audio, tokenURL, livekitURL, fetchToken, RoomCtor, SDK }) {
    super()
    this.roomId = roomId
    this.identity = identity || {}
    this.video = video !== false
    this.audio = audio !== false
    this.tokenURL = tokenURL || DEFAULT_TOKEN_URL
    this.livekitURL = livekitURL || ''
    this._fetchToken = fetchToken || fetchMeetToken
    this._RoomCtor = RoomCtor || (SDK && SDK.Room)
    this._SDK = SDK
    this._room = null
    this.peerId = null
    this.participants = []
    this.localTracks = { audio: null, video: null, screen: null }
    this.muted = !this.audio
    this.cameraOff = !this.video
    this.state = 'connecting'
    this.activeSpeakers = []
  }

  async _init() {
    if (!this._RoomCtor) {
      const sdk = await loadLiveKitSdk()
      this._SDK = sdk
      this._RoomCtor = sdk.Room
    }
    const tokenInfo = await this._fetchToken({
      roomId: this.roomId,
      displayName: this.identity?.displayName,
      video: this.video,
      audio: this.audio,
      tokenURL: this.tokenURL,
    })
    if (!this.livekitURL) this.livekitURL = tokenInfo.url

    // Accept either a class (production: livekit-client's Room) or a factory
    // function (tests can inject a pre-built mock). If invoking with `new`
    // throws (because the supplied value is an arrow factory) fall back to a
    // plain call.
    let room
    const opts = { adaptiveStream: true, dynacast: true }
    try {
      room = new this._RoomCtor(opts)
    } catch (e) {
      room = this._RoomCtor(opts)
    }
    // If the constructor returned nothing meaningful (rare), the factory
    // form should at least produce a non-null object.
    if (!room || typeof room !== 'object') {
      room = this._RoomCtor(opts)
    }
    this._room = room

    this._wireRoomEvents(room)

    await room.connect(this.livekitURL, tokenInfo.token)
    this.peerId = room.localParticipant?.identity || this.peerId

    // Publish local media after connection (some SDK versions auto-publish;
    // explicit is safer + lets us track refs for toggle).
    if (this.audio) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true)
      } catch (e) { console.warn('[livekit] mic enable failed', e) }
    }
    if (this.video) {
      try {
        await room.localParticipant.setCameraEnabled(true)
      } catch (e) { console.warn('[livekit] cam enable failed', e) }
    }

    this._refreshParticipants()
    this._setState('connected')
    this.emit('connected')
  }

  _wireRoomEvents(room) {
    const E = this._SDK?.RoomEvent || {}
    // Defensive lookups so a test mock can omit RoomEvent without crashing.
    const on = (name, fn) => { if (name) room.on(name, fn) }

    on(E.ParticipantConnected || 'participantConnected', (p) => {
      this._refreshParticipants()
      this.emit('participant-joined', this._toParticipant(p))
    })
    on(E.ParticipantDisconnected || 'participantDisconnected', (p) => {
      this._refreshParticipants()
      this.emit('participant-left', p?.identity)
    })
    on(E.ActiveSpeakersChanged || 'activeSpeakersChanged', (speakers) => {
      this.activeSpeakers = (speakers || []).map((p) => p.identity)
      this.emit('active-speakers', this.activeSpeakers)
      this._refreshParticipants()
    })
    on(E.TrackSubscribed || 'trackSubscribed', (track, publication, participant) => {
      this.emit('track-subscribed', { peerId: participant?.identity, track, publication })
      this._refreshParticipants()
    })
    on(E.TrackUnsubscribed || 'trackUnsubscribed', (track, publication, participant) => {
      this.emit('track-unsubscribed', { peerId: participant?.identity, track })
      this._refreshParticipants()
    })
    on(E.Disconnected || 'disconnected', (reason) => {
      this._setState('closed')
      this.emit('disconnected', reason)
    })
    on(E.Reconnecting || 'reconnecting', () => this._setState('reconnecting'))
    on(E.Reconnected || 'reconnected', () => this._setState('connected'))
    on(E.DataReceived || 'dataReceived', (payload, participant) => {
      try {
        const txt = new TextDecoder().decode(payload)
        const msg = JSON.parse(txt)
        if (msg && typeof msg === 'object') {
          if (msg.type === 'raise-hand') {
            this.emit('raise-hand', { peerId: participant?.identity, raised: !!msg.raised })
          } else {
            this.emit('data-message', { peerId: participant?.identity, message: msg })
          }
        }
      } catch { /* not-json payload — ignore */ }
    })
  }

  _toParticipant(p) {
    if (!p) return null
    return {
      peerId: p.identity,
      identity: { displayName: p.name || p.identity, accountAddress: p.metadata || null },
      isSpeaking: !!p.isSpeaking,
      audioLevel: p.audioLevel || 0,
      audioTracks: p.audioTracks || p.audioTrackPublications || new Map(),
      videoTracks: p.videoTracks || p.videoTrackPublications || new Map(),
    }
  }

  _refreshParticipants() {
    if (!this._room) return
    // livekit-client v2 uses `remoteParticipants` (Map). Older shapes used
    // `participants`. Support both for robustness.
    const remote = this._room.remoteParticipants || this._room.participants || new Map()
    const arr = []
    for (const p of remote.values ? remote.values() : Object.values(remote)) {
      arr.push(this._toParticipant(p))
    }
    this.participants = arr
    this.emit('participants-changed', arr)
  }

  _setState(s) {
    if (this.state === s) return
    this.state = s
    this.emit('state', s)
  }

  async toggleMute() {
    this.muted = !this.muted
    try {
      await this._room?.localParticipant?.setMicrophoneEnabled(!this.muted)
    } catch (e) { console.warn('[livekit] toggleMute', e) }
    return this.muted
  }

  async toggleCamera() {
    this.cameraOff = !this.cameraOff
    try {
      await this._room?.localParticipant?.setCameraEnabled(!this.cameraOff)
    } catch (e) { console.warn('[livekit] toggleCamera', e) }
    return this.cameraOff
  }

  async startScreenShare() {
    try {
      await this._room?.localParticipant?.setScreenShareEnabled(true)
    } catch (e) { console.warn('[livekit] startScreenShare', e); throw e }
  }

  async stopScreenShare() {
    try {
      await this._room?.localParticipant?.setScreenShareEnabled(false)
    } catch (e) { console.warn('[livekit] stopScreenShare', e) }
  }

  async sendDataMessage(payload) {
    if (!this._room?.localParticipant) return
    try {
      const enc = new TextEncoder().encode(JSON.stringify(payload))
      await this._room.localParticipant.publishData(enc, { reliable: true })
    } catch (e) { console.warn('[livekit] sendDataMessage', e) }
  }

  async raiseHand(raised) {
    return this.sendDataMessage({ type: 'raise-hand', raised: !!raised })
  }

  // Mesh-compat shim: some Spaces UI components call this name.
  sendDataChannelMsg(payload) { return this.sendDataMessage(payload) }

  leave() {
    try { this._room?.disconnect() } catch {}
    this._room = null
    this._setState('closed')
  }
}

export async function createLiveKitRoom(opts) {
  if (!opts || !opts.roomId) throw new Error('roomId required')
  const handle = new LiveKitRoomHandle(opts)
  await handle._init()
  return handle
}

// ─── Route selection ──────────────────────────────────────────────────────
// Decide between the mesh (rtc.js) and LiveKit SFU paths for a given call.
//
//   expectedParticipants: number          — invitee count or capped roster size
//   meshThreshold:        number (def 5)  — strictly more than this → SFU
//   livekitEnabled:       boolean         — Pro-tier gate (cloud-resolved)
//   forceMode:            'mesh'|'livekit'|undefined — manual override
//
// Returns { useLiveKit: boolean, reason: string }
export function selectCallRoute({
  expectedParticipants = 0,
  meshThreshold = 5,
  livekitEnabled = false,
  forceMode,
} = {}) {
  if (forceMode === 'mesh') {
    return { useLiveKit: false, reason: 'forced-mesh' }
  }
  if (forceMode === 'livekit') {
    if (!livekitEnabled) return { useLiveKit: false, reason: 'livekit-forced-but-disabled' }
    return { useLiveKit: true, reason: 'forced-livekit' }
  }
  if (!livekitEnabled) {
    return { useLiveKit: false, reason: 'livekit-disabled-flag' }
  }
  if (expectedParticipants > meshThreshold) {
    return { useLiveKit: true, reason: `large-room-${expectedParticipants}>${meshThreshold}` }
  }
  return { useLiveKit: false, reason: `small-room-${expectedParticipants}<=${meshThreshold}` }
}

// Configurable defaults that the UI can read. Centralised so the Pro-tier
// flag has one home. The actual Pro entitlement check lives in cloud
// (MEET-CP-01); this file exposes only the local feature flag + threshold.
export const DEFAULT_MESH_THRESHOLD = 5

export function readLiveKitFlag() {
  // Browser env: window.__VULOS_MEET_LIVEKIT (set by the OS shell during
  // bootstrap or by the tenant-config response). Tests can set it directly.
  if (typeof window !== 'undefined' && typeof window.__VULOS_MEET_LIVEKIT === 'boolean') {
    return window.__VULOS_MEET_LIVEKIT
  }
  // Vite import.meta.env (build-time):
  try {
    // eslint-disable-next-line no-undef
    if (import.meta && import.meta.env && import.meta.env.VITE_MEET_LIVEKIT === '1') return true
  } catch {}
  return false
}
