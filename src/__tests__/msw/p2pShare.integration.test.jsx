/**
 * Integration — WAVE-25 P2P "Collaborate via link" flow.
 *
 * Ties the SHARER UI (P2PShareModal) to the real invite-link machinery and the
 * real E2E-encrypted session, end to end:
 *
 *   1. P2PShareModal renders the rw + ro links minted by generateInvite().
 *   2. hasInviteInLocation() recognises an invite fragment (the join trigger).
 *   3. Parsing an rw invite link joins a room; parsing the ro link joins the
 *      SAME room read-only.
 *   4. Two in-process sessions (rw + ro) built from the modal's links converge,
 *      a ro peer's ops are REJECTED, and the wire frames are opaque (the relay
 *      can never read the plaintext).
 *
 * This is deliberately layered on top of the modal + link format so a change to
 * the link scheme or the modal contract is caught here, not just in the lower
 * p2pSession unit tests.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import P2PShareModal from '../../apps/docs/components/P2PShareModal.jsx'
import { hasInviteInLocation } from '../../apps/docs/useP2PCollab.js'
import { P2PCollabSession } from '../../lib/crdt/p2pSession.js'
import { generateInvite, parseInvite, CAP_RW, CAP_RO } from '../../lib/crdt/p2pRoom.js'

// ── In-process, content-blind transport (mirrors the real FabricClient API) ──
class FakeBus {
  constructor() { this.nodes = new Set() }
  register(n) { this.nodes.add(n) }
  unregister(n) { this.nodes.delete(n) }
  broadcast(from, frame) { for (const n of this.nodes) if (n.peerId !== from && n.online) n.deliver(from, frame) }
  unicast(from, to, frame) { for (const n of this.nodes) if (n.peerId === to && n.online) n.deliver(from, frame) }
}
class FakeFabric extends EventTarget {
  constructor(bus, peerId) { super(); this.bus = bus; this.peerId = peerId; this.online = false; this.sent = [] }
  async join() {
    this.online = true; this.bus.register(this)
    for (const n of this.bus.nodes) if (n !== this)
      this.dispatchEvent(new CustomEvent('state', { detail: { peerId: n.peerId, state: 'connected' } }))
  }
  send(frame) { this.sent.push(frame); if (this.online) this.bus.broadcast(this.peerId, frame) }
  sendTo(to, frame) { if (this.online) this.bus.unicast(this.peerId, to, frame) }
  leave() { this.online = false; this.bus.unregister(this) }
  deliver(from, frame) { this.dispatchEvent(new CustomEvent('message', { detail: { from, data: frame } })) }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

// Poll a predicate until it holds, instead of sleeping a fixed amount and hoping
// the async encrypt→broadcast→decrypt chain finished. A fixed `settle(20)` is a
// latent flake: convergence here goes through SubtleCrypto (seal/open) which can
// exceed 20ms when the full parallel suite saturates the CPU. Polling awaits the
// REAL condition and is robust under load while staying fast in the common case.
async function until(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) {
      // Final attempt: throw the underlying assertion for a useful message.
      predicate({ assert: true })
      throw new Error('until(): predicate never became true')
    }
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

describe('P2PShareModal (sharer UI)', () => {
  it('shows both an editor (rw) and view-only (ro) invite link', async () => {
    const rw = await generateInvite({ cap: CAP_RW, baseUrl: 'https://ex.test/docs/x' })
    const ro = await generateInvite({ cap: CAP_RO, baseUrl: 'https://ex.test/docs/x', roomKey: rw.roomKey })

    render(
      <P2PShareModal
        open
        onClose={() => {}}
        links={{ rwLink: rw.link, roLink: ro.link }}
        roomId="abc123def456"
        onRotate={() => {}}
      />,
    )
    expect(screen.getByText('Editor link')).toBeInTheDocument()
    expect(screen.getByText('View-only link')).toBeInTheDocument()
    // Both links are present in read-only inputs and carry the invite fragment.
    const inputs = screen.getAllByDisplayValue(/#vp2p=/)
    expect(inputs).toHaveLength(2)
    // The E2E-encryption promise is surfaced to the user honestly.
    expect(screen.getByText(/end-to-end encrypted/i)).toBeInTheDocument()
  })

  it('shows a "Preparing room…" state before links exist', () => {
    render(<P2PShareModal open onClose={() => {}} links={null} />)
    expect(screen.getByText(/Preparing room/i)).toBeInTheDocument()
  })
})

describe('invite-fragment detection', () => {
  const orig = window.location.hash
  afterEach(() => { window.location.hash = orig })

  it('hasInviteInLocation() is true only when a #vp2p= fragment is present', () => {
    window.location.hash = ''
    expect(hasInviteInLocation()).toBe(false)
    window.location.hash = '#vp2p=abc.def'
    expect(hasInviteInLocation()).toBe(true)
  })
})

describe('invite links parse to the correct capability + same room', () => {
  it('rw link parses cap=rw, ro link parses cap=ro, both share one roomId', async () => {
    const rw = await generateInvite({ cap: CAP_RW })
    const ro = await generateInvite({ cap: CAP_RO, roomKey: rw.roomKey })

    const prw = await parseInvite(rw.link)
    const pro = await parseInvite(ro.link)
    expect(prw.cap).toBe(CAP_RW)
    expect(pro.cap).toBe(CAP_RO)
    // Same underlying room key ⇒ same derived roomId ⇒ they meet in one room.
    expect(prw.roomId).toBe(pro.roomId)
  })
})

describe('two sessions from the modal links converge; ro is rejected + sealed', () => {
  it('rw+ro peers converge, ro ops rejected, wire frames opaque', async () => {
    const bus = new FakeBus()
    // The exact links the modal would show for a freshly-created room.
    const rw = await generateInvite({ cap: CAP_RW })
    const ro = await generateInvite({ cap: CAP_RO, roomKey: rw.roomKey })

    const editor = await P2PCollabSession.fromInvite({
      inviteLink: rw.link, peerId: 'EDIT', fileId: 'd1', fabric: new FakeFabric(bus, 'EDIT'),
    })
    const viewer = await P2PCollabSession.fromInvite({
      inviteLink: ro.link, peerId: 'VIEW', fileId: 'd2', fabric: new FakeFabric(bus, 'VIEW'),
    })
    await editor.join(); await viewer.join()

    // Editor writes → viewer converges (ro peer reads live edits).
    editor.applyLocal('', 'secret-plan')
    // Await the real convergence condition (encrypt→broadcast→decrypt), not a
    // fixed sleep. Robust when SubtleCrypto is slow under parallel-suite load.
    await until(() => viewer.getText() === 'secret-plan')
    expect(viewer.getText()).toBe('secret-plan')
    expect(viewer.readOnly).toBe(true)

    // ro peer's write is a no-op and never mutates the shared doc.
    expect(viewer.applyLocal('secret-plan', 'secret-plan!!!')).toEqual([])
    await settle()
    expect(editor.getText()).toBe('secret-plan')

    // Crypto seal: the relay/transport only ever saw ciphertext frames — none
    // may contain the plaintext.
    for (const frame of editor.fabric.sent) {
      expect(frame).not.toContain('secret-plan')
    }

    editor.leave(); viewer.leave()
  })
})
