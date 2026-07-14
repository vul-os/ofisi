/**
 * Collaboration E2E — version history (with wave-14 restore gate), comments,
 * suggestions, and the WAVE37 server-authoritative collab relay, driven through
 * the real browser UI against a mocked backend.
 */

import { test, expect } from '@playwright/test'
import { installBackend } from './fixtures.js'

/**
 * Mock the WAVE37 server-collab relay (/v1/documents/:id/collab/*) in-browser.
 * These live OUTSIDE /api, so they need their own page.route. We model:
 *   • GET  /collab/state  — late-joiner bootstrap (empty or seeded op log)
 *   • POST /collab/ops    — op push; editor-gated (opts.role 'viewer' → 403)
 *   • GET  /collab/stream — the SSE endpoint; we return an open, silent stream so
 *     the session goes "live" without a real event source in the harness.
 * Returns a live op log the test can assert against.
 */
async function installCollabRelay(page, { role = 'owner' } = {}) {
  const relay = { ops: [], seq: 0, posts: 0, presence: [] }
  const CAN_EDIT = new Set(['owner', 'editor'])

  // Presence relay (VIEWER+): ephemeral, never persisted. Record posts so a test
  // can assert the cursor was broadcast over the server path. Identity would be
  // stamped server-side; the mock just records what the client sent.
  await page.route('**/v1/documents/*/collab/presence', async (route) => {
    let body = {}
    try { body = route.request().postDataJSON() || {} } catch { /* none */ }
    relay.presence.push(body)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  await page.route('**/v1/documents/*/collab/state', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ seq: relay.seq, snap: null, ops: relay.ops }),
    }))

  await page.route('**/v1/documents/*/collab/ops', async (route) => {
    relay.posts++
    if (!CAN_EDIT.has(role)) {
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'your role does not permit modifying content' }),
      })
    }
    let body = {}
    try { body = route.request().postDataJSON() || {} } catch { /* none */ }
    for (const op of body.ops || []) { relay.seq++; relay.ops.push({ seq: relay.seq, origin: body.origin, op }) }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, accepted: (body.ops || []).length, seq: relay.seq }),
    })
  })

  // Keep the SSE stream open but silent so EventSource.onopen fires (session goes
  // live) without a real stream. A hanging fulfill would stall navigation, so we
  // return an immediate empty event-stream body.
  await page.route('**/v1/documents/*/collab/stream', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': ok\n\n' }))

  return relay
}

test.describe('Version history + wave-14 restore gate (E2E)', () => {
  test('owner can restore a version', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Version history' }).first().click()
    await expect(page.getByText('First draft')).toBeVisible()

    await page.getByTitle('Restore this version').first().click()
    // Confirm inside the dialog.
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: /^Restore$/ }).click()
    await expect(page.getByText('Version restored')).toBeVisible()
  })

  test('WAVE-14: a viewer is refused restore (403) and sees an error', async ({ page }) => {
    await installBackend(page, { role: 'viewer' })
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Version history' }).first().click()
    await expect(page.getByText('First draft')).toBeVisible()

    await page.getByTitle('Restore this version').first().click()
    await page.getByRole('dialog').getByRole('button', { name: /^Restore$/ }).click()

    await expect(page.getByText(/forbidden/i)).toBeVisible()
    await expect(page.getByText('Version restored')).toHaveCount(0)
  })
})

test.describe('Comments (E2E)', () => {
  test('add a comment, then resolve it', async ({ page }) => {
    const state = await installBackend(page, { role: 'owner' })
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Comments' }).first().click()
    const box = page.getByPlaceholder('Add a comment…')
    await expect(box).toBeVisible()
    await box.fill('Please review this section')
    await page.getByRole('button', { name: /^Comment$/ }).click()

    await expect(page.getByText('Please review this section')).toBeVisible()

    // Resolve the comment (the Resolve action lives on the comment card).
    await page.getByRole('button', { name: /Resolve/i }).first().click()
    // The resolved comment shows a "Resolved" status pill. Scope to the badge
    // (exact text) so we don't collide with the "Resolved" filter TAB that also
    // appears once a resolved comment exists (strict-mode ambiguity otherwise).
    await expect(page.getByText('Resolved', { exact: true }).first()).toBeVisible()
  })
})

/**
 * Server-authoritative collab, in the real browser, over the STRUCTURE-AWARE
 * document format (Yjs — see src/lib/crdt/ydoc.js).
 *
 * The document no longer travels as a plain-text diff (which could not carry
 * formatting and whose offsets did not address positions in a structured
 * document). An op on the wire is now a Yjs update envelope {y:1,u:<base64>}, and
 * that is asserted here so a regression back to the text format is caught in the
 * bundle the user actually runs, not just in unit tests.
 */
test.describe('Server-authoritative collab (E2E smoke)', () => {
  test('an editor typing in the doc pushes structure-aware ops to the server relay', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    const relay = await installCollabRelay(page, { role: 'owner' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.locator('.ProseMirror').click()
    await page.keyboard.type(' plus a server-synced edit')

    await expect.poll(() => relay.ops.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(relay.posts).toBeGreaterThan(0)

    // Every op is a Yjs update envelope — never a legacy RGA TextOp ({k,id,p,v,t}),
    // which is the format that could not carry a heading, a table or a bold mark.
    for (const rec of relay.ops) {
      expect(rec.op).toMatchObject({ y: 1 })
      expect(typeof rec.op.u).toBe('string')
      expect(rec.op.k).toBeUndefined()
    }
  })

  test('formatting a selection publishes the change (the text-diff transport could not)', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    const relay = await installCollabRelay(page, { role: 'owner' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    // Select existing text and bold it — NO text changes, only a mark.
    await page.locator('.ProseMirror').click()
    await page.keyboard.press('ControlOrMeta+A')
    const opsBefore = relay.ops.length
    await page.getByTitle(/Bold/i).first().click()

    // The mark itself is published. Under the old plain-text transport getText()
    // was identical before and after, so NOTHING was sent and the peer never saw
    // the formatting at all.
    await expect.poll(() => relay.ops.length, { timeout: 10_000 }).toBeGreaterThan(opsBefore)
    await expect(page.locator('.ProseMirror strong')).toHaveCount(1)
  })

  test('live presence: the local caret is broadcast to the server presence relay', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    const relay = await installCollabRelay(page, { role: 'owner' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.locator('.ProseMirror').click()
    await page.keyboard.type('hello')

    await expect.poll(() => relay.presence.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const withCursor = relay.presence.find((p) => p.cursor && p.cursor.type === 'doc' && typeof p.cursor.from === 'number')
    expect(withCursor).toBeTruthy()
  })

  test('WAVE-14 gate: a viewer\'s ops are refused (403) and the doc stays editable locally', async ({ page }) => {
    await installBackend(page, { role: 'viewer' })
    const relay = await installCollabRelay(page, { role: 'viewer' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.locator('.ProseMirror').click()
    await page.keyboard.type(' viewer tries to edit')

    // The session attempted a push (the server saw it) but nothing landed in the
    // log — the viewer is read-only at the relay. The local edit still shows.
    await expect.poll(() => relay.posts, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(relay.ops.length).toBe(0)
    await expect(page.locator('.ProseMirror')).toContainText('viewer tries to edit')
  })
})
