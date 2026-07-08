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

// ---------------------------------------------------------------------------
// BUG 6 (deep/office2) — OFFLINE→reconnect snapshot exchange LOST edits.
//
// The snap/snap-req reconnection handlers (DocsCollabSession, P2PCollabSession,
// ServerCollabSession) merged an incoming snapshot with restore() gated on
// "remote node count > local node count". restore() REPLACES local state, so:
//   • two peers editing OFFLINE each hold nodes the other lacks — the smaller
//     side's offline edits were silently DROPPED (replaced away), and
//   • if counts were equal-but-different, neither side restored → permanent
//     divergence.
// Fix: TextCRDT.merge() folds the snapshot in via idempotent RGA apply (union),
// so both peers reach the same superset with ZERO loss regardless of order.
// ---------------------------------------------------------------------------
describe('BUG6: offline-reconnect merges snapshots (no lost edits)', () => {
  function seededPair() {
    const a = new TextCRDT('A')
    const baseOps = []
    for (const [i, ch] of [...'base'].entries()) { const op = a.localInsert(i, ch); a.apply(op); baseOps.push(op) }
    const b = new TextCRDT('B')
    for (const op of baseOps) b.apply(op)
    return { a, b }
  }

  it('both peers keep their offline edits after a snapshot exchange', () => {
    const { a, b } = seededPair()
    for (const [i, ch] of [...'AAA'].entries()) a.apply(a.localInsert(4 + i, ch)) // baseAAA
    for (const [i, ch] of [...'BB'].entries()) b.apply(b.localInsert(4 + i, ch))  // baseBB

    // Reconnect: exchange snapshots. Order must not matter.
    const snapA = a.snapshot(); const snapB = b.snapshot()
    b.merge(snapA) // B had FEWER nodes; the old restore-if-larger DROPPED B's "BB"
    a.merge(snapB)

    expect(a.toString()).toBe(b.toString())      // converged
    expect(a.toString()).toContain('AAA')
    expect(a.toString()).toContain('BB')         // was lost before the fix
  })

  it('an offline DELETE propagates through the merge', () => {
    const { a, b } = seededPair()
    b.apply(b.localDelete(0)) // B deletes 'b' offline → "ase"
    a.merge(b.snapshot())
    b.merge(a.snapshot())
    expect(a.toString()).toBe(b.toString())
    expect(a.toString()).toBe('ase')            // delete survived + converged
  })

  it('merge is idempotent (re-merging the same snapshot is a no-op)', () => {
    const { a, b } = seededPair()
    for (const [i, ch] of [...'X'].entries()) a.apply(a.localInsert(4 + i, ch))
    const snap = a.snapshot()
    expect(b.merge(snap)).toBe(true)
    expect(b.merge(snap)).toBe(false)           // second merge changes nothing
    expect(b.toString()).toBe('baseX')
  })
})

