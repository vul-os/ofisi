/**
 * sanitize — single source of truth for DOMPurify configuration.
 * ----------------------------------------------------------------------------
 * Previously every surface that rendered user/peer HTML carried its own inline
 * DOMPurify config block (SlidesEditor, SlidePreview, PresenterView,
 * slidesExport, …). Those blocks had drifted apart (some forbade <iframe>, some
 * had a shorter on*-handler list), which is exactly how an XSS gap sneaks in.
 *
 * This module consolidates them into named, audited configs so there is one
 * place to reason about what HTML we let through.
 *
 *   sanitizeRichHtml(html)   — slide / rich-document HTML (Tiptap / Reveal tags)
 *   sanitizeSlideHtml(html)  — alias of sanitizeRichHtml (slides surfaces)
 *   stripHtml(html)          — sanitize, then return text content only
 *
 * Behaviour note: the canonical rich config is the *strictest* of the historic
 * variants (it forbids <iframe> and the full set of inline event handlers), so
 * consolidating onto it never loosens sanitisation — only tightens the few
 * surfaces that lagged behind. Legitimate Tiptap/Reveal markup is unaffected.
 */

import DOMPurify from 'dompurify'

// Inline event-handler attributes we always strip (defence-in-depth — DOMPurify
// already removes unknown on* handlers, but listing them is explicit + audited).
const FORBID_EVENT_ATTR = [
  'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
  'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress',
]

// Rich HTML (slides, rich documents): allow the standard HTML profile but
// forbid anything that can execute code or capture input.
export const RICH_HTML_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: FORBID_EVENT_ATTR,
}

/** Sanitise rich HTML (Tiptap / Reveal slide content). */
export function sanitizeRichHtml(html) {
  return DOMPurify.sanitize(html ?? '', RICH_HTML_CONFIG)
}

// ── WAVE-52: Docs HTML sanitiser (tables) ────────────────────────────────────
// Docs import (.html / .docx → _html) and HTML/Markdown export flow user- and
// peer-supplied markup through TipTap. The standard HTML profile already keeps
// the exact table tags we need — <table>/<thead>/<tbody>/<tr>/<th>/<td> — plus
// the structural attributes colspan / rowspan / scope, and it strips on*
// handlers. What it does NOT catch is a dangerous *value* inside an otherwise-
// allowed `style` attribute (e.g. `<td style="background:url(javascript:…)">`).
//
// We keep the allow-list deliberately tight: rather than widen it, we ADD a
// value-level guard that drops any `style` carrying an executable/exfiltrating
// construct (url()/expression()/javascript:/@import/behavior/-moz-binding),
// while preserving the benign inline styles Docs itself emits (line-height,
// text-align, page-break-*, font-family/size). This tightens sanitisation —
// it never loosens it — and covers the table-cell style-injection vector.
const DANGEROUS_CSS = /url\s*\(|expression\s*\(|javascript:|@import|behaviou?r\s*:|-moz-binding|\\/i

let _docHookInstalled = false
function ensureDocStyleHook() {
  if (_docHookInstalled) return
  _docHookInstalled = true
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style' && DANGEROUS_CSS.test(data.attrValue || '')) {
      data.keepAttr = false
    }
  })
}

// Same policy surface as RICH_HTML_CONFIG (tables already survive the html
// profile); the CSS-value guard is added via the hook above.
export const DOC_HTML_CONFIG = RICH_HTML_CONFIG

/**
 * Sanitise Docs HTML (import + export). Preserves table structure + colspan/
 * rowspan/scope; strips scripts, on* handlers, and dangerous inline-style
 * values (defeats <td style="…javascript:…"> style-injection).
 */
export function sanitizeDocHtml(html) {
  ensureDocStyleHook()
  return DOMPurify.sanitize(html ?? '', DOC_HTML_CONFIG)
}

/** Alias — slides surfaces read more clearly as "sanitizeSlideHtml". */
export const sanitizeSlideHtml = sanitizeRichHtml

/** Sanitise, then return plain text content only (no markup). */
export function stripHtml(html) {
  const div = document.createElement('div')
  // Sanitise before DOM assignment so text extraction can't execute payloads.
  div.innerHTML = sanitizeRichHtml(html)
  return div.textContent || div.innerText || ''
}

// ── Narrower, context-specific allow-lists ──────────────────────────────────
// These are intentionally tighter than RICH_HTML_CONFIG — each surface only
// renders the exact tags it produces. Centralised here so all DOMPurify policy
// lives in one audited file.

// Search-result highlighting: only the <mark> wrapper survives.
export const SEARCH_HIGHLIGHT_CONFIG = {
  ALLOWED_TAGS: ['mark'],
  ALLOWED_ATTR: ['class'],
}

/** Sanitise search-result HTML, keeping only <mark> highlights. */
export function sanitizeSearchHighlight(html) {
  return DOMPurify.sanitize(html ?? '', SEARCH_HIGHLIGHT_CONFIG)
}

/** Strip all markup, returning plain text (captions, defence-in-depth). */
export function sanitizeToText(text) {
  if (typeof text !== 'string') return ''
  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
}
