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
// allowed `style` attribute (e.g. `<td style="background:url(javascript:…)">`,
// a `position:fixed` full-viewport click-jacking overlay, or a fetch via the
// CSS `image()` / `src()` functions that carry no literal `url(` token).
//
// WAVE-53 (hardening): the original guard was a *blocklist* regex
// (url()/expression()/javascript:/@import/…). A blocklist over CSS is brittle —
// it missed `position:fixed`/`position:absolute` overlays entirely, and the
// fetch-capable `image()`/`src()` image functions slip past a `url(`-only match.
// We replace it with a property *allow-list*: parse the declaration and keep
// ONLY the inline properties Docs/TipTap actually emit (colour, font, spacing,
// alignment, borders, table sizing, page-break). Anything else — positioning,
// content:, behavior:, animation, any fetch function, any future-dangerous
// property — is dropped. This is strictly tighter than before and fail-closed
// by construction (unknown property ⇒ dropped), while every legitimate Docs
// style survives. A value inside an allowed property that still smells of a
// fetch/exec construct (url()/expression()/image()/… ) drops that one
// declaration too, belt-and-braces.
//
// Allow-list scoped to what StarterKit + Color/Highlight/FontSize/FontFamily/
// TextAlign/Table/footnotes emit, plus the benign layout styles imported .docx/
// .html carry. Kept intentionally small; widen only with review.
const SAFE_CSS_PROPS = new Set([
  'color', 'background-color', 'background',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-decoration', 'text-decoration-line', 'text-indent',
  'text-transform', 'vertical-align', 'white-space', 'direction',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius',
  'border-collapse', 'border-spacing',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'page-break-before', 'page-break-after', 'page-break-inside',
  'break-before', 'break-after', 'break-inside',
  'list-style-type', 'list-style-position',
])

// A declaration VALUE is rejected outright (even for an allow-listed property)
// if it carries a fetch/exec construct. `background`/`background-color` are on
// the allow-list for solid colours; this stops `background:url(…)` /
// `background:image(…)` from riding in on them. Scheme-agnostic: any external
// or javascript: fetch is refused. Also catches CSS escapes (`\`) which are an
// obfuscation channel with no legitimate use in the styles Docs emits.
const DANGEROUS_CSS_VALUE =
  /url\s*\(|(?:^|[^-\w])(?:image|image-set|-webkit-image-set|cross-fade|paint|src|element)\s*\(|expression\s*\(|javascript:|@import|behaviou?r\s*:|-moz-binding|\\/i

// Parse a `style` attribute value, keep only allow-listed properties whose
// value is free of fetch/exec constructs. Returns the rebuilt (possibly empty)
// declaration string. Fail-closed: anything not understood is dropped.
export function sanitizeStyleValue(styleValue) {
  if (typeof styleValue !== 'string' || !styleValue) return ''
  const kept = []
  for (const decl of styleValue.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const value = decl.slice(idx + 1).trim()
    if (!prop || !value) continue
    if (!SAFE_CSS_PROPS.has(prop)) continue          // property not allow-listed → drop
    // Strip CSS comments before the fetch/exec check so `u/**/rl(` obfuscation
    // can't hide a construct from the regex. (Such forms don't tokenise as a
    // real url() in a browser, but we refuse them anyway — fail-closed.)
    const probe = value.replace(/\/\*[\s\S]*?\*\//g, '')
    if (DANGEROUS_CSS_VALUE.test(probe)) continue     // fetch/exec construct in value → drop
    kept.push(`${prop}:${value}`)
  }
  return kept.join(';')
}

let _docHookInstalled = false
function ensureDocStyleHook() {
  if (_docHookInstalled) return
  _docHookInstalled = true
  // NOTE: DOMPurify hooks are global to the singleton. Scoping by a marker set
  // just before each sanitizeDocHtml() call keeps this guard from silently
  // changing behaviour of the other sanitize* surfaces (slides/search) that do
  // not opt in. When active, we rewrite the style attr to its safe subset
  // (never a wholesale keepAttr=false, so a single bad declaration no longer
  // discards the element's benign styling).
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (!_docStyleGuardActive) return
    if (data.attrName !== 'style') return
    const safe = sanitizeStyleValue(data.attrValue || '')
    if (safe) {
      data.attrValue = safe
    } else {
      data.keepAttr = false
    }
  })
}

// Flag toggled around sanitizeDocHtml so the shared hook only enforces the Docs
// style policy for Docs content (import/export), not for every DOMPurify call.
let _docStyleGuardActive = false

// Same policy surface as RICH_HTML_CONFIG (tables already survive the html
// profile); the CSS-value guard is added via the hook above.
export const DOC_HTML_CONFIG = RICH_HTML_CONFIG

/**
 * Sanitise Docs HTML (import + export). Preserves table structure + colspan/
 * rowspan/scope; strips scripts, on* handlers, and reduces every inline `style`
 * to an allow-list of benign properties (defeats <td style="…javascript:…">
 * style-injection, `position:fixed` overlays, and fetch-function exfiltration).
 */
export function sanitizeDocHtml(html) {
  ensureDocStyleHook()
  _docStyleGuardActive = true
  try {
    return DOMPurify.sanitize(html ?? '', DOC_HTML_CONFIG)
  } finally {
    _docStyleGuardActive = false
  }
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
