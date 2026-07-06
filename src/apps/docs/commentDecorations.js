/**
 * commentDecorations.js — WAVE-45
 *
 * Comment-anchor highlighting + click-to-jump for the Docs editor.
 *
 * Comments (OFFICE-26) are anchored to a ProseMirror position range
 * `anchor.from` / `anchor.to` (captured from `editor.state.selection` when the
 * comment was created — these are PM doc positions, not plain-text char
 * offsets). Historically nothing rendered them in the doc body; a comment was
 * only visible in the side panel. This extension:
 *
 *   1. Renders a subtle inline highlight over each open comment's anchor range
 *      via ProseMirror decorations.
 *   2. Maps those decorations through document edits so the highlight follows
 *      the text as it moves (insertions/deletions before the anchor shift it).
 *   3. Detects when an anchor's text was fully deleted (range collapsed) and
 *      surfaces it as "orphaned" instead of crashing or highlighting nothing.
 *   4. Enables click-to-jump both ways: clicking a highlight fires an
 *      `onActivate(commentId)` callback (panel focuses the comment); the editor
 *      exposes helpers to scroll+flash a given comment's anchor.
 *
 * How anchors map to decorations and survive edits
 * -------------------------------------------------
 * Each render we build a fresh `DecorationSet` from the current comment list,
 * clamping every `[from,to]` to the live document size. On every transaction we
 * `decorations.map(tr.mapping, tr.doc)` — ProseMirror's position mapping — so a
 * highlight tracks its text through concurrent edits without us recomputing
 * offsets. We recompute from scratch (via the meta channel) only when the
 * comment list itself changes (add/resolve/delete) or a jump/flash is requested.
 *
 * Best-effort remap-back: after mapping, `readMappedRanges(view)` reports the
 * current live `[from,to]` for each decoration so the caller can persist the
 * moved positions back into the CommentStore (`remapAnchors`). A range that
 * collapsed to zero width is reported as `null` → the store marks it orphaned.
 */

import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const COMMENT_PLUGIN_KEY = new PluginKey('commentDecorations')

// Meta payloads the plugin understands.
//   { comments: [...] }          → rebuild decorations from the comment list
//   { flash: commentId }         → add a transient flash class to that anchor
//   { clearFlash: commentId }    → remove the transient flash class
export const COMMENT_META = 'commentDecorations'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no ProseMirror runtime needed)
// ---------------------------------------------------------------------------

/**
 * Clamp a comment anchor range to a valid, non-empty span inside a doc of
 * `docSize` (ProseMirror doc.content.size). Returns null when the anchor is
 * missing, orphaned, not a text range, or collapses to nothing after clamping
 * (its text was deleted) — the caller treats null as "orphaned, don't render".
 *
 * @param {object} anchor   comment.anchor  { type, from, to, orphaned }
 * @param {number} docSize  editor.state.doc.content.size
 * @returns {{from:number,to:number}|null}
 */
export function clampAnchor(anchor, docSize) {
  if (!anchor || anchor.orphaned) return null
  if (anchor.type !== 'text_range') return null
  if (typeof anchor.from !== 'number' || typeof anchor.to !== 'number') return null
  // Positions 1..docSize are valid content positions (0 is before the doc).
  let from = Math.max(1, Math.min(anchor.from, docSize))
  let to = Math.max(1, Math.min(anchor.to, docSize))
  if (to < from) [from, to] = [to, from]
  if (to <= from) return null // collapsed → anchored text is gone
  return { from, to }
}

/**
 * Build the plain decoration descriptors for a comment list against a doc of
 * `docSize`. Returns `{ specs, orphans }` where specs is an array of
 * `{ commentId, from, to, resolved }` for renderable anchors and orphans is an
 * array of commentIds whose anchor collapsed. Kept separate from Decoration
 * construction so the mapping logic is unit-testable without pm-view.
 *
 * Resolved comments are still described (so a resolved highlight can render
 * more faintly) but callers may choose to skip them.
 */
export function buildDecorationSpecs(comments, docSize) {
  const specs = []
  const orphans = []
  for (const c of comments || []) {
    if (!c || !c.anchor) continue
    const range = clampAnchor(c.anchor, docSize)
    if (!range) {
      // Only report as orphaned if it *looks* like a text anchor that lost its
      // text — non-text anchors (slide/cell) simply aren't rendered here.
      if (c.anchor.type === 'text_range') orphans.push(c.id)
      continue
    }
    specs.push({
      commentId: c.id,
      from: range.from,
      to: range.to,
      resolved: c.state === 'resolved',
    })
  }
  return { specs, orphans }
}

// ---------------------------------------------------------------------------
// Decoration construction (needs pm-view Decoration)
// ---------------------------------------------------------------------------

function specToDecoration(spec, activeId) {
  const classes = ['comment-highlight']
  if (spec.resolved) classes.push('comment-highlight-resolved')
  if (spec.commentId === activeId) classes.push('comment-highlight-active')
  return Decoration.inline(
    spec.from,
    spec.to,
    {
      class: classes.join(' '),
      'data-comment-id': spec.commentId,
    },
    // inclusiveStart/End:false so typing at the very edge of a highlight does
    // not extend the comment span (matches editor intuition).
    { inclusiveStart: false, inclusiveEnd: false },
  )
}

