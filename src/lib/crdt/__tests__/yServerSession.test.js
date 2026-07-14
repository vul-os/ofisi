/**
 * YServerCollabSession — the server-relay transport for the structure-aware
 * (Yjs) document format, and the MIGRATION off the legacy text-CRDT op log.
 *
 * Exercised against an in-memory fake of /v1/documents/:id/collab/* that models
 * what the real server does (backend/handlers/docsync.go + backend/docsync):
 * a monotonic op log, opaque op payloads, per-doc fan-out, an editor gate (a
 * viewer's publish is 403), and SaveSnapshot compaction — a snapshot sets the
 * new base and PRUNES the ops beneath it, which is exactly what retires a legacy
 * document's old op log.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'

vi.setConfig({ testTimeout: 30_000 })

// ── the fake relay ─────────────────────────────────────────────────────────

class FakeRelay {
  constructor() {
    this.ops = {}       // docId → [{seq, origin, op}]
    this.snap = {}      // docId → { seq, snap }
    this.seq = {}       // docId → max seq
    this.subs = {}      // docId → Set<cb>
    this.viewers = new Set()
    this.publishes = 0
  }
  _emit(docId, ev) { for (const cb of this.subs[docId] || []) cb({ data: JSON.stringify(ev) }) }
  subscribe(docId, cb) {
    ;(this.subs[docId] ||= new Set()).add(cb)
    return () => this.subs[docId].delete(cb)
  }
  state(docId) {
    return {
      seq: this.seq[docId] || 0,
      snap: this.snap[docId]?.snap ?? null,
      ops: (this.ops[docId] || []).slice(),
    }
  }
  publish(docId, { origin, ops = [], snap }) {
    this.publishes++
    if (this.viewers.has(origin)) {
      const err = new Error('your role does not permit modifying content')
      err.status = 403
      throw err
    }
    this.ops[docId] ||= []
    this.seq[docId] ||= 0
    for (const op of ops) {
      this.seq[docId] += 1
      this.ops[docId].push({ seq: this.seq[docId], origin, op })
      this._emit(docId, { type: 'op', origin, seq: this.seq[docId], payload: op })
    }
    if (snap) {
      // SaveSnapshot: new compaction base at the current max seq, and the ops at
      // or below it are pruned (this is what drops a legacy op log for good).
      this.snap[docId] = { seq: this.seq[docId], snap }
      this.ops[docId] = this.ops[docId].filter((r) => r.seq > this.seq[docId])
    }
    return { ok: true, accepted: ops.length, seq: this.seq[docId] }
  }
}

let relay
vi.mock('../../api.js', () => ({
  api: {
    docCollabStreamUrl: (docId) => `stream://${docId}`,
    docCollabState: async (docId) => relay.state(docId),
    docCollabPublish: async (docId, body) => relay.publish(docId, body),
    docCollabPresence: async () => ({ ok: true }),
  },
}))

class FakeEventSource {
  constructor(url) {
    this.onopen = null; this.onerror = null; this.onmessage = null
    const docId = url.replace('stream://', '')
    this._unsub = relay.subscribe(docId, (ev) => this.onmessage && this.onmessage(ev))
    setTimeout(() => this.onopen && this.onopen(), 0)
  }
  close() { this._unsub && this._unsub() }
}

// Imported AFTER the mocks.
import { YServerCollabSession } from '../yServerSession.js'
import { YCollab } from '../../../apps/docs/collabExtension.js'
import { createYContext, Y, Y_FRAGMENT, isYEnvelope, isLegacyTextPayload } from '../ydoc.js'

const tick = (ms = 400) => new Promise((r) => setTimeout(r, ms))

/** A client: Y.Doc + real editor + session, exactly as DocsEditor wires them. */
function makeClient(fileId, peerId) {
  const ydoc = new Y.Doc()
  const ctx = createYContext(null, ydoc)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ history: false }),
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
      YCollab.configure({ fragment: ydoc.getXmlFragment(Y_FRAGMENT) }),
    ],
  })
  ctx.schema = editor.schema
  const session = new YServerCollabSession({ fileId, peerId, ctx })
  return { ydoc, ctx, editor, session, element }
}

/**
 * A document with real formatting + structure, as PM JSON — built in a SEPARATE
 * (non-collaborative) editor.
 *
 * It must not be built in a collaborating peer's editor: any transaction on a
 * Y-bound editor is written straight into the Y document, so "type the content,
 * then clear it, then seed" would leave the cleared paragraph in the Y document
 * and the seed would land NEXT TO it. That is precisely why DocsEditor keeps the
 * editor non-editable and never calls setContent until the document is hydrated.
 */
