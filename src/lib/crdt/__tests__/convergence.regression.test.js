/**
 * convergence.regression.test.js — data-integrity regression guards for the
 * Office CRDTs (deep/office audit).
 *
 * Each block pins a CONFIRMED bug that corrupted a user's document or made two
 * peers diverge. They failed before the deep/office fixes and must stay green.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { TextCRDT } from '../text.js'
import { DocsCollabSession, diffToOps } from '../index.js'
import { GridSession } from '../grid.js'
import { TreeSession } from '../tree.js'

// Minimal in-process fabric so sessions build without touching the network.
class FakeFabric extends EventTarget {
  constructor() { super(); this.sent = [] }
  async join() {}
  send(f) { this.sent.push(f) }
  sendTo() {}
  leave() {}
}

// ---------------------------------------------------------------------------
// BUG 1 — TextCRDT.restore() did not seed the Lamport clock.
//
// After a reload/cold-start the clock stayed at 0, so the next localInsert minted
// an OpID with counter 1 that COLLIDED with this same replica's own restored op
// (same replicaId + counter 1). apply() then rejected the new insert as "already
// seen" and SILENTLY DROPPED the user's edit — a peer that reloaded then kept
// typing stopped propagating, and its snapshot lost the new characters.
// ---------------------------------------------------------------------------
describe('BUG1: text restore seeds the clock (reload-then-type keeps edits)', () => {
  it('an edit after restore is not dropped by an OpID collision', () => {
    const a = new TextCRDT('replicaP')
    for (const [i, ch] of [...'hello'].entries()) a.apply(a.localInsert(i, ch))
    const snap = a.snapshot()

    // Reload: fresh CRDT, SAME replica id (sessionStorage-stable across reloads).
    const b = new TextCRDT('replicaP')
    b.restore(snap)
    expect(b.toString()).toBe('hello')

    b.apply(b.localInsert(5, '!'))
    expect(b.toString()).toBe('hello!') // was 'hello' — the '!' silently dropped
  })

  it('the post-restore insert gets a strictly-higher OpID counter', () => {
    const a = new TextCRDT('replicaP')
    for (const [i, ch] of [...'abc'].entries()) a.apply(a.localInsert(i, ch))
    const b = new TextCRDT('replicaP')
    b.restore(a.snapshot())
    const op = b.localInsert(3, 'd')
    expect(op.id.c).toBeGreaterThan(3) // past the max restored counter (3)
  })
})

// ---------------------------------------------------------------------------
// BUG 2 — diffToOps split astral characters (emoji, many CJK-ext / math glyphs)
// on UTF-16 code-unit boundaries, feeding the CRDT lone surrogates. The ingress
// validator rejects surrogate code points, so the glyph was SILENTLY DROPPED —
// a collaborative document could not contain an emoji at all.
// ---------------------------------------------------------------------------
describe('BUG2: astral / emoji characters survive the diff', () => {
  it('typing an emoji preserves it in the CRDT', () => {
    const crdt = new TextCRDT('A')
    const ops = diffToOps('', 'hi 😀 there', crdt)
    expect(crdt.toString()).toBe('hi 😀 there')
    // A peer replaying the same ops converges to the identical text (with emoji).
    const b = new TextCRDT('B')
    for (const op of ops) b.apply(op)
    expect(b.toString()).toBe('hi 😀 there')
  })

  it('inserting text AFTER an existing emoji lands in the right place', () => {
    const crdt = new TextCRDT('A')
    diffToOps('', '😀', crdt)
    diffToOps('😀', '😀!', crdt) // node-indexed diff must treat the emoji as one node
    expect(crdt.toString()).toBe('😀!')
  })

  it('a mixed CJK-extension + emoji run round-trips through a session', () => {
    const s = new DocsCollabSession({ fileId: 'doc-emoji', peerId: 'A' })
    s._fabric = new FakeFabric()
    s.applyLocal('', '𝕏𠀀🎉')
    expect(s.getText()).toBe('𝕏𠀀🎉')
  })
})

// ---------------------------------------------------------------------------
// BUG 3 — a DELETE that arrived BEFORE its target INSERT (non-causal / reordered
// delivery across a P2P mesh) was silently dropped. The character then appeared
// when its insert finally landed and was NEVER deleted, so the receiving replica
// diverged permanently from the originator.
// ---------------------------------------------------------------------------
describe('BUG3: out-of-order delete is buffered until its insert arrives', () => {
  it('delete-before-insert still converges to deleted', () => {
    const origin = new TextCRDT('A')
    const ins = origin.localInsert(0, 'X'); origin.apply(ins)
    const del = origin.localDelete(0); origin.apply(del)
    expect(origin.toString()).toBe('')

    // Reordered peer: sees the DELETE first, then the INSERT.
    const peer = new TextCRDT('C')
    peer.apply(del) // target unknown → buffered, not dropped
    peer.apply(ins) // born already-deleted
    expect(peer.toString()).toBe('') // was 'X' → divergence
    expect(peer.toString()).toBe(origin.toString())
  })

  it('a buffered delete does not affect an unrelated later insert of the same char', () => {
    const peer = new TextCRDT('C')
    // Delete targets an id that will never exist here.
    peer.apply({ k: 2, id: { r: 'A', c: 9 }, t: { r: 'A', c: 5 } })
    // A normal local insert is unaffected.
    peer.apply(peer.localInsert(0, 'Y'))
    expect(peer.toString()).toBe('Y')
  })
})

// ---------------------------------------------------------------------------
// BUG 4 — GridSession cold-join over the fabric applied a peer snapshot's cells
// but did NOT advance the local Lamport clock past their counters. The joiner's
// first edits then minted smaller OpIDs than the cells already held; LWW
// (higher OpID wins) DROPPED those edits, so the user typed a value that
// silently reverted to the peer's.
// ---------------------------------------------------------------------------
describe('BUG4: grid cold-join seeds the clock (joiner edits win)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  function highOpId(counter, replica) {
    return '0'.repeat(20) + '_' + String(counter).padStart(10, '0') + '_' + replica
  }

  it('an edit to an existing cell after a snapshot merge is not dropped', () => {
    const fab = new FakeFabric()
    const s = new GridSession({ sessionId: 'sheet1', replicaId: 'joiner', fabricClient: fab })
    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'grid_snapshot', session: 'sheet1',
        cells: [{ r: 0, c: 0, opId: highOpId(50, 'peerA'), value: 'peerval', deleted: false }],
      }) },
    }))
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'peerval' }])

    s.setCell(0, 0, 'myval')
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'myval' }]) // was still 'peerval'
  })
})

// ---------------------------------------------------------------------------
// BUG 5 — TreeSession cold-join (Slides) had the same defect as the grid: it
// merged a peer's snapshot nodes without advancing the Lamport clock, so the
// joiner's first setSlide/moveSlide minted a lower OpID than the node already
// held and the LWW guard DROPPED the edit — a slide text change or reorder
// silently reverted to the peer's version.
// ---------------------------------------------------------------------------
describe('BUG5: slides tree cold-join seeds the clock (joiner edits win)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  function id(counter, replica) {
    return '0'.repeat(20) + '_' + String(counter).padStart(10, '0') + '_' + replica
  }

  it('editing an existing slide after a snapshot merge is not dropped', () => {
    const fab = new FakeFabric()
    const s = new TreeSession({ sessionId: 'deck1', replicaId: 'joiner', fabricClient: fab })
    const nodeId = id(10, 'peerA')
    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'tree_snapshot', session: 'deck1',
        nodes: [{
          id: nodeId, parent: '', ordKey: 'm', ordId: nodeId,
          value: JSON.stringify({ title: 'peer' }), valueId: id(20, 'peerA'), deleted: false,
        }],
      }) },
    }))
    expect(s.orderedSlides()).toHaveLength(1)

    s.setSlide(nodeId, { title: 'mine' })
    expect(s.orderedSlides()[0].data).toEqual({ title: 'mine' }) // was still {title:'peer'}
  })
})
