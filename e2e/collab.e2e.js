/**
 * Collaboration E2E — version history (with wave-14 restore gate), comments,
 * and suggestions, driven through the real browser UI against a mocked backend.
 */

import { test, expect } from '@playwright/test'
import { installBackend } from './fixtures.js'

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
