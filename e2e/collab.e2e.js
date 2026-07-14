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
 * Live co-editing is FLAG-GATED (VITE_DOCS_COLLAB, see src/lib/flags.js) and the
 * default build ships it OFF, because the sync transport diffs the document as
 * plain text and can place a remote change at the wrong position in a structured
 * document. These tests pin the gate as the bundle actually ships it: no ops
 * leave the tab, and the UI says co-editing is off rather than pretending.
 * (When the transport is structure-aware and the flag defaults on, these become
 * assertions that ops DO flow — see the collab suite in src/apps/docs.)
 */
test.describe('Docs live co-editing gate (E2E)', () => {
  test('with co-editing off, typing pushes NO ops to the server relay', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    const relay = await installCollabRelay(page, { role: 'owner' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await page.locator('.ProseMirror').click()
    await page.keyboard.type(' a local-only edit')
    await page.waitForTimeout(1500) // well past the old publish debounce

    // Nothing was sent, and nothing was even requested: no transport was opened.
    expect(relay.posts).toBe(0)
    expect(relay.ops.length).toBe(0)
    // The edit is in the document (single-user editing is unaffected).
    await expect(page.locator('.ProseMirror')).toContainText('a local-only edit')
  })

  test('the UI states plainly that live co-editing is off', async ({ page }) => {
    await installBackend(page, { role: 'owner' })
    await installCollabRelay(page, { role: 'owner' })

    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    await expect(page.getByTestId('collab-off-pill')).toContainText(/live co-editing off/i)

    // The share dialog says what sharing does and does not do, and offers no
    // P2P invite link (a link that could never sync).
    await page.getByRole('button', { name: /Share — with people/i }).click()
    await expect(page.getByTestId('live-collab-notice')).toContainText(/not appear in real time/i)
    await expect(page.getByRole('button', { name: /Share via link \(P2P\)/i })).toHaveCount(0)
  })
})
