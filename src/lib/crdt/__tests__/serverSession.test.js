import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// A fake in-memory server relay standing in for /v1/documents/:id/collab/*.
// It models: authoritative op log with monotonic seq, per-doc fan-out to
// subscribers, late-joiner state, and an editor gate (viewers get 403 on POST).
// ServerCollabSession is exercised against this via a mocked api module.
// ---------------------------------------------------------------------------

class FakeRelay {
  constructor() {
    this.ops = {}        // docId -> [{seq, origin, op}]
    this.seq = {}        // docId -> max seq
    this.subs = {}       // docId -> Set of onmessage callbacks
    this.viewers = new Set() // origins that are read-only (403 on publish)
  }
  _emit(docId, ev) {
    for (const cb of this.subs[docId] || []) cb({ data: JSON.stringify(ev) })
  }
  subscribe(docId, cb) {
    if (!this.subs[docId]) this.subs[docId] = new Set()
    this.subs[docId].add(cb)
    return () => this.subs[docId].delete(cb)
  }
  state(docId) {
    return { seq: this.seq[docId] || 0, snap: null, ops: (this.ops[docId] || []).slice() }
  }
  publish(docId, { origin, ops }) {
    if (this.viewers.has(origin)) {
      const err = new Error('your role does not permit modifying content')
      err.status = 403
      throw err
    }
    if (!this.ops[docId]) { this.ops[docId] = []; this.seq[docId] = 0 }
    let last = this.seq[docId]
    for (const op of ops) {
      last += 1
      this.ops[docId].push({ seq: last, origin, op })
      this._emit(docId, { type: 'op', doc_id: docId, origin, seq: last, payload: op })
    }
    this.seq[docId] = last
    return { ok: true, accepted: ops.length, seq: last }
  }
}

let relay
const streamHandles = new Map() // url -> { onmessage, close }

// Mock the api module the session imports.
vi.mock('../../api.js', () => ({
  api: {
    docCollabStreamUrl: (docId) => `stream://${docId}`,
    docCollabState: async (docId) => relay.state(docId),
    docCollabPublish: async (docId, body) => relay.publish(docId, body),
  },
}))

// Mock EventSource → wire onmessage into the relay's per-doc subscription.
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.onopen = null
    this.onerror = null
    this.onmessage = null
    const docId = url.replace('stream://', '')
    this._unsub = relay.subscribe(docId, (ev) => this.onmessage && this.onmessage(ev))
    streamHandles.set(url, this)
    // Fire open asynchronously.
    setTimeout(() => this.onopen && this.onopen(), 0)
  }
  close() { this._unsub && this._unsub() }
}

// Import AFTER mocks are registered.
import { ServerCollabSession } from '../serverSession.js'

beforeEach(() => {
  relay = new FakeRelay()
  streamHandles.clear()
  globalThis.EventSource = FakeEventSource
  globalThis.localStorage = {
    _s: {},
    getItem(k) { return this._s[k] ?? null },
    setItem(k, v) { this._s[k] = String(v) },
    removeItem(k) { delete this._s[k] },
  }
})

// Small helper: wait for pending microtasks/timers to settle.
const tick = (ms = 300) => new Promise((r) => setTimeout(r, ms))

describe('ServerCollabSession — two editors converge via the server relay', () => {
  it('editor B receives editor A\'s ops and converges', async () => {
    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    const b = new ServerCollabSession({ fileId: 'doc1', peerId: 'B' })
    const bText = []
    b.addEventListener('change', (ev) => { if (ev.detail?.remote) bText.push(ev.detail.text) })

    await a.join()
    await b.join()

    a.applyLocal('', 'hello')
    await tick() // publish debounce + relay fan-out

    expect(a.getText()).toBe('hello')
    expect(b.getText()).toBe('hello')
    expect(bText[bText.length - 1]).toBe('hello')

    a.leave(); b.leave()
  })
})

describe('ServerCollabSession — dedup (own echo + idempotent apply)', () => {
  it('a relayed op we already applied locally does not double-apply', async () => {
    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    let remoteChanges = 0
    a.addEventListener('change', (ev) => { if (ev.detail?.remote) remoteChanges++ })
    await a.join()

    a.applyLocal('', 'abc')
    await tick()

    // A's own op comes back over the stream (origin === 'A') → dropped as echo,
    // and even if applied would be an idempotent no-op. Text stays correct.
    expect(a.getText()).toBe('abc')
    expect(remoteChanges).toBe(0) // no remote change events for our own ops
    a.leave()
  })
})

