/**
 * footnotes.js — WAVE-45
 *
 * Real footnotes for the Docs editor, replacing the placeholder that inserted
 * a literal `<sup>[?]</sup>`.
 *
 * Model
 * -----
 *   footnoteRef   — an atomic inline node placed in the body where the author
 *                   inserts a footnote. Carries a stable `data-fn-id`. Renders
 *                   as a superscript number (`<sup>`). The number is *derived*
 *                   from document order, never stored, so it auto-renumbers.
 *
 *   footnotesList — a block node pinned at the end of the document containing
 *                   one `footnoteItem` per ref.
 *   footnoteItem  — a single footnote entry; carries the matching `data-fn-id`
 *                   and holds editable paragraph content (the note text). Renders
 *                   with its derived number as a leading marker.
 *
 * Numbering
 * ---------
 * `computeFootnoteOrder(refIds)` assigns 1..N to refs in body order. Because the
 * number is computed on every render (a ProseMirror decoration / node view would
 * normally do this; here we keep it simple and re-derive via a plugin that reads
 * order and writes `data-fn-num` attributes into the DOM), inserting a footnote
 * in the middle renumbers everything after it automatically.
 *
 * The pure helpers (computeFootnoteOrder, reconcileFootnoteItems, nextFootnoteId)
 * are exported and unit-tested without a live editor.
 */

import { Node, Extension, mergeAttributes } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

let _fnCounter = 0

/** Generate a process-unique footnote id. */
export function nextFootnoteId() {
  _fnCounter += 1
  const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  return `fn-${Date.now().toString(36)}-${_fnCounter}-${rand}`
}

// ---------------------------------------------------------------------------
// Pure numbering helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Assign sequential numbers to footnote refs in body order.
 * @param {string[]} refIds  footnote ids in the order they appear in the body
 * @returns {Map<string, number>}  id → 1-based number
 */
export function computeFootnoteOrder(refIds) {
  const map = new Map()
  let n = 0
  for (const id of refIds) {
    if (map.has(id)) continue // a duplicated id keeps its first number
    n += 1
    map.set(id, n)
  }
  return map
}

/**
 * Decide how to reconcile the footnotes list with the set of refs present in
 * the body. Returns { toAdd, toRemove, ordered }:
 *   toAdd    — ref ids that have no list item yet (need a blank entry)
 *   toRemove — list item ids whose ref was deleted from the body (orphans)
 *   ordered  — the ref ids in body order (the list should be sorted to match)
 *
 * @param {string[]} bodyRefIds  ref ids in body order
 * @param {string[]} itemIds     ids currently present in the footnotes list
 */
export function reconcileFootnoteItems(bodyRefIds, itemIds) {
  const bodySet = new Set(bodyRefIds)
  const itemSet = new Set(itemIds)
  const seen = new Set()
  const ordered = []
  for (const id of bodyRefIds) {
    if (!seen.has(id)) { seen.add(id); ordered.push(id) }
  }
  const toAdd = ordered.filter((id) => !itemSet.has(id))
  const toRemove = itemIds.filter((id) => !bodySet.has(id))
  return { toAdd, toRemove, ordered }
}

// ---------------------------------------------------------------------------
// footnoteRef — inline atom in the body
// ---------------------------------------------------------------------------

export const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-fn-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-fn-id': attrs.id } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'sup[data-fn-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // The visible number is injected by the numbering plugin as textContent /
    // the data-fn-num attribute; we render an empty sup shell here. On cold
    // load (export/print) we still show a bullet-ish marker via CSS ::before.
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { class: 'footnote-ref', 'data-footnote-ref': 'true' }),
    ]
  },

  addCommands() {
    return {
      insertFootnote: () => ({ chain, state }) => {
        const id = nextFootnoteId()
        // Insert the inline ref at the cursor, then ensure a list item exists.
        return chain()
          .insertContent({ type: this.name, attrs: { id } })
          .command(({ tr, dispatch }) => {
            if (dispatch) ensureFootnoteItem(state, tr, id)
            return true
          })
          .run()
      },
    }
  },
})

// ---------------------------------------------------------------------------
// footnoteItem — a single entry inside the list
// ---------------------------------------------------------------------------

export const FootnoteItem = Node.create({
  name: 'footnoteItem',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-fn-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-fn-id': attrs.id } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'li[data-fn-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(HTMLAttributes, { class: 'footnote-item' }), 0]
  },
})

// ---------------------------------------------------------------------------
// footnotesList — the container pinned at doc end
// ---------------------------------------------------------------------------

export const FootnotesList = Node.create({
  name: 'footnotesList',
  group: 'block',
  content: 'footnoteItem+',
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'ol[data-footnotes]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['ol', mergeAttributes(HTMLAttributes, { 'data-footnotes': 'true', class: 'footnotes-list' }), 0]
  },
})

// ---------------------------------------------------------------------------
// Editor-facing helpers (need a live ProseMirror state/tr)
// ---------------------------------------------------------------------------

