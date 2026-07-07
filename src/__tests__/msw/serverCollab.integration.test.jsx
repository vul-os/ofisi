/**
 * MSW integration — WAVE37 server-authoritative collaboration (the SSE relay +
 * op-push path).
 *
 * Where serverSession.test.js unit-tests ServerCollabSession against a bespoke
 * in-memory FakeRelay, THIS layer drives the SAME session (and the useServerCollab
 * React hook) through the REAL api.js fetch client against MSW-mocked /v1 collab
 * endpoints — so the actual request/response wiring (bootstrap GET, op-push POST,
 * the 403 editor gate, and graceful degrade) is exercised end-to-end at the
 * UI/API-mock level. This is the regression guard for the wave-14 editor gate as
 * enforced by the server relay: a viewer/commenter CANNOT push ops.
 *
 * SSE note: jsdom's EventSource can't consume a streamed body through MSW, so we
 * stub globalThis.EventSource with a tiny fake wired to the MSW op log. That lets
 * us assert late-joiner bootstrap + client dedup (no double-apply) deterministically
 * without a real event stream. True two-browser convergence is deliberately out of
 * scope here (see the report) — the relay's fan-out + RGA idempotence are what make
 * it converge, and those are unit-covered.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server, resetMock, mockState } from './server.js'
import { ServerCollabSession } from '../../lib/crdt/serverSession.js'
import { useServerCollab } from '../../apps/docs/useServerCollab.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// ── Fake EventSource wired to the MSW op log ────────────────────────────────
// Each instance registers itself so a test can push a server 'op' event to all
// live streams for a doc — mirroring the server relay fanning an editor's op out
// to the OTHER editors. onmessage payloads are the same {type,origin,seq,payload}
// envelope the real /collab/stream emits.
const liveStreams = new Map() // docId → Set<FakeEventSource>
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.onopen = null
    this.onerror = null
    this.onmessage = null
    const docId = decodeURIComponent(url.split('/documents/')[1].split('/')[0])
    this._docId = docId
    if (!liveStreams.has(docId)) liveStreams.set(docId, new Set())
    liveStreams.get(docId).add(this)
    setTimeout(() => this.onopen && this.onopen(), 0)
  }
  close() { liveStreams.get(this._docId)?.delete(this) }
}
/** Fan a server 'op' event out to every open stream for a doc. */
function relayOp(docId, { origin, seq, payload }) {
  for (const es of liveStreams.get(docId) || [])
    es.onmessage && es.onmessage({ data: JSON.stringify({ type: 'op', doc_id: docId, origin, seq, payload }) })
}

const tick = (ms = 350) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  resetMock({ role: 'owner' })
  liveStreams.clear()
  globalThis.EventSource = FakeEventSource
  // ServerCollabSession persists a per-doc CRDT snapshot to localStorage for
  // offline recovery; clear it so one test's text can't leak into the next's
  // cold-start restore.
  try { localStorage.clear() } catch { /* jsdom always has it */ }
})

// ── ServerCollabSession over the real api.js + MSW ──────────────────────────

describe('ServerCollabSession over api.js + MSW /v1 collab endpoints', () => {
  it("an editor's local edit POSTs ops to /collab/ops and the server persists them", async () => {
    const s = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    await s.join()
    expect(mockState.calls).toContain('GET /v1/documents/doc1/collab/state') // bootstrap

    s.applyLocal('', 'hello')
    await waitFor(() =>
      expect(mockState.calls).toContain('POST /v1/documents/doc1/collab/ops'))

    // The ops reached the authoritative log with the right origin.
    const log = mockState.collab.doc1.ops
    expect(log.length).toBeGreaterThan(0)
    expect(log.every((r) => r.origin === 'A')).toBe(true)
    expect(s.getText()).toBe('hello')
    s.leave()
  })

  it('a late joiner bootstraps current text from /collab/state (zero p2p peers)', async () => {
    // Editor A seeds the doc.
    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    await a.join()
    a.applyLocal('', 'seeded')
    await waitFor(() => expect(mockState.collab.doc1.ops.length).toBeGreaterThan(0))
    a.leave()

    // C joins late — no live stream needed; bootstrap replays the server op log.
    const c = new ServerCollabSession({ fileId: 'doc1', peerId: 'C' })
    await c.join()
    expect(c.getText()).toBe('seeded')
    c.leave()
  })

  it('dedups a relayed op it already applied locally (no double-apply)', async () => {
    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    let remoteChanges = 0
    a.addEventListener('change', (ev) => { if (ev.detail?.remote) remoteChanges++ })
    await a.join()

    a.applyLocal('', 'abc')
    await waitFor(() => expect(mockState.collab.doc1.ops.length).toBe(3))

    // The server relays A's OWN ops back over the stream. They must be dropped as
    // an echo (origin === self) AND, even if applied, TextCRDT.apply is idempotent
    // (dedup by op id) so the text can never double.
    for (const rec of mockState.collab.doc1.ops)
      relayOp('doc1', { origin: rec.origin, seq: rec.seq, payload: rec.op })
    await tick()

    expect(a.getText()).toBe('abc') // not 'abcabc'
    expect(remoteChanges).toBe(0)   // own ops never fire a remote change
    a.leave()
  })

  it('applies a DIFFERENT editor\'s relayed op exactly once (converges)', async () => {
    const b = new ServerCollabSession({ fileId: 'doc1', peerId: 'B' })
    let remoteText = null
    b.addEventListener('change', (ev) => { if (ev.detail?.remote) remoteText = ev.detail.text })
    await b.join()

    // Simulate editor A publishing 'hi' — build the ops via a throwaway session so
    // they carry a foreign origin, then relay them to B twice (at-least-once fanout).
    const a = new ServerCollabSession({ fileId: 'doc1', peerId: 'A' })
    const ops = a.applyLocal('', 'hi')
    let seq = 0
    for (const op of ops) relayOp('doc1', { origin: 'A', seq: ++seq, payload: op })
    for (const op of ops) relayOp('doc1', { origin: 'A', seq: ++seq, payload: op }) // duplicate delivery
    // Await the real convergence (op applied) rather than a fixed sleep. RGA
    // dedup makes the duplicate delivery idempotent, so this settles to 'hi',
    // never 'hihi', however long the relay/apply takes.
    await waitFor(() => expect(b.getText()).toBe('hi'))

    expect(b.getText()).toBe('hi')  // applied once despite duplicate delivery
    expect(remoteText).toBe('hi')
    a.leave(); b.leave()
  })
})

