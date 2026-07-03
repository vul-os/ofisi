/**
 * useCollabFabric.test.jsx — WAVE-27 fabric lifecycle hook.
 *
 * Verifies the presence-roster-adjacent projection: peers joining/leaving flow
 * into the `peers` map, join success flips `joined`, and a join rejection
 * degrades gracefully (no throw, configured→false) so solo editing survives.
 *
 * The real FabricClient opens WebSockets/WebRTC; we mock the module with a tiny
 * in-process EventTarget so the hook logic is exercised without the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ── Mock the relay-client fabric with a controllable fake ─────────────────────
let lastFabric = null
let joinBehaviour = 'resolve' // 'resolve' | 'reject'

class FakeFabric extends EventTarget {
  constructor(opts) {
    super()
    this.opts = opts
    this.left = false
    lastFabric = this
  }
  async join() {
    if (joinBehaviour === 'reject') throw new Error('no peering backend')
  }
  leave() { this.left = true }
  send() {}
  sendTo() {}
  // Test helper: simulate the fabric emitting a peer state change.
  emitState(peerId, state) {
    this.dispatchEvent(new CustomEvent('state', { detail: { peerId, state } }))
  }
}

vi.mock('@vulos/relay-client/fabric', () => ({
  FabricClient: class {
    constructor(opts) { return new FakeFabric(opts) }
  },
}))

// Import AFTER the mock is registered.
const { useCollabFabric } = await import('../useCollabFabric.js')

beforeEach(() => {
  lastFabric = null
  joinBehaviour = 'resolve'
})

describe('useCollabFabric', () => {
  it('creates + joins a fabric and marks configured/joined', async () => {
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'file-1', peerId: 'rep-1' }),
    )
    // Fabric created synchronously in the effect.
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    expect(result.current.configured).toBe(true)
    await waitFor(() => expect(result.current.joined).toBe(true))
    // Signaling URL derives from origin, mirroring DocsCollabSession.
    expect(lastFabric.opts.sessionId).toBe('file-1')
    expect(lastFabric.opts.peerId).toBe('rep-1')
    expect(lastFabric.opts.signalingUrl).toMatch(/\/api\/peering\/stream$/)
  })

  it('projects peers joining and leaving into the peers map', async () => {
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    await waitFor(() => expect(result.current.fabric).not.toBeNull())

    act(() => { lastFabric.emitState('peerA', 'connected') })
    await waitFor(() => expect(result.current.peers.peerA).toBe('connected'))

    act(() => { lastFabric.emitState('peerB', 'relay') })
    await waitFor(() => expect(result.current.peers.peerB).toBe('relay'))

    // Peer drops: state transitions to disconnected (out).
    act(() => { lastFabric.emitState('peerA', 'disconnected') })
    await waitFor(() => expect(result.current.peers.peerA).toBe('disconnected'))
    expect(result.current.peers.peerB).toBe('relay')
  })

  it('degrades gracefully when join rejects (single-user / no backend)', async () => {
    joinBehaviour = 'reject'
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    // join() rejected → joined stays false, configured collapses to false.
    await waitFor(() => expect(result.current.configured).toBe(false))
    expect(result.current.joined).toBe(false)
    // No throw escaped — the hook still returned a value; editor keeps working.
  })

  it('does not create a fabric when disabled', async () => {
    const { result } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me', enabled: false }),
    )
    // Give effects a tick.
    await Promise.resolve()
    expect(result.current.fabric).toBeNull()
    expect(result.current.configured).toBe(false)
    expect(lastFabric).toBeNull()
  })

  it('leaves the fabric on unmount', async () => {
    const { result, unmount } = renderHook(() =>
      useCollabFabric({ sessionId: 'f', peerId: 'me' }),
    )
    await waitFor(() => expect(result.current.fabric).not.toBeNull())
    const fab = lastFabric
    unmount()
    expect(fab.left).toBe(true)
  })
})