function richDocJSON() {
  const element = document.createElement('div')
  const scratch = new Editor({
    element,
    extensions: [
      StarterKit.configure({ history: false }),
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
    ],
    content:
      '<h2>Quarterly report</h2>' +
      '<p><strong>Revenue</strong> grew.</p>' +
      '<table><tbody><tr><th><p>Region</p></th></tr><tr><td><p>EU</p></td></tr></tbody></table>',
  })
  const json = scratch.getJSON()
  scratch.destroy()
  return json
}

beforeEach(() => {
  relay = new FakeRelay()
  globalThis.EventSource = FakeEventSource
})

// ───────────────────────────────────────────────────────────────────────────

describe('YServerCollabSession — a new document', () => {
  it('seeds the Y document from its authoritative content and publishes it as the snapshot', async () => {
    const c = makeClient('docNew', 'A')
    const seed = richDocJSON()

    const res = await c.session.join({ seedJSON: seed })
    expect(res.seeded).toBe(true)
    expect(res.degraded).toBe(false)

    // The document (with its heading, bold mark and table) is in the editor…
    expect(c.editor.getJSON()).toEqual(seed)
    // …and on the server, as a Yjs snapshot.
    expect(isYEnvelope(relay.state('docNew').snap)).toBe(true)
  })

  it('a late joiner bootstraps the full document — formatting and structure included', async () => {
    const a = makeClient('docLate', 'A')
    const seed = richDocJSON()
    await a.session.join({ seedJSON: seed })

    a.editor.commands.insertContentAt(1, 'NEW ')
    await tick()

    // The joiner has NO local content and does not need the seed — the server has it.
    const b = makeClient('docLate', 'B')
    await b.session.join({ seedJSON: null })

    expect(b.editor.getJSON()).toEqual(a.editor.getJSON())
    const table = b.editor.getJSON().content.find((n) => n.type === 'table')
    expect(table).toBeTruthy()
  })
})

describe('YServerCollabSession — two editors over the relay', () => {
  it('a peer\'s formatting change reaches the other editor', async () => {
    const a = makeClient('docTwo', 'A')
    const seed = richDocJSON()
    await a.session.join({ seedJSON: seed })

    const b = makeClient('docTwo', 'B')
    await b.session.join({ seedJSON: null })
    await tick()

    // B makes the first paragraph a heading and bolds a word.
    const pos = b.editor.getJSON().content.findIndex((n) => n.type === 'paragraph')
    expect(pos).toBeGreaterThanOrEqual(0)
    b.editor.commands.setTextSelection(b.editor.state.doc.content.size - 1)
    b.editor.commands.insertContentAt(1, 'X')
    await tick()

    expect(a.editor.getJSON()).toEqual(b.editor.getJSON())
  })

  it('a viewer\'s publish is refused (403) and the session goes read-only', async () => {
    relay.viewers.add('V')
    const v = makeClient('docRO', 'V')
    await v.session.join({ seedJSON: { type: 'doc', content: [{ type: 'paragraph' }] } })

    v.editor.commands.insertContentAt(1, 'viewer types')
    await tick()

    expect(v.session.readOnly).toBe(true)
    expect(relay.state('docRO').ops).toHaveLength(0)   // nothing landed in the log
  })
})

// ───────────────────────────────────────────────────────────────────────────
// MIGRATION — the load-bearing case: a document stored in the OLD format.
// ───────────────────────────────────────────────────────────────────────────

