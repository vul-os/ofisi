/**
 * undoRemote.test.jsx — deep/office2 UNDO-INTEGRITY regression.
 *
 * applyTextPatch applies a REMOTE peer's CRDT text change into the local TipTap
 * editor. It previously ran the deleteRange/insert WITHOUT addToHistory:false, so
 * the remote edit entered THIS user's undo stack. The user's next Ctrl+Z then
 * reverted the PEER's change (which re-broadcasts as a local delete and corrupts
 * the shared document); redo could resurrect peer-deleted content. The fix tags
 * the remote transaction addToHistory:false so only genuine local keystrokes are
 * undoable. This pins it with a REAL ProseMirror history stack.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { applyTextPatch } from '../DocsEditor.jsx'

let editor
afterEach(() => { editor?.destroy(); editor = null })

function makeEditor(text) {
  return new Editor({
    extensions: [StarterKit],
    content: `<p>${text}</p>`,
  })
}

describe('applyTextPatch does not pollute the local undo history', () => {
  it('undo after a remote edit reverts the LOCAL edit, not the remote one', () => {
    editor = makeEditor('hello')

    // Local keystroke: append '!' (this SHOULD be undoable).
    editor.chain().focus().insertContentAt(editor.state.doc.content.size - 1, '!').run()
    expect(editor.getText()).toBe('hello!')

    // Remote peer inserts 'X' at the front — applied via applyTextPatch.
    applyTextPatch(editor, editor.getText(), 'Xhello!')
    expect(editor.getText()).toBe('Xhello!')

    // One undo must revert ONLY the local '!', leaving the remote 'X' intact.
    editor.commands.undo()
    const afterUndo = editor.getText()
    expect(afterUndo).toContain('X')          // remote change survived (was lost before)
    expect(afterUndo).toBe('Xhello')          // only the local '!' was undone
  })

  it('a remote edit alone leaves nothing to undo', () => {
    editor = makeEditor('abc')
    applyTextPatch(editor, 'abc', 'abcd')     // purely remote
    expect(editor.getText()).toBe('abcd')
    expect(editor.can().undo()).toBe(false)   // remote op is not on the local stack
  })
})
