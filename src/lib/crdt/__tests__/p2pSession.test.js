import { describe, it, expect, beforeEach, vi } from 'vitest'
import { P2PCollabSession } from '../p2pSession.js'
import { generateInvite } from '../p2pRoom.js'

// ---------------------------------------------------------------------------
// FakeFabric — an in-process, content-blind bus modelling the FabricClient API
// (join/send/sendTo/leave + 'message'/'state' events). It carries opaque frames
// between peers exactly like the real relay/WebRTC transport, but never inspects
// them — which is the whole point: the transport is content-blind.
// ---------------------------------------------------------------------------

class FakeBus {
  constructor() { this.nodes = new Set() }
  register(node) { this.nodes.add(node) }
  unregister(node) { this.nodes.delete(node) }
  broadcast(from, frame) {
    for (const n of this.nodes) {
      if (n.peerId !== from && n.online) n.deliver(from, frame)
    }
  }
  unicast(from, to, frame) {
    for (const n of this.nodes) {
      if (n.peerId === to && n.online) n.deliver(from, frame)
    }
  }
}

class FakeFabric extends EventTarget {
  constructor(bus, peerId) {
    super()
    this.bus = bus
    this.peerId = peerId
    this.online = false
    this.sent = []          // record of frames we broadcast (for assertions)
  }
  async join() {
    this.online = true
    this.bus.register(this)
    // Announce presence so peers know we exist (mirrors 'state' connected).
    for (const n of this.bus.nodes) {
      if (n !== this) {
        this.dispatchEvent(new CustomEvent('state', { detail: { peerId: n.peerId, state: 'connected' } }))
      }
    }
  }
  send(frame) { this.sent.push(frame); if (this.online) this.bus.broadcast(this.peerId, frame) }
  sendTo(peerId, frame) { if (this.online) this.bus.unicast(this.peerId, peerId, frame) }
  leave() { this.online = false; this.bus.unregister(this) }
  deliver(from, frame) {
    this.dispatchEvent(new CustomEvent('message', { detail: { from, data: frame } }))
  }
}

// Silence the snapshot-flush localStorage path in jsdom-less runs.
beforeEach(() => {
  vi.useRealTimers()
})

async function mkSession({ inviteLink, peerId, bus, fileId }) {
  const fabric = new FakeFabric(bus, peerId)
  return P2PCollabSession.fromInvite({ inviteLink, peerId, fileId, fabric })
}

// Every applyLocal() fans out into async, fire-and-forget seal→send→open→apply
// pipelines (real WebCrypto AEAD per op frame). A fixed setTimeout is a race: it
// passes in isolation but under full-suite PARALLEL load the CPU is saturated
// and the crypto microtasks miss a short fixed window → the peer reads stale
// text and the assertion flakes. So instead of guessing a delay we poll until
// the ACTUAL settle condition holds (or a generous ceiling elapses), which is
// deterministic regardless of scheduling pressure.

// Yield once so already-queued microtasks (and any pending 0ms timers) flush.
const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * Wait until `predicate()` returns truthy, polling across macrotasks. Resolves
 * as soon as the condition is met (fast in isolation, robust under load). If it
 * never holds within `timeoutMs` we stop waiting and let the assertion that
 * follows report the real value — we never hang the suite.
 */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let ok = false
    try { ok = !!predicate() } catch { ok = false }
    if (ok) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

// Back-compat "settle" for the few negative/no-op assertions that have no
// positive convergence condition to await: flush pending work deterministically
// by draining the timer/microtask queue a few times rather than sleeping once.
const settle = async () => { for (let i = 0; i < 4; i++) await tick() }

describe('two P2P sessions converge over a fake transport', () => {
  it('rw + rw peers converge on the same text', async () => {
    const bus = new FakeBus()
    const { link } = await generateInvite({ cap: 'rw' })

    const a = await mkSession({ inviteLink: link, peerId: 'A', bus, fileId: 'docA' })
    const b = await mkSession({ inviteLink: link, peerId: 'B', bus, fileId: 'docB' })
    await a.join()
    await b.join()

    a.applyLocal('', 'Hello')
    await waitFor(() => b.getText() === 'Hello')
    b.applyLocal('Hello', 'Hello World')
    await waitFor(() => a.getText() === 'Hello World' && a.getText() === b.getText())

    expect(a.getText()).toBe(b.getText())
    expect(a.getText()).toBe('Hello World')

    a.leave(); b.leave()
  })

  it('sealed frames are opaque on the wire (relay/uninvited peer cannot read)', async () => {
    const bus = new FakeBus()
    const { link } = await generateInvite({ cap: 'rw' })
    const a = await mkSession({ inviteLink: link, peerId: 'A', bus, fileId: 'd' })
    await a.join()
    a.applyLocal('', 'topsecret')
    // 'topsecret' → 9 op frames once every seal resolves and hits the wire.
    await waitFor(() => a.fabric.sent.length >= 9)
    // The transport recorded the raw frames — none may contain the plaintext.
    expect(a.fabric.sent.length).toBeGreaterThan(0)
    for (const frame of a.fabric.sent) {
      expect(frame).not.toContain('topsecret')
    }
  })
})

