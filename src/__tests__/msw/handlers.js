/**
 * MSW request handlers — an in-memory mock of the Vulos Office `/api` doc
 * backend, used by the RTL + MSW integration layer (WAVE-28).
 *
 * These model the real endpoints exercised by HistoryPanel / CommentsPanel /
 * SuggestionPanel / DocsEditor (see src/lib/api.js). The store is intentionally
 * small but *stateful* so a test can add a comment and then read it back, or
 * assert that a viewer/commenter role is refused a restore (wave-14 security).
 *
 * The role of the mock "current user" is controlled via `mockState.role`
 * ('owner' | 'editor' | 'commenter' | 'viewer'); a test flips it to prove the
 * server-side restore gate at the API-mock level.
 */

import { http, HttpResponse } from 'msw'

// ─── Mutable in-memory backend state ────────────────────────────────────────

export const mockState = {
  role: 'owner', // 'owner' | 'editor' | 'commenter' | 'viewer'
  files: {},
  versions: {},     // fileId → [{ id, name, created_at, label }]
  comments: {},     // fileId → [comment]
  suggestions: {},  // fileId → [suggestion]
  // Call log so tests can assert an endpoint was (or wasn't) hit.
  calls: [],
}

let seq = 1
const uid = (p) => `${p}_${seq++}`

/** Reset the backend to a clean, seeded slate. Call in beforeEach. */
export function resetMock({ role = 'owner' } = {}) {
  seq = 1
  mockState.role = role
  mockState.calls = []
  mockState.files = {
    doc1: {
      id: 'doc1',
      name: 'Design Notes',
      type: 'doc',
      content: { _html: '<p>Hello world</p>' },
    },
  }
  mockState.versions = {
    doc1: [
      { id: 'v2', name: 'Design Notes', created_at: new Date(Date.now() - 60_000).toISOString(), label: '' },
      { id: 'v1', name: 'Design Notes', created_at: new Date(Date.now() - 3_600_000).toISOString(), label: 'First draft' },
    ],
  }
  mockState.comments = { doc1: [] }
  mockState.suggestions = { doc1: [] }
}

// A restore is only permitted for owner/editor. viewer/commenter → 403.
// This mirrors the wave-14 server-side authorization the UI relies on.
const CAN_RESTORE = new Set(['owner', 'editor'])

const log = (method, path) => mockState.calls.push(`${method} ${path}`)

// ─── Handlers ───────────────────────────────────────────────────────────────

export const handlers = [
  http.get('/api/auth/status', () =>
    HttpResponse.json({ authenticated: true, account_id: 'you@vulos.test' })),

  http.get('/api/files/:id', ({ params }) => {
    log('GET', `/files/${params.id}`)
    const f = mockState.files[params.id]
    if (!f) return HttpResponse.json({ error: 'not found' }, { status: 404 })
    return HttpResponse.json(f)
  }),

  http.put('/api/files/:id', async ({ params, request }) => {
    log('PUT', `/files/${params.id}`)
    const body = await request.json()
    const f = mockState.files[params.id]
    if (f) Object.assign(f, { name: body.name ?? f.name, content: body.content ?? f.content })
    return HttpResponse.json(f || { id: params.id, ...body })
  }),

  // ── Version history ──────────────────────────────────────────────────────
  http.get('/api/files/:id/versions', ({ params }) => {
    log('GET', `/files/${params.id}/versions`)
    return HttpResponse.json(mockState.versions[params.id] || [])
  }),

  http.post('/api/files/:id/versions/:vid/restore', ({ params }) => {
    log('POST', `/files/${params.id}/versions/${params.vid}/restore`)
    // ── WAVE-14 security: only owner/editor may restore ──────────────────
    if (!CAN_RESTORE.has(mockState.role)) {
      return HttpResponse.json(
        { error: 'forbidden: your role cannot restore versions' },
        { status: 403 },
      )
    }
    const f = mockState.files[params.id]
    return HttpResponse.json({ ...f, _restoredFrom: params.vid })
  }),

  http.post('/api/files/:id/versions', async ({ params, request }) => {
    log('POST', `/files/${params.id}/versions`)
    const body = await request.json().catch(() => ({}))
    const v = { id: uid('v'), name: mockState.files[params.id]?.name, created_at: new Date().toISOString(), label: body.label || '' }
    ;(mockState.versions[params.id] ||= []).unshift(v)
    return HttpResponse.json(v)
  }),

  // ── Comments ─────────────────────────────────────────────────────────────
  http.get('/api/files/:id/comments', ({ params }) => {
    log('GET', `/files/${params.id}/comments`)
    return HttpResponse.json(mockState.comments[params.id] || [])
  }),

  http.post('/api/files/:id/comments', async ({ params, request }) => {
    log('POST', `/files/${params.id}/comments`)
    const body = await request.json()
    const c = {
      id: uid('c'),
      anchor: body.anchor,
      author_id: body.author_id,
      body: body.body,
      state: 'open',
      created_at: new Date().toISOString(),
      replies: [],
    }
    ;(mockState.comments[params.id] ||= []).push(c)
    return HttpResponse.json(c)
  }),

  http.put('/api/files/:id/comments/:cid', async ({ params, request }) => {
    log('PUT', `/files/${params.id}/comments/${params.cid}`)
    const patch = await request.json()
    const c = (mockState.comments[params.id] || []).find((x) => x.id === params.cid)
    if (c) Object.assign(c, patch)
    return HttpResponse.json(c || { id: params.cid, ...patch })
  }),

  http.delete('/api/files/:id/comments/:cid', ({ params }) => {
    log('DELETE', `/files/${params.id}/comments/${params.cid}`)
    mockState.comments[params.id] = (mockState.comments[params.id] || []).filter((x) => x.id !== params.cid)
    return HttpResponse.json({ ok: true })
  }),

  http.post('/api/files/:id/comments/:cid/replies', async ({ params, request }) => {
    log('POST', `/files/${params.id}/comments/${params.cid}/replies`)
    const body = await request.json()
    const r = { id: uid('r'), author_id: body.author_id, body: body.body, created_at: new Date().toISOString() }
    const c = (mockState.comments[params.id] || []).find((x) => x.id === params.cid)
    if (c) (c.replies ||= []).push(r)
    return HttpResponse.json(r)
  }),

  // ── Suggestions ──────────────────────────────────────────────────────────
  http.get('/api/files/:id/suggestions', ({ params }) => {
    log('GET', `/files/${params.id}/suggestions`)
    return HttpResponse.json(mockState.suggestions[params.id] || [])
  }),

  http.post('/api/files/:id/suggestions', async ({ params, request }) => {
    log('POST', `/files/${params.id}/suggestions`)
    const b = await request.json()
    const s = {
      id: uid('s'), kind: b.kind, author_id: b.author_id,
      from: b.from, to: b.to, text: b.text,
      state: 'pending', created_at: new Date().toISOString(),
    }
    ;(mockState.suggestions[params.id] ||= []).push(s)
    return HttpResponse.json(s)
  }),

  http.put('/api/files/:id/suggestions/:sid', async ({ params, request }) => {
    log('PUT', `/files/${params.id}/suggestions/${params.sid}`)
    const b = await request.json()
    const s = (mockState.suggestions[params.id] || []).find((x) => x.id === params.sid)
    if (s) Object.assign(s, { state: b.state, reviewer_id: b.reviewer_id })
    return HttpResponse.json(s || { id: params.sid, ...b })
  }),

  // Image upload used by the docs toolbar (returns a fake URL).
  http.post('/api/upload', () =>
    HttpResponse.json({ url: 'http://localhost/uploaded.png' })),
]
