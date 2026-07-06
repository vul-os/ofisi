/**
 * WAVE-45 — integration tests that drive a *real* TipTap editor with the
 * footnote + comment-decoration extensions to verify they wire up correctly:
 * insertion creates a ref + list entry, numbering decorations apply, and the
 * comment decoration plugin builds/maps highlights over a live document.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import {
  FootnoteRef,
  FootnoteItem,
  FootnotesList,
  FootnoteNumberingExtension,
  scanFootnotes,
} from '../footnotes.js'
import {
  createCommentDecorationsExtension,
  COMMENT_PLUGIN_KEY,
  COMMENT_META,
  decorationCommentId,
  commentIdAtSelection,
} from '../commentDecorations.js'

function makeEditor(extra = []) {
  return new Editor({
    extensions: [
      Document, Paragraph, Text,
      FootnoteRef, FootnoteItem, FootnotesList, FootnoteNumberingExtension,
      ...extra,
    ],
    content: '<p>Hello world</p>',
  })
}

let editor
afterEach(() => { editor?.destroy(); editor = null })

describe('footnote insertion (live editor)', () => {
  it('insertFootnote adds an inline ref and a matching list item', () => {
    editor = makeEditor()
    editor.commands.setTextSelection(6) // between "Hello" and " world"
    editor.commands.insertFootnote()

    const { bodyRefIds, itemIds, listPos } = scanFootnotes(editor.state.doc)
    expect(bodyRefIds).toHaveLength(1)
    expect(itemIds).toHaveLength(1)
    expect(bodyRefIds[0]).toBe(itemIds[0]) // ref id matches its list entry
    expect(listPos).not.toBeNull()
  })

  it('multiple footnotes share one list and get sequential numbers', () => {
    editor = makeEditor()
    editor.commands.insertFootnote()
    editor.commands.focus('end')
    editor.commands.insertFootnote()

    const { bodyRefIds, itemIds } = scanFootnotes(editor.state.doc)
    expect(bodyRefIds).toHaveLength(2)
    expect(itemIds).toHaveLength(2)
    // Only one list node exists.
    let listCount = 0
    editor.state.doc.descendants((n) => { if (n.type.name === 'footnotesList') listCount++ })
    expect(listCount).toBe(1)

    // Numbering decorations are applied (data-fn-num on the rendered refs).
    const html = editor.view.dom.innerHTML
    expect(html).toContain('data-fn-num="1"')
    expect(html).toContain('data-fn-num="2"')
  })

  it('deleting a ref from the body removes its orphaned list item (sync plugin)', () => {
    editor = makeEditor()
    editor.commands.setTextSelection(6)
    editor.commands.insertFootnote()
    let scan = scanFootnotes(editor.state.doc)
    expect(scan.itemIds).toHaveLength(1)

    // Find the ref node and delete it.
    let refPos = null
    let refSize = 0
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'footnoteRef') { refPos = pos; refSize = n.nodeSize }
    })
    editor.commands.deleteRange({ from: refPos, to: refPos + refSize })

    scan = scanFootnotes(editor.state.doc)
    expect(scan.bodyRefIds).toHaveLength(0)
    // Orphaned list item (and now-empty list) should be gone.
    expect(scan.itemIds).toHaveLength(0)
    expect(scan.listPos).toBeNull()
  })
})

describe('comment decorations (live editor)', () => {
  it('builds a highlight decoration for an anchored comment', () => {
    editor = makeEditor([createCommentDecorationsExtension({})])
    const comments = [{ id: 'c1', state: 'open', anchor: { type: 'text_range', from: 1, to: 6 } }]

    const tr = editor.state.tr
    tr.setMeta(COMMENT_META, { comments, activeId: null })
    editor.view.dispatch(tr)

    const decos = COMMENT_PLUGIN_KEY.getState(editor.state).decorations.find()
    const found = decos.find((d) => decorationCommentId(d) === 'c1')
    expect(found).toBeTruthy()
    expect(found.type.attrs.class).toContain('comment-highlight')
  })

  it('maps the highlight through an edit so it follows its text', () => {
    editor = makeEditor([createCommentDecorationsExtension({})])
    const comments = [{ id: 'c1', state: 'open', anchor: { type: 'text_range', from: 7, to: 12 } }]
    editor.view.dispatch(editor.state.tr.setMeta(COMMENT_META, { comments, activeId: null }))

    const before = COMMENT_PLUGIN_KEY.getState(editor.state).decorations
      .find().find((d) => decorationCommentId(d) === 'c1')

    // Insert 3 chars at the very start; the highlight should shift right by 3.
    editor.commands.insertContentAt(1, 'XXX')

    const after = COMMENT_PLUGIN_KEY.getState(editor.state).decorations
      .find().find((d) => decorationCommentId(d) === 'c1')

    expect(after.from).toBe(before.from + 3)
    expect(after.to).toBe(before.to + 3)
  })

  it('commentIdAtSelection finds the comment covering the caret', () => {
    editor = makeEditor([createCommentDecorationsExtension({})])
    const comments = [{ id: 'c1', state: 'open', anchor: { type: 'text_range', from: 1, to: 6 } }]
    editor.view.dispatch(editor.state.tr.setMeta(COMMENT_META, { comments, activeId: null }))

    editor.commands.setTextSelection(3) // inside [1,6)
    expect(commentIdAtSelection(editor)).toBe('c1')

    editor.commands.setTextSelection(9) // outside the highlight
    expect(commentIdAtSelection(editor)).toBeNull()
  })
})
