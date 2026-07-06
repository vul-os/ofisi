/**
 * chartsCrdt.test.js (WAVE-54)
 *
 * CRDT round-trip of chart objects over GridSession's fabric stream. A chart is
 * plain data; upsert/remove broadcast a `chart_op` that a peer surfaces as a
 * 'remoteOp' event carrying the descriptor to merge. Verifies the descriptor
 * arrives intact (round-trips) and delete propagates.
 */
import { describe, it, expect, vi } from 'vitest'
import { GridSession } from '../../lib/crdt/grid.js'
import { makeChart } from './charts.js'

// Minimal in-process fabric matching what GridSession consumes:
//   .send(str)         → broadcast to the other node
//   'message' event    → { detail: { data: str } }
class PairFabric extends EventTarget {
  constructor() { super(); this.peer = null }
  link(other) { this.peer = other; other.peer = this }
  send(frame) { if (this.peer) queueMicrotask(() => this.peer.dispatchEvent(new CustomEvent('message', { detail: { data: frame } }))) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('chart CRDT round-trip', () => {
  it('upsert propagates the full descriptor to a peer, intact', async () => {
    const a = new PairFabric(), b = new PairFabric()
    a.link(b)
    const s1 = new GridSession({ sessionId: 'doc1', replicaId: 'r1', fabricClient: a })
    const s2 = new GridSession({ sessionId: 'doc1', replicaId: 'r2', fabricClient: b })

    const received = []
    s2.addEventListener('remoteOp', (ev) => { if (ev.detail?.chart) received.push(ev.detail) })

    const chart = makeChart({ id: 'c1', type: 'pie', range: 'A1:B5', title: 'Share', x: 12, y: 34, w: 400, h: 260 })
    s1.upsertChart(chart)
    await flush()

    expect(received).toHaveLength(1)
    expect(received[0].action).toBe('upsert')
    // Full descriptor round-tripped byte-for-byte (JSON-equal).
    expect(received[0].chart).toEqual(chart)

    s1.destroy(); s2.destroy()
  })

  it('delete propagates a chartId to the peer', async () => {
    const a = new PairFabric(), b = new PairFabric()
    a.link(b)
    const s1 = new GridSession({ sessionId: 'doc2', replicaId: 'r1', fabricClient: a })
    const s2 = new GridSession({ sessionId: 'doc2', replicaId: 'r2', fabricClient: b })

    const events = []
    s2.addEventListener('remoteOp', (ev) => { if (ev.detail?.chartId || ev.detail?.chart) events.push(ev.detail) })

    s1.removeChart('c9')
    await flush()

    expect(events).toHaveLength(1)
    expect(events[0].action).toBe('delete')
    expect(events[0].chartId).toBe('c9')

    s1.destroy(); s2.destroy()
  })

  it('ignores malformed chart upserts (no id) — never broadcasts', async () => {
    const a = new PairFabric(), b = new PairFabric()
    a.link(b)
    const s1 = new GridSession({ sessionId: 'doc3', replicaId: 'r1', fabricClient: a })
    const s2 = new GridSession({ sessionId: 'doc3', replicaId: 'r2', fabricClient: b })
    const spy = vi.fn()
    s2.addEventListener('remoteOp', spy)
    s1.upsertChart({ /* no id */ type: 'bar' })
    await flush()
    expect(spy).not.toHaveBeenCalled()
    s1.destroy(); s2.destroy()
  })
})