/** Collect footnoteRef ids in body order + the list node position/items. */
export function scanFootnotes(doc) {
  const bodyRefIds = []
  let listPos = null
  let listNode = null
  const itemIds = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnoteRef' && node.attrs.id) {
      bodyRefIds.push(node.attrs.id)
    } else if (node.type.name === 'footnotesList') {
      listPos = pos
      listNode = node
    } else if (node.type.name === 'footnoteItem' && node.attrs.id) {
      itemIds.push(node.attrs.id)
    }
    return true
  })
  return { bodyRefIds, listPos, listNode, itemIds }
}

/**
 * Ensure a footnoteItem with `id` exists inside the footnotesList, creating the
 * list at the document end if needed. Mutates `tr`. Best-effort — never throws.
 */
export function ensureFootnoteItem(state, tr, id) {
  const { schema } = state
  const itemType = schema.nodes.footnoteItem
  const listType = schema.nodes.footnotesList
  const paraType = schema.nodes.paragraph
  if (!itemType || !listType || !paraType) return tr

  const { itemIds, listPos, listNode } = scanFootnotes(tr.doc)
  if (itemIds.includes(id)) return tr

  const item = itemType.create({ id }, paraType.create())

  if (listPos === null) {
    // No list yet: append a fresh list at the very end of the document.
    const list = listType.create(null, item)
    const end = tr.doc.content.size
    tr.insert(end, list)
  } else {
    // Insert the new item at the end of the existing list.
    const insertAt = listPos + 1 + listNode.content.size
    tr.insert(insertAt, item)
  }
  return tr
}

// ---------------------------------------------------------------------------
// FootnoteNumbering plugin — writes derived numbers as decorations so both the
// inline refs and the list items renumber automatically on any edit.
// ---------------------------------------------------------------------------

const FN_NUMBER_KEY = new PluginKey('footnoteNumbering')

function buildNumberDecorations(doc) {
  const { bodyRefIds } = scanFootnotes(doc)
  const order = computeFootnoteOrder(bodyRefIds)
  const decos = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnoteRef' && node.attrs.id) {
      const num = order.get(node.attrs.id)
      if (num) {
        // Node decoration adds the number as a data attribute the CSS renders.
        decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-fn-num': String(num) }))
      }
    } else if (node.type.name === 'footnoteItem' && node.attrs.id) {
      const num = order.get(node.attrs.id)
      if (num) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-fn-num': String(num) }))
      }
    }
    return true
  })
  return DecorationSet.create(doc, decos)
}

export function createFootnoteNumberingPlugin() {
  return new Plugin({
    key: FN_NUMBER_KEY,
    state: {
      init: (_c, state) => buildNumberDecorations(state.doc),
      apply(tr, old) {
        if (!tr.docChanged) return old
        return buildNumberDecorations(tr.doc)
      },
    },
    props: {
      decorations(state) { return FN_NUMBER_KEY.getState(state) },
    },
  })
}

// ---------------------------------------------------------------------------
// FootnoteSync plugin — appendTransaction that removes orphaned footnote items
// (whose ref was deleted from the body) and drops an empty list. This keeps the
// footnotes section consistent without the author having to clean up manually.
// ---------------------------------------------------------------------------

const FN_SYNC_KEY = new PluginKey('footnoteSync')

export function createFootnoteSyncPlugin() {
  return new Plugin({
    key: FN_SYNC_KEY,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((t) => t.docChanged)) return null
      const { bodyRefIds, listPos, listNode, itemIds } = scanFootnotes(newState.doc)
      if (listPos === null) return null
      const { toRemove } = reconcileFootnoteItems(bodyRefIds, itemIds)
      if (toRemove.length === 0) return null

      const tr = newState.tr
      // Delete orphaned items from the end backwards so positions stay valid.
      const positions = []
      newState.doc.descendants((node, pos) => {
        if (node.type.name === 'footnoteItem' && toRemove.includes(node.attrs.id)) {
          positions.push({ from: pos, to: pos + node.nodeSize })
        }
        return true
      })
      for (const p of positions.sort((a, b) => b.from - a.from)) {
        tr.delete(p.from, p.to)
      }
      // If every item was removed, drop the now-empty list too.
      if (itemIds.length - toRemove.length <= 0) {
        // Re-scan positions after item deletes via mapping.
        const listFrom = tr.mapping.map(listPos)
        const mappedListEnd = tr.mapping.map(listPos + listNode.nodeSize)
        if (mappedListEnd > listFrom) tr.delete(listFrom, mappedListEnd)
      }
      return tr.docChanged ? tr : null
    },
  })
}

// A tiny extension wrapper so DocsEditor can add the numbering + sync plugins.
export const FootnoteNumberingExtension = Extension.create({
  name: 'footnoteNumbering',
  addProseMirrorPlugins() {
    return [createFootnoteNumberingPlugin(), createFootnoteSyncPlugin()]
  },
})