describe('MIGRATION — an existing (legacy text-CRDT) document', () => {
  /** Seed the relay with a legacy op log: an RGA snapshot + RGA TextOps. */
  function seedLegacyLog(docId) {
    relay.snap[docId] = {
      seq: 0,
      snap: { nodes: [{ id: { r: 'old', c: 1 }, p: { r: '', c: 0 }, v: 104, d: false }] },
    }
    relay.ops[docId] = [
      { seq: 1, origin: 'old', op: { k: 1, id: { r: 'old', c: 2 }, p: { r: 'old', c: 1 }, v: 105 } },
      { seq: 2, origin: 'old', op: { k: 2, id: { r: 'old', c: 3 }, t: { r: 'old', c: 1 } } },
    ]
    relay.seq[docId] = 2
  }

  it('opens correctly: the legacy ops are IGNORED and the document is seeded from its authoritative content', async () => {
    seedLegacyLog('docOld')
    const c = makeClient('docOld', 'A')
    const authoritative = richDocJSON()   // what models.File.Content holds

    const res = await c.session.join({ seedJSON: authoritative })

    // The old log was recognised and deliberately not applied…
    expect(res.legacyOpsIgnored).toBe(3)      // 1 snapshot + 2 ops
    expect(c.session.rejectedUpdates).toBe(0) // ignored ≠ rejected: it's not hostile, it's old
    // …the document opens with its formatting and structure intact…
    expect(res.seeded).toBe(true)
    expect(c.editor.getJSON()).toEqual(authoritative)
    // …and NOTHING from the legacy log leaked into the document (that log held
    // the characters 'h','i' — a text CRDT could not carry a heading or a table).
    expect(c.editor.getJSON().content[0].type).toBe('heading')
  })

  it('is a ONE-WAY upgrade: the new snapshot replaces the base and prunes the legacy ops', async () => {
    seedLegacyLog('docOld2')
    const c = makeClient('docOld2', 'A')
    const authoritative = richDocJSON()
    await c.session.join({ seedJSON: authoritative })

    const after = relay.state('docOld2')
    expect(isYEnvelope(after.snap)).toBe(true)                     // new format
    expect(isLegacyTextPayload(after.snap)).toBe(false)
    expect(after.ops.filter((r) => isLegacyTextPayload(r.op))).toHaveLength(0) // pruned
  })

  it('a peer that opens the upgraded document afterwards gets the Yjs document (no re-seed, no duplication)', async () => {
    seedLegacyLog('docOld3')
    const a = makeClient('docOld3', 'A')
    const authoritative = richDocJSON()
    await a.session.join({ seedJSON: authoritative })

    // A second peer opens the SAME document and is still handed the old content
    // as its seed candidate (it reads the same File.Content) — it must NOT seed
    // again, or the document would appear twice.
    const b = makeClient('docOld3', 'B')
    const res = await b.session.join({ seedJSON: authoritative })
    expect(res.seeded).toBe(false)
    expect(b.editor.getJSON()).toEqual(authoritative)
    expect(b.editor.getJSON().content).toHaveLength(3) // heading + para + table, ONCE
  })

  it('two peers that BOTH open a legacy document concurrently converge on ONE copy', async () => {
    // Both bootstrap before either has published a snapshot: the classic
    // first-open race. The seed is content-derived and deterministic, so the two
    // seeds are the same Yjs items and merging them is a no-op.
    seedLegacyLog('docRace')
    const a = makeClient('docRace', 'A')
    const b = makeClient('docRace', 'B')
    const authoritative = richDocJSON()

    await Promise.all([
      a.session.join({ seedJSON: authoritative }),
      b.session.join({ seedJSON: authoritative }),
    ])
    await tick()

    expect(a.editor.getJSON()).toEqual(authoritative)
    expect(b.editor.getJSON()).toEqual(authoritative)
    expect(a.editor.getJSON()).toEqual(b.editor.getJSON())
  })
})

// ───────────────────────────────────────────────────────────────────────────

describe('YServerCollabSession — degraded + hostile paths', () => {
  it('degrades to local-only when the sync service is unreachable (and never publishes)', async () => {
    const c = makeClient('docDown', 'A')
    const seed = richDocJSON()
    // The endpoint is down.
    relay.state = () => { throw new Error('network down') }

    const res = await c.session.join({ seedJSON: seed })
    expect(res.degraded).toBe(true)
    // The document still opens and is editable…
    expect(c.editor.getJSON()).toEqual(seed)
    c.editor.commands.insertContentAt(1, 'offline edit')
    await tick()
    // …but nothing was published: with no bootstrap we cannot know whether the
    // server already holds state, and seeding into it would duplicate the doc.
    expect(relay.publishes).toBe(0)
  })

  it('drops a hostile op from the relay (fail-closed) and keeps the document intact', async () => {
    const a = makeClient('docEvil', 'A')
    const seed = richDocJSON()
    await a.session.join({ seedJSON: seed })
    const before = a.editor.getJSON()

    // A hostile peer publishes garbage in a well-formed envelope, plus an
    // envelope that is not even base64.
    relay._emit('docEvil', { type: 'op', origin: 'EVIL', seq: 99, payload: { y: 1, u: 'AAECAwQFBgc=' } })
    relay._emit('docEvil', { type: 'op', origin: 'EVIL', seq: 100, payload: { y: 1, u: '!!!not base64!!!' } })
    await tick(50)

    expect(a.session.rejectedUpdates).toBeGreaterThan(0)
    expect(a.editor.getJSON()).toEqual(before)   // untouched
    // The editor is still alive and usable after the hostile frames.
    a.editor.commands.insertContentAt(1, 'still works')
    expect(a.editor.getJSON()).not.toEqual(before)
  })
})
