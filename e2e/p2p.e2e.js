/**
 * P2P share E2E (WAVE-25) — the "Collaborate via link" sharer flow in a real
 * browser: generate rw + ro invite links, and confirm the honest E2E-encryption
 * copy is shown. (The two-peer convergence + ro-rejection + crypto-seal are
 * exhaustively covered headless in src/lib/crdt and src/__tests__/msw.)
 */

import { test, expect } from './fixtures.js'

test.describe('P2P "Collaborate via link" (E2E)', () => {
  test('opens the share modal and generates rw + ro invite links', async ({ officePage: page }) => {
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })

    // Open the P2P share modal (Share2 icon button, labelled via its tooltip).
    await page.getByRole('button', { name: /Collaborate via link/i }).click()

    // The modal titled "Collaborate via link (P2P)" surfaces both links.
    await expect(page.getByText('Editor link')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('View-only link')).toBeVisible()
    await expect(page.getByText(/end-to-end encrypted/i)).toBeVisible()

    // Both invite links contain the #vp2p= capability fragment.
    const values = await page.locator('input[readonly]').evaluateAll(
      (els) => els.map((e) => e.value).filter((v) => /#vp2p=/.test(v)),
    )
    expect(values.length).toBeGreaterThanOrEqual(2)
  })

  test('the ro invite link is well-formed and its fragment survives navigation', async ({ officePage: page }) => {
    // Mint a ro link from the share modal.
    await page.goto('/docs/doc1')
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: /Collaborate via link/i }).click()
    await expect(page.getByText('View-only link')).toBeVisible({ timeout: 10_000 })

    const roLink = await page.locator('input[readonly]').evaluateAll((els) => {
      // The view-only row is the last link input in the modal.
      const vals = els.map((e) => e.value).filter((v) => /#vp2p=/.test(v))
      return vals[vals.length - 1]
    })
    expect(roLink).toMatch(/#vp2p=/)

    // The join path is triggered by the #vp2p= fragment. We assert the invite
    // is recognised as a join trigger (fragment survives navigation + the editor
    // re-opens). The full read-only ENFORCEMENT — a ro peer's ops rejected, the
    // editor set non-editable, convergence, and the E2E crypto seal — requires a
    // live peering transport and is covered headless with an injected fabric in
    // src/lib/crdt/__tests__/p2pSession.test.js and
    // src/__tests__/msw/p2pShare.integration.test.jsx.
    const frag = roLink.split('#')[1]
    await page.goto(`/docs/doc1#${frag}`)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 15_000 })
    const hash = await page.evaluate(() => window.location.hash)
    expect(hash).toContain('vp2p=')
  })
})
