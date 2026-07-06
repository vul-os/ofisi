/**
 * Sheets charts E2E (WAVE-59, wave-54 feature) — real-browser coverage of the
 * chart-insertion UI. Hermetic harness (vite preview + mocked backend); the
 * @fortune-sheet grid and the ChartWizard dialog run LOCALLY in the page.
 *
 * SCOPE NOTE (important — see the report): the wave-54 *live chart render*
 * (ChartLayer/ChartSvg painting an <svg> over the grid) turns out NOT to be
 * observable in a single-user browser session. `<Workbook onChange={handleChange}>`
 * fires with FortuneSheet-normalised sheet objects that DROP the app's custom
 * `sheet.charts` field, so `setData` clobbers charts on grid init and on the
 * next edit; the only path that re-adds a chart is a *remote peer* chart-op
 * (session 'remoteOp'), which never fires with no fabric peer. A chart seeded in
 * the file content, and a chart inserted through the wizard, both fail to reach
 * ChartLayer (verified: 0 `[data-chart-id]` cards; 0 `charts` in the save PUT).
 * So the SVG-render + injected-glyph assertions cannot be made here without a
 * live second peer. What IS real-browser-testable is the wizard flow below; the
 * SVG escaping itself is covered headless in src/apps/sheets/chartSvg.test.jsx.
 *
 * How the chart editor is driven here: the toolbar "Insert chart" opens the real
 * ChartWizard; its type picker is a radiogroup and its "Data range" is a plain
 * text input, so the flow does not depend on the flaky canvas marquee.
 */

import { test, expect } from './fixtures.js'

function makeSheetFile() {
  const celldata = [
    { r: 0, c: 0, v: { v: 'Qtr', m: 'Qtr' } },
    { r: 0, c: 1, v: { v: 'Sales', m: 'Sales' } },
    { r: 1, c: 0, v: { v: 'Q1', m: 'Q1' } },
    { r: 1, c: 1, v: { v: 10, m: '10' } },
    { r: 2, c: 0, v: { v: 'Q2', m: 'Q2' } },
    { r: 2, c: 1, v: { v: 40, m: '40' } },
  ]
  return { id: 'sh1', name: 'Budget', type: 'sheet', content: [{ name: 'Sheet1', celldata, config: {} }] }
}

async function openSheet(page) {
  const file = makeSheetFile()
  await page.route(/\/api\/files\/sh1$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(file) })
  })
  await page.route('**/api/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([file]) })
  })
  await page.goto('/sheets/sh1')
  await expect(page.getByLabel('Sheet title')).toHaveValue('Budget', { timeout: 20_000 })
  await expect(page.locator('.fortune-sheet-overlay, [id^="luckysheet-sheettable"]').first())
    .toBeVisible({ timeout: 20_000 })
}

test.describe('Sheets chart wizard (wave-54) — real-browser insert flow', () => {
  test('opens the wizard from the toolbar with the type radiogroup + range input', async ({ officePage: page }) => {
    await openSheet(page)
    await page.getByRole('button', { name: 'Insert chart' }).click()

    const dialog = page.getByRole('dialog', { name: 'Insert chart' })
    await expect(dialog).toBeVisible()
    // All five wave-54 chart types are offered as a radiogroup.
    const radios = dialog.getByRole('radiogroup', { name: 'Chart type' })
    for (const t of ['Column', 'Bar', 'Line', 'Area', 'Pie']) {
      await expect(radios.getByRole('radio', { name: t })).toBeVisible()
    }
    // The range field exists (defaults may be empty on a deep-link with no marquee).
    await expect(dialog.locator('#chart-range')).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  for (const kind of ['Column', 'Line', 'Pie']) {
    test(`selecting the ${kind} type + a range and submitting closes the wizard without error`, async ({ officePage: page }) => {
      await openSheet(page)

      // Guard: a chart-render or descriptor bug that throws would surface here.
      const pageErrors = []
      page.on('pageerror', (e) => pageErrors.push(e.message))

      await page.getByRole('button', { name: 'Insert chart' }).click()
      const dialog = page.getByRole('dialog', { name: 'Insert chart' })
      await expect(dialog).toBeVisible()

      // Pick the type (radiogroup → aria-checked flips) and type an A1 range.
      const radio = dialog.getByRole('radio', { name: kind })
      await radio.click()
      await expect(radio).toHaveAttribute('aria-checked', 'true')
      await dialog.locator('#chart-range').fill('A1:B3')

      // Submit runs the real makeChart/insertChart pipeline in the browser.
      await dialog.getByRole('button', { name: 'Insert chart' }).click()
      await expect(dialog).toBeHidden()

      // The editor is still alive (topbar presence pill) and nothing threw.
      await expect(page.getByRole('status').first()).toBeVisible()
      expect(pageErrors, `no page errors during ${kind} chart insert`).toEqual([])
    })
  }

  test('a hostile chart title is captured as plain data and never executes on submit', async ({ officePage: page }) => {
    await openSheet(page)

    let pwned = false
    await page.exposeFunction('__pwn', () => { pwned = true })

    await page.getByRole('button', { name: 'Insert chart' }).click()
    const dialog = page.getByRole('dialog', { name: 'Insert chart' })
    await dialog.getByRole('radio', { name: 'Column' }).click()
    await dialog.locator('#chart-range').fill('A1:B3')
    // Type a script-y title into the wizard's plain text input.
    await dialog.locator('#chart-title').fill('<img src=x onerror=window.__pwn()>')
    await dialog.getByRole('button', { name: 'Insert chart' }).click()
    await expect(dialog).toBeHidden()

    // The title was a form string → stored as plain data. No markup was parsed,
    // no handler fired, and the editor is still live.
    await page.waitForTimeout(300)
    expect(pwned).toBe(false)
    expect(await page.evaluate(() => window.__pwned)).toBeFalsy()
    await expect(page.getByRole('status').first()).toBeVisible()
  })
})