describe('read-only enforcement (ro peer ops rejected by rw peer)', () => {
  it('an rw peer does NOT merge a ro peer\'s edits', async () => {
    const bus = new FakeBus()
    const rw = await generateInvite({ cap: 'rw' })
    const roLink = (await generateInvite({ cap: 'ro', roomKey: rw.roomKey })).link

    const editor = await mkSession({ inviteLink: rw.link, peerId: 'EDIT', bus, fileId: 'd1' })
    const viewer = await mkSession({ inviteLink: roLink, peerId: 'VIEW', bus, fileId: 'd2' })
    await editor.join()
    await viewer.join()

    // Editor writes → viewer (ro) can READ it.
    editor.applyLocal('', 'Shared')
    await waitFor(() => viewer.getText() === 'Shared')
    expect(viewer.getText()).toBe('Shared')

    // Viewer is ro: applyLocal is a no-op and emits nothing.
    const ops = viewer.applyLocal('Shared', 'Shared+hack')
    expect(ops).toEqual([])
    await settle()
    // Editor's document is untouched by the ro peer.
    expect(editor.getText()).toBe('Shared')

    editor.leave(); viewer.leave()
  })

  it('even a MISBEHAVING ro peer that emits an op frame is rejected by rw', async () => {
    const bus = new FakeBus()
    const rw = await generateInvite({ cap: 'rw' })
    const roLink = (await generateInvite({ cap: 'ro', roomKey: rw.roomKey })).link

    const editor = await mkSession({ inviteLink: rw.link, peerId: 'EDIT', bus, fileId: 'd1' })
    const viewer = await mkSession({ inviteLink: roLink, peerId: 'VIEW', bus, fileId: 'd2' })
    await editor.join()
    await viewer.join()

    editor.applyLocal('', 'Base')
    await waitFor(() => editor.getText() === 'Base' && viewer.getText() === 'Base')

    // Simulate a patched/malicious ro client that bypasses the applyLocal guard
    // and directly broadcasts an op frame. It has encKey (so the frame decrypts)
    // but NO macKeyRw, so its op frame is non-authoritative.
    await viewer._broadcast(
      { type: 'op', op: viewer._crdt.localInsert(0, 'X') },
      { authoritative: false },
    )
    // Drain so the (rejected) frame is fully delivered + processed by the editor.
    await settle()

    // The rw editor rejected the non-authoritative op → document unchanged.
    expect(editor.getText()).toBe('Base')

    editor.leave(); viewer.leave()
  })
})

describe('P2PCollabSession.create() factory (sharer side)', () => {
  it('mints rw+ro links from one room; ro joiner reads but cannot write', async () => {
    const bus = new FakeBus()
    const ownerFabric = new FakeFabric(bus, 'OWNER')
    const { session: owner, rwLink, roLink, roomId } = await P2PCollabSession.create({
      peerId: 'OWNER', fileId: 'shared', baseUrl: 'https://ex.test/docs/x', fabric: ownerFabric,
    })
    expect(rwLink).toContain('#vp2p=')
    expect(roLink).toContain('#vp2p=')
    expect(roomId).toMatch(/^[0-9a-f]{32}$/)

    const viewer = await mkSession({ inviteLink: roLink, peerId: 'V', bus, fileId: 'v' })
    await owner.join()
    await viewer.join()

    owner.applyLocal('', 'Owner text')
    await waitFor(() => viewer.getText() === 'Owner text')
    expect(viewer.getText()).toBe('Owner text')
    expect(viewer.readOnly).toBe(true)
    expect(viewer.applyLocal('Owner text', 'nope')).toEqual([])

    owner.leave(); viewer.leave()
  })
})

describe('offline-buffer-then-sync', () => {
  it('edits made while offline converge after the peer reconnects', async () => {
    const bus = new FakeBus()
    const { link } = await generateInvite({ cap: 'rw' })

    const a = await mkSession({ inviteLink: link, peerId: 'A', bus, fileId: 'da' })
    const b = await mkSession({ inviteLink: link, peerId: 'B', bus, fileId: 'db' })
    await a.join()
    await b.join()

    a.applyLocal('', 'Online edit')
    await waitFor(() => b.getText() === 'Online edit')
    expect(b.getText()).toBe('Online edit')

    // B goes offline; A keeps editing locally (edits buffer in A's CRDT).
    b.fabric.online = false
    bus.unregister(b.fabric)

    a.applyLocal('Online edit', 'Online edit + offline addition')
    // Let A finish applying/broadcasting; B is offline so it drops the frames.
    await settle()
    // B, offline, has NOT yet seen the addition.
    expect(b.getText()).toBe('Online edit')

    // B's transport reconnects; the session pulls a fresh snapshot via resync().
    b.fabric.online = true
    bus.register(b.fabric)
    await b.resync()             // snap-req → A serves snapshot → B converges
    await waitFor(() => b.getText() === 'Online edit + offline addition')
    expect(b.getText()).toBe('Online edit + offline addition')

    a.leave(); b.leave()
  })
})