// ---------------------------------------------------------------------------
// BUG 8 (fix/office-collab-autosave, P1) — Slides SLIDE-LEVEL clobber.
//
// A slide was stored as ONE JSON blob mutated via a whole-slide LWW (SET_TEXT).
// Two peers editing DIFFERENT positioned objects on the SAME slide clobbered
// each other: last-writer-wins on the ENTIRE slide → the loser's object move/
// edit was silently lost. Fix: per-OBJECT LWW — each object carries its own id +
// opId and setSlide diffs + broadcasts only the changed objects/scalars, merged
// per-entry. Two peers moving two different objects must BOTH survive; two peers
// editing the SAME object is deterministic per-object LWW; scalar props keep
// their own LWW stamp.
// ---------------------------------------------------------------------------
describe('BUG8: slides per-object LWW (concurrent object edits both survive)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  // Two TreeSessions on a shared bus, but each captures outbound frames so the
  // test controls delivery timing. `flush()` cross-delivers all queued frames —
  // this models TRUE concurrency: both peers act BEFORE seeing each other's op,
  // exactly the case a whole-slide LWW clobbered. Seeded from a common base deck.
  function concurrentPair(session, baseSlide) {
    const seed = new TreeSession({ sessionId: session, replicaId: 'seed', fabricClient: new (class extends EventTarget { send() {} })() })
    const nid = seed.insertSlide('m', baseSlide)
    const baseNodes = seed._crdt.snapshot()

    const queues = new Map()
    const mk = (replicaId) => {
      const fab = new (class extends EventTarget { send(frame) { queues.get(replicaId).push(frame) } })()
      const s = new TreeSession({ sessionId: session, replicaId, fabricClient: fab })
      queues.set(replicaId, [])
      s._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session, nodes: baseNodes }))
      queues.set(replicaId, []) // discard any frames from the seed apply
      return s
    }
    const A = mk('A'), B = mk('B')
    const flush = () => {
      const fa = queues.get('A').splice(0), fb = queues.get('B').splice(0)
      for (const f of fa) B._handleFabricMessage(f)   // A's ops → B
      for (const f of fb) A._handleFabricMessage(f)   // B's ops → A
    }
    return { A, B, nid, flush }
  }

  function slideOf(s, nodeId) {
    return s.orderedSlides().find((x) => x.nodeId === nodeId)?.data
  }

  it('two peers moving DIFFERENT objects on one slide → union (no loss)', () => {
    const { A, B, nid, flush } = concurrentPair('deck1', {
      title: 'S',
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0.5, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    // TRUE concurrency: each acts against the base BEFORE seeing the other.
    A.setSlide(nid, {
      title: 'S',
      objects: [
        { id: 'o1', type: 'shape', x: 0.8, y: 0.8, w: 0.2, h: 0.2, z: 1 }, // A moves o1
        { id: 'o2', type: 'shape', x: 0.5, y: 0.5, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    B.setSlide(nid, {
      title: 'S',
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.2, y: 0.2, w: 0.2, h: 0.2, z: 2 }, // B moves o2
      ],
    })
    flush()

    for (const s of [A, B]) {
      const objs = Object.fromEntries(slideOf(s, nid).objects.map((o) => [o.id, o]))
      expect(objs.o1.x).toBe(0.8) // A's move to o1 survived on both
      expect(objs.o2.x).toBe(0.2) // B's move to o2 survived on both — NOT clobbered
    }
    expect(slideOf(A, nid)).toEqual(slideOf(B, nid))
  })

  it('two peers editing the SAME object → deterministic per-object LWW', () => {
    const { A, B, nid, flush } = concurrentPair('deck2', {
      objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }],
    })
    A.setSlide(nid, { objects: [{ id: 'o1', type: 'shape', x: 0.3, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    B.setSlide(nid, { objects: [{ id: 'o1', type: 'shape', x: 0.7, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    flush()

    // Both replicas agree on the SAME winner (higher opId wins — deterministic).
    expect(slideOf(A, nid)).toEqual(slideOf(B, nid))
    expect([0.3, 0.7]).toContain(slideOf(A, nid).objects[0].x)
  })

  it('scalar props (background) keep their own LWW, independent of objects', () => {
    const { A, B, nid, flush } = concurrentPair('deck3', {
      background: '#000', objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }],
    })
    A.setSlide(nid, { background: '#fff', objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    B.setSlide(nid, { background: '#000', objects: [{ id: 'o1', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    flush()

    for (const s of [A, B]) {
      const d = slideOf(s, nid)
      expect(d.background).toBe('#fff')      // A's scalar edit survived
      expect(d.objects[0].x).toBe(0.5)       // B's object move survived (independent)
    }
  })

  it('a peer DELETING an object converges (object removed on both)', () => {
    const { A, B, nid, flush } = concurrentPair('deck4', {
      objects: [
        { id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    A.setSlide(nid, {
      objects: [
        { id: 'o1', type: 'shape', x: 0.9, y: 0, w: 0.2, h: 0.2, z: 1 }, // A moves o1
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    B.setSlide(nid, { objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }] }) // B deletes o2
    flush()

    for (const s of [A, B]) {
      const objs = slideOf(s, nid).objects
      expect(objs.map((o) => o.id)).toEqual(['o1']) // o2 deleted on both
      expect(objs[0].x).toBe(0.9)                   // A's move to o1 survived
    }
  })
})

// ---------------------------------------------------------------------------
// BUG 9 (fix/office-collab-autosave, P1) — offline-reconnect of slides must
// converge object-granularly. Two peers edit DIFFERENT objects OFFLINE, then
// exchange snapshots on reconnect. A whole-slide-replay cold-join would clobber
// the joiner's own concurrent object edit; the union merge keeps both.
// ---------------------------------------------------------------------------
describe('BUG9: slides offline-reconnect converges per object (no lost edits)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })
  class FF extends EventTarget { send() {} }

  it('offline edits to different objects both survive a snapshot exchange', () => {
    // Shared starting deck (same node id + objects on both replicas).
    const seed = new TreeSession({ sessionId: 'deckR', replicaId: 'seed', fabricClient: new FF() })
    const nid = seed.insertSlide('m', {
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    const baseNodes = seed._crdt.snapshot()

    const A = new TreeSession({ sessionId: 'deckR', replicaId: 'A', fabricClient: new FF() })
    const B = new TreeSession({ sessionId: 'deckR', replicaId: 'B', fabricClient: new FF() })
    for (const s of [A, B]) {
      s._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session: 'deckR', nodes: baseNodes }))
    }

    // OFFLINE: A moves o1, B moves o2 — neither sees the other yet.
    A.setSlide(nid, {
      objects: [
        { id: 'o1', type: 'shape', x: 0.9, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    B.setSlide(nid, {
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.2, y: 0.7, w: 0.2, h: 0.2, z: 2 },
      ],
    })

    // RECONNECT: exchange snapshots (order-independent union merge).
    const snapA = A._crdt.snapshot()
    const snapB = B._crdt.snapshot()
    B._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session: 'deckR', nodes: snapA }))
    A._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session: 'deckR', nodes: snapB }))

    for (const s of [A, B]) {
      const objs = Object.fromEntries(s.orderedSlides().find((x) => x.nodeId === nid).data.objects.map((o) => [o.id, o]))
      expect(objs.o1.x).toBe(0.9)   // A's offline move survived
      expect(objs.o2.y).toBe(0.7)   // B's offline move survived
    }
    expect(A.orderedSlides()).toEqual(B.orderedSlides())
  })
})

// ---------------------------------------------------------------------------
// BUG 7 (deep/office2) — Slides tree cold-join created a PHANTOM DUPLICATE slide
// after any reorder.
//
// A node's ordId ADVANCES on every moveSlide (LWW), so after a reorder
// ordId !== id. The tree_snapshot handler rebuilt the node with
// apply(INSERT, id: n.ordId) — keying it in the CRDT map by the MOVE op's id, a
// DIFFERENT key than n.id. The subsequent SET_TEXT (target: n.id) then found no
// such node and created a SECOND empty stub. Result: the joiner rendered a
// phantom duplicate empty slide (two slides where the peer had one) and lost the
// real slide's node identity → non-convergence after any reorder + cold-join.
// Fix: rebuild at id=n.id, then replay the MOVE (id: n.ordId) to converge ordKey.
// ---------------------------------------------------------------------------
describe('BUG7: slides tree cold-join after a reorder does not duplicate slides', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  it('a moved slide cold-joins as ONE slide with the peer node id', () => {
    const fabA = new FakeFabric()
    const A = new TreeSession({ sessionId: 'deckX', replicaId: 'A', fabricClient: fabA })
    const nid = A.insertSlide('m', { title: 'S1' })
    A.moveSlide(nid, 'p') // ordId now advances past nid
    const nodes = A._crdt.snapshot()
    expect(A.orderedSlides()).toHaveLength(1)

    const fabB = new FakeFabric()
    const B = new TreeSession({ sessionId: 'deckX', replicaId: 'B', fabricClient: fabB })
    fabB.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({ type: 'tree_snapshot', session: 'deckX', nodes }) },
    }))

    const bs = B.orderedSlides()
    expect(bs).toHaveLength(1)                    // was 2 (a phantom empty stub)
    expect(bs[0].nodeId).toBe(nid)               // real node identity preserved
    expect(bs[0].data).toEqual({ title: 'S1' })
  })

  it('multi-slide reorder cold-joins to the same order and count', () => {
    const fabA = new FakeFabric()
    const A = new TreeSession({ sessionId: 'deckY', replicaId: 'A', fabricClient: fabA })
    const n1 = A.insertSlide('b', { t: 'one' })
    A.insertSlide('n', { t: 'two' })
    const n3 = A.insertSlide('t', { t: 'three' })
    A.moveSlide(n3, 'a') // three to the front
    const nodes = A._crdt.snapshot()

    const fabB = new FakeFabric()
    const B = new TreeSession({ sessionId: 'deckY', replicaId: 'B', fabricClient: fabB })
    fabB.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({ type: 'tree_snapshot', session: 'deckY', nodes }) },
    }))

    expect(B.orderedSlides().map((s) => s.nodeId))
      .toEqual(A.orderedSlides().map((s) => s.nodeId))
    expect(B.orderedSlides().map((s) => s.data.t)).toEqual(['three', 'one', 'two'])
    // Joiner edit to the moved slide must still win (clock seeded past ordId).
    B.setSlide(n1, { t: 'EDITED' })
    expect(B.orderedSlides().find((s) => s.nodeId === n1).data).toEqual({ t: 'EDITED' })
  })
})