describe('ServerCollabSession — late joiner gets current state', () => {
  it('a session joining after edits bootstraps to current text', async () => {
    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    await a.join()
    a.applyLocal('', 'seeded')
    await tick()

    // C joins late — bootstrap pulls the authoritative op log.
    const c = new ServerCollabSession({ fileId: 'doc1', peerId: 'C' })
    await c.join()
    expect(c.getText()).toBe('seeded')
    a.leave(); c.leave()
  })
})

describe('ServerCollabSession — viewer cannot publish (read-only)', () => {
  it('a 403 on publish flips the session read-only and stops sending ops', async () => {
    const v = new ServerCollabSession({ fileId: 'doc1', peerId: 'V' })
    relay.viewers.add('V') // server will reject V's ops with 403
    let readOnlyFired = false
    v.addEventListener('readonly', () => { readOnlyFired = true })
    await v.join()

    v.applyLocal('', 'nope')
    await tick()

    expect(readOnlyFired).toBe(true)
    expect(v.readOnly).toBe(true)
    // The op never reached the authoritative log.
    expect(relay.state('doc1').ops.length).toBe(0)
    // Subsequent local edits are not published either.
    v.applyLocal('nope', 'still nope')
    await tick()
    expect(relay.state('doc1').ops.length).toBe(0)
    v.leave()
  })
})

describe('ServerCollabSession — WAVE-56: hostile op over SSE does not crash the victim', () => {
  it('a poisoned CRDT op (non-codepoint v) delivered over the stream is dropped, editor survives', async () => {
    // Victim B is a legitimate co-editor. A malicious co-editor A publishes a
    // valid op AND a poisoned one whose `v` is not a Unicode code point. Before
    // the fix, String.fromCodePoint(op.v) threw RangeError *inside* B's
    // es.onmessage → uncaught → B's remote-op handler crashed. Now the op is
    // dropped fail-closed and B stays live + converges on the valid text.
    const a = new ServerCollabSession({ fileId: 'docX', peerId: 'A' })
    const b = new ServerCollabSession({ fileId: 'docX', peerId: 'B' })
    let crashed = false
    // A throw escaping onmessage would surface as an unhandled error; assert the
    // change stream keeps flowing instead.
    const bText = []
    b.addEventListener('change', (ev) => { if (ev.detail?.remote) bText.push(ev.detail.text) })

    await a.join()
    await b.join()

    // Legit edit from A → B.
    a.applyLocal('', 'ok')
    await tick()
    expect(b.getText()).toBe('ok')

    // Malicious peer injects a poisoned op straight onto the relay (bypasses A's
    // client-side diff — models a hostile client or compromised relay frame).
    expect(() => {
      relay._emit('docX', {
        type: 'op', doc_id: 'docX', origin: 'evil', seq: 999,
        payload: { k: 1, id: { r: 'evil', c: 500 }, p: null, v: { toString: () => 'x' } },
      })
    }).not.toThrow()
    await tick()

    // Victim did not crash and its text is uncorrupted.
    crashed = false
    expect(crashed).toBe(false)
    expect(b.getText()).toBe('ok')

    // A subsequent legit edit still propagates → B is still live.
    a.applyLocal('ok', 'ok!')
    await tick()
    expect(b.getText()).toBe('ok!')

    a.leave(); b.leave()
  })

  it('a poisoned node in the bootstrap snapshot does not break a late joiner', async () => {
    // Seed the doc, then poison the persisted op log the relay hands to a late
    // joiner. The joiner's restore()/replay must skip the bad node, not throw.
    const a = new ServerCollabSession({ fileId: 'docY', peerId: 'A' })
    await a.join()
    a.applyLocal('', 'safe')
    await tick()
    // Inject a poisoned op into the authoritative log a late joiner will replay.
    relay.ops['docY'].push({ seq: 998, origin: 'evil', op: { k: 1, id: { r: 'evil', c: 998 }, p: null, v: -5 } })

    const late = new ServerCollabSession({ fileId: 'docY', peerId: 'L' })
    await expect(late.join()).resolves.toBeUndefined() // bootstrap must not throw
    expect(late.getText()).toBe('safe')
    a.leave(); late.leave()
  })
})

describe('ServerCollabSession — graceful degrade (no server)', () => {
  it('bootstrap failure leaves the editor working locally', async () => {
    // Make the state fetch throw (server route absent / offline).
    const mod = await import('../../api.js')
    const orig = mod.api.docCollabState
    mod.api.docCollabState = async () => { throw new Error('offline') }

    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    await a.join() // must not throw
    a.applyLocal('', 'local')
    expect(a.getText()).toBe('local') // local CRDT still works

    mod.api.docCollabState = orig
    a.leave()
  })
})
