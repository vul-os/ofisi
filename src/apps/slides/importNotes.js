/**
 * src/apps/slides/importNotes.js
 *
 * A record of WHAT A .pptx / .odp IMPORT COULD NOT BRING IN — carried on the
 * deck so the app can be honest about it, both at import and (crucially) again
 * before an export writes over the user's original file.
 *
 * WHY THIS EXISTS. Mirrors sheets/importNotes.js. Our slide model is a
 * positioned-object model: text boxes, raster images, and their geometry import
 * faithfully, but a native PowerPoint TABLE, CHART, SmartArt DIAGRAM, grouped
 * shape, animation, slide transition, or vector/EMF image cannot be represented
 * and is dropped or approximated at import. If we said nothing, the dangerous
 * sequence is: open someone's deck → tweak one slide → "Export as PowerPoint"
 * over the original → their tables/charts are silently gone. Neither Google
 * Slides nor PowerPoint itemises this for you; we do — once at import, and again
 * in the export path — so a user is never surprised by a lossy round-trip.
 *
 * The notes ride inside the saved deck content (like themeId / masters), so they
 * persist across reload and are re-clamped on read (makeSlideImportNotes): every
 * count is a bounded non-negative integer. They are advisory metadata — never
 * markup, never eval'd; the banner/dialog render them as escaped text.
 */

// The feature kinds we detect-and-report as lost/approximated on import.
const KIND_LABELS = Object.freeze({
  tables: 'table',
  charts: 'chart',
  diagrams: 'SmartArt diagram',
  groups: 'grouped shape',
  vectorImages: 'vector/EMF image',
  animations: 'slide with animations',
  transitions: 'slide transition',
})

const KINDS = Object.keys(KIND_LABELS)

const clampInt = (v, max = 100000) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0
}

/**
 * makeSlideImportNotes — build/clamp the record. Returns null when nothing was
 * lost, so a clean import leaves NO overlay on the deck (and a clean export
 * keeps its zero-friction path).
 */
export function makeSlideImportNotes(partial) {
  if (!partial || typeof partial !== 'object') return null
  const notes = {}
  let any = false
  for (const k of KINDS) {
    const n = clampInt(partial[k])
    if (n > 0) { notes[k] = n; any = true }
  }
  if (!any) return null
  if (typeof partial.filename === 'string' && partial.filename) {
    notes.filename = partial.filename.slice(0, 160)
  }
  return notes
}

/** True when the notes describe something the user actually lost. */
export function hasSlideImportLoss(notes) {
  return !!notes && KINDS.some((k) => clampInt(notes[k]) > 0)
}

/** Read + clamp the notes off a deck (null when there is nothing to report). */
export function getSlideImportNotes(deck) {
  return makeSlideImportNotes(deck?.importNotes)
}

/**
 * slideImportLossItems — the itemised, plain-English list (for a banner / the
 * export dialog). Returns [] when nothing was lost.
 */
export function slideImportLossItems(notes) {
  const clean = makeSlideImportNotes(notes)
  if (!clean) return []
  return KINDS.filter((k) => clean[k] > 0).map((k) => {
    const n = clean[k]
    const label = KIND_LABELS[k]
    const plural = n === 1 ? label : `${label}s`
    return `${n} ${plural}`
  })
}

/**
 * slideImportLossSummary — the one-line version for a toast/banner headline.
 * Returns '' when nothing was lost.
 */
export function slideImportLossSummary(notes) {
  const items = slideImportLossItems(notes)
  if (!items.length) return ''
  return `${items.join(', ')} could not be imported — an export from here will not contain them.`
}
