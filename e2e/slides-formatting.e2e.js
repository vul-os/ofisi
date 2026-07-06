/**
 * Slides formatting E2E (WAVE-59, wave-48 toolbar) — real-browser flows for the
 * slide text-formatting controls added in wave-48: font-family, highlight, and
 * numbered (ordered) list. Hermetic harness (vite preview + mocked backend); the
 * slide's TipTap/ProseMirror editor runs LOCALLY in the page, so we assert the
 * real marks/nodes it emits into the slide body.
 *
 * How the slide editor is driven here: the deck is deep-linked; the active
 * slide's HTML is edited in a live ProseMirror surface (`.tiptap .ProseMirror`).
 * We select the slide text (Ctrl+A) and click the wave-48 toolbar controls:
 *   • Font family — a Menu; picking "Georgia" applies textStyle{fontFamily} →
 *     an inline `font-family` style on a <span> in the slide body.
 *   • Highlight   — a color <input>; setting a value toggles a <mark> highlight.
 *   • Numbered    — the "Numbered list" button turns the block into an <ol>.
 */

import { test, expect } from './fixtures.js'

const DECK = {
  id: 'deck1', name: 'Pitch', type: 'slide',
  content: {
    themeId: 'obsidian', theme: 'black', transition: 'slide',
    slides: [{ id: 's1', title: 'Intro', content: '<p>Highlight me please</p>', notes: '' }],
    masters: null, customTheme: null,
  },
}

async function openDeck(page) {
  await page.route(/\/api\/files\/deck1$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DECK) })
  })
  await page.route('**/api/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([DECK]) })
  })
  await page.goto('/slides/deck1')
  await expect(page.getByLabel('Presentation title')).toHaveValue('Pitch', { timeout: 20_000 })
  // The slide-body editor surface.
  await expect(page.locator('.tiptap .ProseMirror')).toBeVisible({ timeout: 15_000 })
}

const body = (page) => page.locator('.tiptap .ProseMirror').first()

// Type text into the (initially empty) slide body and select it, so a mark/list
// op has a real selection to act on. On a deep-link the seeded slide content
// re-syncs only on a slide switch, so we author the text live instead.
async function typeAndSelectAll(page) {
  const editor = body(page)
  await editor.click()
  await page.keyboard.type('Highlight me please')
  await expect(editor).toContainText('Highlight me please')
  await page.keyboard.press('ControlOrMeta+A')
  return editor
}

test.describe('Slides text formatting (wave-48) — E2E', () => {
  test('font family — applying Georgia renders an inline font-family style', async ({ officePage: page }) => {
    await openDeck(page)
    const editor = await typeAndSelectAll(page)

    // Open the font-family menu (labelled "Font family: …") and pick Georgia.
    await page.getByRole('button', { name: /Font family:/i }).click()
    await page.getByRole('menuitem', { name: 'Georgia' }).click()

    // A <span> in the slide body now carries the Georgia font-family stack.
    await expect(editor.locator('span[style*="font-family"]').first())
      .toHaveAttribute('style', /Georgia/i)
  })

  test('highlight — setting a highlight colour wraps the selection in <mark>', async ({ officePage: page }) => {
    await openDeck(page)
    const editor = await typeAndSelectAll(page)

    // The highlight control is a hidden color <input> inside the "Highlight
    // color" label. It's React-controlled, so we set the value through React's
    // native value setter before dispatching input/change — otherwise React's
    // value tracker swallows the synthetic event and onChange never fires.
    const hi = page.getByLabel('Choose highlight color')
    await hi.evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set
      setter.call(el, '#ffe066')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // The Highlight extension renders a <mark> around the highlighted text.
    await expect(editor.locator('mark')).toHaveCount(1)
    await expect(editor.locator('mark')).toContainText('Highlight me')
  })

  test('numbered list — the toolbar button turns the block into an <ol>', async ({ officePage: page }) => {
    await openDeck(page)
    const editor = await typeAndSelectAll(page)

    await page.getByRole('button', { name: 'Numbered list' }).click()

    // The paragraph became an ordered list item.
    await expect(editor.locator('ol')).toHaveCount(1)
    await expect(editor.locator('ol li')).toContainText('Highlight me please')
  })
})
