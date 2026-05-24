/**
 * livekit.test.jsx — MEET-SPACES-01 coverage.
 *
 * Tests the route-selection logic, the livekitClient lifecycle wrapper
 * (with a mock Room constructor — never touches the real SDK), and the
 * LiveKitCallView mount + overflow behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

import {
  selectCallRoute,
  DEFAULT_MESH_THRESHOLD,
  readLiveKitFlag,
  createLiveKitRoom,
  fetchMeetToken,
} from '../../lib/call/livekitClient.js'

// ────────────────────────────────────────────────────────────────────────────
// 1. Route selection
// ────────────────────────────────────────────────────────────────────────────
describe('selectCallRoute', () => {
  it('1.1 ≤5 participants → mesh even when livekit enabled', () => {
    const r = selectCallRoute({ expectedParticipants: 5, livekitEnabled: true })
    expect(r.useLiveKit).toBe(false)
    expect(r.reason).toMatch(/small-room/)
  })

  it('1.2 >5 participants + livekit flag on → LiveKit', () => {
    const r = selectCallRoute({ expectedParticipants: 6, livekitEnabled: true })
    expect(r.useLiveKit).toBe(true)
    expect(r.reason).toMatch(/large-room/)
  })

  it('1.3 >5 participants but flag off → mesh', () => {
    const r = selectCallRoute({ expectedParticipants: 50, livekitEnabled: false })
    expect(r.useLiveKit).toBe(false)
    expect(r.reason).toMatch(/livekit-disabled-flag/)
  })

  it('1.4 forceMode=mesh wins even with 100 participants + flag on', () => {
    const r = selectCallRoute({
      expectedParticipants: 100, livekitEnabled: true, forceMode: 'mesh',
    })
    expect(r.useLiveKit).toBe(false)
    expect(r.reason).toBe('forced-mesh')
  })

  it('1.5 forceMode=livekit ignored when flag is off', () => {
    const r = selectCallRoute({
      expectedParticipants: 100, livekitEnabled: false, forceMode: 'livekit',
    })
    expect(r.useLiveKit).toBe(false)
    expect(r.reason).toMatch(/livekit-forced-but-disabled/)
  })

  it('1.6 custom threshold respected', () => {
    const r = selectCallRoute({
      expectedParticipants: 11, livekitEnabled: true, meshThreshold: 10,
    })
    expect(r.useLiveKit).toBe(true)
  })

  it('1.7 default mesh threshold is 5', () => {
    expect(DEFAULT_MESH_THRESHOLD).toBe(5)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. readLiveKitFlag — env / window
// ────────────────────────────────────────────────────────────────────────────
describe('readLiveKitFlag', () => {
  beforeEach(() => { delete window.__VULOS_MEET_LIVEKIT })
  afterEach(() => { delete window.__VULOS_MEET_LIVEKIT })

  it('2.1 returns false by default', () => {
    expect(readLiveKitFlag()).toBe(false)
  })
  it('2.2 returns true when window flag set', () => {
    window.__VULOS_MEET_LIVEKIT = true
    expect(readLiveKitFlag()).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. livekitClient lifecycle — mock Room
// ────────────────────────────────────────────────────────────────────────────

class MockLocalParticipant {
  constructor() {
    this.identity = 'u_self'
    this.calls = []
    this.published = []
  }
  async setMicrophoneEnabled(v) { this.calls.push(['mic', v]); return true }
  async setCameraEnabled(v)     { this.calls.push(['cam', v]); return true }
  async setScreenShareEnabled(v){ this.calls.push(['screen', v]); return true }
  async publishData(bytes)      { this.published.push(bytes); return true }
}

class MockRoom {
  constructor() {
    this._handlers = {}
    this.localParticipant = new MockLocalParticipant()
    this.remoteParticipants = new Map()
    this.connected = false
    this.disconnected = false
  }
  on(name, fn) { this._handlers[name] = (this._handlers[name] || []).concat(fn) }
  off(name, fn) { this._handlers[name] = (this._handlers[name] || []).filter((f) => f !== fn) }
  emit(name, ...args) { (this._handlers[name] || []).forEach((fn) => fn(...args)) }
  async connect(url, token) {
    this.connectedURL = url
    this.token = token
    this.connected = true
  }
  disconnect() { this.disconnected = true }
}

describe('createLiveKitRoom (mocked SDK)', () => {
  it('3.1 calls fetchToken with the room id + connects to returned URL', async () => {
    const room = new MockRoom()
    const fetchToken = vi.fn().mockResolvedValue({
      token: 'tok.sig', url: 'wss://meet.example/room', room_id: 'acme:standup',
    })
    const handle = await createLiveKitRoom({
      roomId: 'acme:standup',
      identity: { displayName: 'Alice' },
      video: true,
      RoomCtor: function () { return room },
      fetchToken,
    })
    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(fetchToken.mock.calls[0][0].roomId).toBe('acme:standup')
    expect(room.connectedURL).toBe('wss://meet.example/room')
    expect(room.token).toBe('tok.sig')
    expect(handle.state).toBe('connected')
    handle.leave()
    expect(room.disconnected).toBe(true)
  })

  it('3.2 throws when no roomId', async () => {
    await expect(createLiveKitRoom({})).rejects.toThrow(/roomId required/)
  })

  it('3.3 toggleMute flips local state + calls SDK', async () => {
    const room = new MockRoom()
    const fetchToken = vi.fn().mockResolvedValue({ token: 't', url: 'wss://x' })
    const handle = await createLiveKitRoom({
      roomId: 'acme:r', RoomCtor: () => room, fetchToken,
    })
    const next = await handle.toggleMute()
    expect(next).toBe(true)
    expect(room.localParticipant.calls.some(([k, v]) => k === 'mic' && v === false)).toBe(true)
    handle.leave()
  })

  it('3.4 raiseHand publishes a data message', async () => {
    const room = new MockRoom()
    const fetchToken = vi.fn().mockResolvedValue({ token: 't', url: 'wss://x' })
    const handle = await createLiveKitRoom({
      roomId: 'acme:r', RoomCtor: () => room, fetchToken,
    })
    await handle.raiseHand(true)
    expect(room.localParticipant.published.length).toBe(1)
    const decoded = JSON.parse(new TextDecoder().decode(room.localParticipant.published[0]))
    expect(decoded).toEqual({ type: 'raise-hand', raised: true })
    handle.leave()
  })

  it('3.5 leave() sets state to closed', async () => {
    const room = new MockRoom()
    const fetchToken = vi.fn().mockResolvedValue({ token: 't', url: 'wss://x' })
    const handle = await createLiveKitRoom({
      roomId: 'acme:r', RoomCtor: () => room, fetchToken,
    })
    handle.leave()
    expect(handle.state).toBe('closed')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 4. fetchMeetToken — POST shape
// ────────────────────────────────────────────────────────────────────────────
describe('fetchMeetToken', () => {
  it('4.1 POSTs the room_id and reads token+url back', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'jwt', url: 'wss://meet/x', room_id: 'acme:r' }),
    })
    const out = await fetchMeetToken({ roomId: 'acme:r', displayName: 'Alice' })
    expect(out.token).toBe('jwt')
    expect(out.url).toBe('wss://meet/x')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/meet/token',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.room_id).toBe('acme:r')
    expect(body.display_name).toBe('Alice')
  })

  it('4.2 rejects when response missing token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ url: 'wss://x' }),
    })
    await expect(fetchMeetToken({ roomId: 'acme:r' })).rejects.toThrow(/missing token/)
  })

  it('4.3 rejects on non-2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'forbidden',
    })
    await expect(fetchMeetToken({ roomId: 'acme:r' })).rejects.toThrow(/403/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 5. LiveKitCallView — mounts, shows overflow tile past 25
// ────────────────────────────────────────────────────────────────────────────
describe('LiveKitCallView', () => {
  it('5.1 renders speaker grid + leave button after connect', async () => {
    const LiveKitCallView = (await import('./components/LiveKitCallView.jsx')).default
    const handle = makeMockHandle({ participantCount: 8 })
    const createRoom = vi.fn().mockResolvedValue(handle)

    render(
      <LiveKitCallView
        sessionId="acme:standup"
        identity={{ displayName: 'Alice' }}
        onLeave={() => {}}
        createRoom={createRoom}
      />
    )
    await waitFor(() => expect(createRoom).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('livekit-speaker-grid')).toBeTruthy())
    expect(screen.getByText('Leave')).toBeTruthy()
  })

  it('5.2 caps visible tiles + shows "+N more" overflow', async () => {
    const LiveKitCallView = (await import('./components/LiveKitCallView.jsx')).default
    const handle = makeMockHandle({ participantCount: 40 })
    const createRoom = vi.fn().mockResolvedValue(handle)

    render(
      <LiveKitCallView
        sessionId="acme:big"
        identity={{ displayName: 'Alice' }}
        onLeave={() => {}}
        createRoom={createRoom}
      />
    )
    await waitFor(() => expect(screen.getByTestId('livekit-overflow-tile')).toBeTruthy())
    // 24 remote tiles visible (25 cap minus self)
    const tiles = screen.queryAllByTestId('livekit-participant-tile')
    expect(tiles.length).toBe(24)
    // Overflow = 40 - 24 = 16
    expect(screen.getByTestId('livekit-overflow-tile').textContent).toMatch(/\+16 more/)
  })

  it('5.3 organizer sees recording toggle', async () => {
    const LiveKitCallView = (await import('./components/LiveKitCallView.jsx')).default
    const handle = makeMockHandle({ participantCount: 3 })
    const createRoom = vi.fn().mockResolvedValue(handle)

    render(
      <LiveKitCallView
        sessionId="acme:r"
        identity={{ displayName: 'Alice' }}
        isOrganizer
        onLeave={() => {}}
        createRoom={createRoom}
      />
    )
    await waitFor(() => expect(screen.getByTestId('livekit-recording-toggle')).toBeTruthy())
  })

  it('5.4 non-organizer does NOT see recording toggle', async () => {
    const LiveKitCallView = (await import('./components/LiveKitCallView.jsx')).default
    const handle = makeMockHandle({ participantCount: 3 })
    const createRoom = vi.fn().mockResolvedValue(handle)

    render(
      <LiveKitCallView
        sessionId="acme:r"
        identity={{ displayName: 'Alice' }}
        isOrganizer={false}
        onLeave={() => {}}
        createRoom={createRoom}
      />
    )
    await waitFor(() => expect(screen.getByTestId('livekit-speaker-grid')).toBeTruthy())
    expect(screen.queryByTestId('livekit-recording-toggle')).toBeNull()
  })
})

function makeMockHandle({ participantCount = 0 } = {}) {
  const listeners = {}
  const participants = []
  for (let i = 0; i < participantCount; i++) {
    participants.push({
      peerId: `peer-${i}`,
      identity: { displayName: `P${i}` },
      isSpeaking: false,
      audioTracks: new Map(),
      videoTracks: new Map(),
    })
  }
  return {
    state: 'connected',
    muted: false,
    cameraOff: false,
    participants,
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) },
    off: () => {},
    emit: (ev, ...a) => (listeners[ev] || []).forEach((f) => f(...a)),
    toggleMute: vi.fn().mockResolvedValue(true),
    toggleCamera: vi.fn().mockResolvedValue(true),
    raiseHand: vi.fn().mockResolvedValue(undefined),
    sendDataMessage: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn(),
  }
}