function buildDecorationSet(doc, comments, activeId, flashId) {
  const { specs } = buildDecorationSpecs(comments, doc.content.size)
  const decos = []
  for (const spec of specs) {
    // Skip resolved highlights entirely unless they're the active/flashed one
    // (resolved comments shouldn't clutter the page, but a click-jump to one
    // should still show where it was).
    if (spec.resolved && spec.commentId !== activeId && spec.commentId !== flashId) continue
    try {
      const d = specToDecoration(spec, activeId)
      decos.push(d)
      if (spec.commentId === flashId) {
        // A second, whole-range decoration carrying the flash class so the CSS
        // animation applies without disturbing the base highlight class set.
        decos.push(Decoration.inline(spec.from, spec.to, { class: 'comment-highlight-flash' }))
      }
    } catch {
      // Defensive: a bad range shouldn't nuke the whole set.
    }
  }
  return DecorationSet.create(doc, decos)
}

// ---------------------------------------------------------------------------
// Read mapped ranges back out (for best-effort persist to the store)
// ---------------------------------------------------------------------------

/**
 * Read the comment id off a ProseMirror decoration. Inline decorations expose
 * their DOM attrs at `deco.type.attrs`; some pm versions / decoration kinds
 * surface them under `deco.spec.attrs`. Check both so callers don't depend on
 * the internal layout.
 */
export function decorationCommentId(deco) {
  return (
    deco?.type?.attrs?.['data-comment-id'] ||
    deco?.spec?.attrs?.['data-comment-id'] ||
    null
  )
}

/**
 * Given the plugin's current decoration set + the comment list, report the
 * live `[from,to]` for each comment (or null if its decoration disappeared /
 * collapsed). Used to feed CommentStore.remapAnchors so anchors survive edits
 * across reloads.
 *
 * @returns {Map<commentId, {from:number,to:number}|null>}
 */
export function readMappedRanges(decorationSet, comments) {
  const out = new Map()
  const found = new Map()
  // DecorationSet.find() returns all decorations; group by data-comment-id.
  const all = decorationSet.find()
  for (const d of all) {
    const id = decorationCommentId(d)
    if (!id) continue
    // Prefer the widest span if duplicated (base + flash).
    const prev = found.get(id)
    if (!prev || (d.to - d.from) > (prev.to - prev.from)) {
      found.set(id, { from: d.from, to: d.to })
    }
  }
  for (const c of comments || []) {
    if (!c?.anchor || c.anchor.type !== 'text_range') continue
    const r = found.get(c.id)
    if (r && r.to > r.from) out.set(c.id, { from: r.from, to: r.to })
    else out.set(c.id, null) // collapsed / removed → orphan
  }
  return out
}

/**
 * Return the comment id whose highlight covers the editor's current caret
 * position, or null. Used for the keyboard "focus comment at cursor" shortcut.
 */
export function commentIdAtSelection(editor) {
  try {
    const state = editor.state
    const pluginState = COMMENT_PLUGIN_KEY.getState(state)
    if (!pluginState) return null
    const pos = state.selection.from
    const decos = pluginState.decorations.find(pos, pos)
    for (const d of decos) {
      const id = decorationCommentId(d)
      if (id) return id
    }
  } catch { /* editor not ready */ }
  return null
}

// ---------------------------------------------------------------------------
// The TipTap extension
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {(commentId:string)=>void} opts.onActivate  called when a highlight is
 *        clicked/keyboard-activated — the panel should focus that comment.
 */
export function createCommentDecorationsExtension(opts = {}) {
  const onActivate = opts.onActivate || (() => {})

  return Extension.create({
    name: 'commentDecorations',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: COMMENT_PLUGIN_KEY,
          state: {
            init() {
              return {
                comments: [],
                activeId: null,
                flashId: null,
                decorations: DecorationSet.empty,
              }
            },
            apply(tr, old, _oldState, newState) {
              const meta = tr.getMeta(COMMENT_META)
              if (meta) {
                const comments = meta.comments !== undefined ? meta.comments : old.comments
                const activeId = meta.activeId !== undefined ? meta.activeId : old.activeId
                let flashId = old.flashId
                if (meta.flash !== undefined) flashId = meta.flash
                if (meta.clearFlash !== undefined && old.flashId === meta.clearFlash) flashId = null
                return {
                  comments,
                  activeId,
                  flashId,
                  decorations: buildDecorationSet(newState.doc, comments, activeId, flashId),
                }
              }
              if (!tr.docChanged) return old
              // Map existing decorations through the edit so highlights follow
              // their text; this is the "survive edits" path.
              return { ...old, decorations: old.decorations.map(tr.mapping, tr.doc) }
            },
          },
          props: {
            decorations(state) {
              return COMMENT_PLUGIN_KEY.getState(state).decorations
            },
            handleClick(view, _pos, event) {
              // Click-to-jump (highlight → panel). Walk up from the click target
              // to find a decorated span carrying a comment id.
              let el = event.target
              while (el && el !== view.dom) {
                const id = el.getAttribute && el.getAttribute('data-comment-id')
                if (id) {
                  onActivate(id)
                  return false // don't preventDefault — let caret placement work
                }
                el = el.parentElement
              }
              return false
            },
          },
        }),
      ]
    },
  })
}
