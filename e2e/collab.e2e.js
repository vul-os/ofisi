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
  const relay = { ops: [], seq: 0, posts: 0 }
  const CAN_EDIT = new Set(['owner', 'editor'])

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
    await expect(page.getByText('Resolved')).toBeVisible()
  })
})

test.describe('WAVE37 server-authoritative collab (E2E smoke)', () => {
  test('an editor typing in the doc pushes ops to the server relay', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    const relay = await installCollabRelay(page, { role: 'owner' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    // Type into the editor — the ServerCollabSession diffs this to CRDT ops and
    // POSTs them to /collab/ops (batched on a short debounce).
    await page.locator('.ProseMirror').click()
    await page.keyboard.type(' plus a server-synced edit')

    // The authoritative op log received the edit through the real session path.
    await expect.poll(() => relay.ops.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(relay.posts).toBeGreaterThan(0)
  })

  test('WAVE-14 gate: a viewer\'s ops are refused (403) and the doc stays editable locally', async ({ page }) => {
    await installBackend(page, { role: 'viewer' })
    // Relay rejects this viewer's op push with 403 (editor-gated).
    const relay = await installCollabRelay(page, { role: 'viewer' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.locator('.ProseMirror').click()
    await page.keyboard.type(' viewer tries to edit')

    // The session attempted a push (server saw it) but nothing landed in the log
    // — the viewer is read-only at the relay. The local edit still shows (the
    // editor degrades to local-only, autosave path intact) — no crash.
    await expect.poll(() => relay.posts, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(relay.ops.length).toBe(0)
    await expect(page.locator('.ProseMirror')).toContainText('viewer tries to edit')
  })
})