// ── The wave-14 editor gate at the server relay (viewer/commenter → 403) ─────

describe('WAVE37 editor gate — a viewer/commenter cannot push ops (403)', () => {
  it('a viewer role gets 403 on /collab/ops, flips read-only, and stops publishing', async () => {
    resetMock({ role: 'viewer' })
    const v = new ServerCollabSession({ fileId: 'doc1', peerId: 'V' })
    let readOnlyFired = false
    v.addEventListener('readonly', () => { readOnlyFired = true })
    await v.join()

    v.applyLocal('', 'nope')
    await waitFor(() => expect(readOnlyFired).toBe(true))

    expect(v.readOnly).toBe(true)
    // Server hit the ops route but rejected — nothing landed in the log.
    expect(mockState.calls).toContain('POST /v1/documents/doc1/collab/ops')
    expect(mockState.collab.doc1.ops.length).toBe(0)

    // Subsequent local edits are suppressed entirely (applyLocal returns []).
    const priorPosts = mockState.calls.filter((c) => c.includes('/collab/ops')).length
    const ops = v.applyLocal('nope', 'still nope')
    expect(ops).toEqual([])
    await tick(100)
    expect(mockState.calls.filter((c) => c.includes('/collab/ops')).length).toBe(priorPosts)
    v.leave()
  })

  it('a commenter role is likewise refused (403) — regression guard', async () => {
    resetMock({ role: 'commenter' })
    const s = new ServerCollabSession({ fileId: 'doc1', peerId: 'C' })
    let readOnly = false
    s.addEventListener('readonly', () => { readOnly = true })
    await s.join()
    s.applyLocal('', 'x')
    await waitFor(() => expect(readOnly).toBe(true))
    expect(mockState.collab.doc1.ops.length).toBe(0)
    s.leave()
  })
})

// ── Graceful degrade: neither server nor p2p available → local edit still works

describe('WAVE37 graceful degrade (no server relay)', () => {
  it('bootstrap failure leaves the editor working locally (autosave path intact)', async () => {
    // Make /collab/state fail (endpoint absent / self-host without the route).
    server.use(
      http.get('/v1/documents/:id/collab/state', () =>
        HttpResponse.json({ error: 'down' }, { status: 503 })),
    )
    // Unique fileId per degrade test: ServerCollabSession snapshots to a per-doc
    // localStorage key on a debounce, so isolating the id keeps a sibling test's
    // pending snapshot from restoring into this cold session.
    const s = new ServerCollabSession({ fileId: 'degrade-boot', peerId: 'A' })
    await s.join() // must not throw
    s.applyLocal('', 'local')
    expect(s.getText()).toBe('local') // local CRDT still edits
    s.leave()
  })

  it('no EventSource (SSR/blocked SSE) → still bootstraps + edits, just not live', async () => {
    delete globalThis.EventSource
    const s = new ServerCollabSession({ fileId: 'degrade-nosse', peerId: 'A' })
    await s.join()
    expect(s.live).toBe(false)
    s.applyLocal('', 'offline-ok')
    expect(s.getText()).toBe('offline-ok')
    s.leave()
  })
})

// ── The useServerCollab hook (UI wiring of the read-only gate) ───────────────

describe('useServerCollab hook — UI reflects the server read-only gate', () => {
  it('sets readOnly=true when a viewer\'s op push is refused', async () => {
    resetMock({ role: 'viewer' })
    const remote = vi.fn()
    const { result } = renderHook(() =>
      useServerCollab({ fileId: 'doc1', onRemoteText: remote, enabled: true }))

    await waitFor(() => expect(result.current.active).toBe(true))
    act(() => { result.current.onLocalText('', 'blocked') })
    await waitFor(() => expect(result.current.readOnly).toBe(true))
  })

  it('is suppressed while the E2E p2p session is active (encrypted ops never hit the server)', async () => {
    const before = mockState.calls.length
    const { result } = renderHook(() =>
      useServerCollab({ fileId: 'doc1', onRemoteText: vi.fn(), enabled: true, e2eActive: true }))
    // Never activates → never bootstraps → no /v1 collab traffic.
    await tick(50)
    expect(result.current.active).toBe(false)
    expect(mockState.calls.slice(before).some((c) => c.includes('/collab/'))).toBe(false)
  })
})
