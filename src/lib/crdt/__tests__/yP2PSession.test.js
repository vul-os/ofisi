/**
 * YP2PCollabSession — the structure-aware document over the E2E-encrypted P2P
 * room (invite links).
 *
 * The crypto/capability properties themselves (sealed frames, roomId derivation,
 * ro peers holding no RW-MAC) are covered in p2pRoom.test.js. What is pinned here
 * is that the DOCUMENT rides that room correctly:
 *   • a peer's formatting/structure reaches the other peer;
 *   • two peers converge (including after an offline period);
 *   • a read-only peer cannot write into the shared document;
 *   • a hostile peer inside the room cannot inject unrenderable content.
 */

import { describe, it, expect, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import { YP2PCollabSession } from '../yP2PSession.js'
import { YCollab } from '../../../apps/docs/collabExtension.js'
import { createYContext, Y, Y_FRAGMENT, bytesToB64 } from '../ydoc.js'

vi.setConfig({ testTimeout: 30_000 })

// ── A tiny in-process fabric: broadcasts every frame to the other peers. ────
class FakeFabric extends EventTarget {
  constructor() { super(); this.peers = new Set(); this.id = Math.random().toString(36).slice(2) }
  connect(other) { this.peers.add(other); other.peers.add(this) }
  async join() {}
  leave() {}
  send(frame) {
    for (const p of this.peers) {
      p.dispatchEvent(new CustomEvent('message', { detail: { from: this.id, data: frame } }))
    }
  }
  sendTo(_peerId, frame) { this.send(frame) }
}

const INVITE = 'https://office.test/docs/doc1'

function makePeer(fabric) {
  const ydoc = new Y.Doc()
  const ctx = createYContext(null, ydoc)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ history: false }),
      Table.configure({ resizable: true }), TableRow, TableCell, TableHeader,
      YCollab.configure({ fragment: ydoc.getXmlFragment(Y_FRAGMENT) }),
    ],
  })
  ctx.schema = editor.schema
  return { ydoc, ctx, editor, fabric }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

/** Owner (rw) + a peer joining from one of the minted links. */
async function room({ joinWith = 'rw' } = {}) {
  const fa = new FakeFabric()
  const fb = new FakeFabric()
  fa.connect(fb)

  const owner = makePeer(fa)
  const { session: ownerSession, rwLink, roLink } = await YP2PCollabSession.create({
    peerId: 'owner', fileId: 'doc1', baseUrl: INVITE, ctx: owner.ctx, fabric: fa,
  })
  owner.session = ownerSession

  const guest = makePeer(fb)
  guest.session = await YP2PCollabSession.fromInvite({
    inviteLink: joinWith === 'ro' ? roLink : rwLink,
    peerId: 'guest', fileId: 'doc1', ctx: guest.ctx, fabric: fb,
  })

  await owner.session.join()
  await guest.session.join()
  await settle()
  return { owner, guest }
}

describe('YP2PCollabSession — the document over an E2E-encrypted room', () => {
  it('carries formatting and structure to the other peer', async () => {
    const { owner, guest } = await room()

    owner.editor.commands.setContent(
      '<h2>Heading</h2><p><strong>bold</strong> text</p>' +
      '<table><tbody><tr><td><p>cell</p></td></tr></tbody></table>',
    )
    await settle()

    const doc = guest.editor.getJSON()
    expect(doc.content[0].type).toBe('heading')
    expect(doc.content[1].content[0].marks.some((m) => m.type === 'bold')).toBe(true)
    expect(doc.content.find((n) => n.type === 'table')).toBeTruthy()
    expect(doc).toEqual(owner.editor.getJSON())
  })

  it('converges after both peers edit while disconnected (union, no lost work)', async () => {
    const { owner, guest } = await room()
    owner.editor.commands.setContent('<p>alpha</p><p>omega</p>')
    await settle()

    // Cut the wire and let both sides edit.
    const savedOwnerPeers = new Set(owner.session.fabric.peers)
    owner.session.fabric.peers.clear()
    guest.session.fabric.peers.clear()

    owner.editor.commands.insertContentAt(6, ' ONE')
    guest.editor.commands.insertContentAt(
      guest.editor.state.doc.content.size - 1, ' TWO',
    )
    await settle()
    expect(owner.editor.getJSON()).not.toEqual(guest.editor.getJSON())

    // Reconnect + resync: the state-vector exchange fetches exactly what each
    // side is missing. Neither peer's offline work may be dropped.
    for (const p of savedOwnerPeers) { owner.session.fabric.peers.add(p); p.peers.add(owner.session.fabric) }
    await owner.session.resync()
    await guest.session.resync()
    await settle()

    expect(owner.editor.getJSON()).toEqual(guest.editor.getJSON())
    const text = owner.editor.getJSON().content.map(
      (p) => (p.content || []).map((t) => t.text).join(''),
    )
    expect(text[0]).toContain('ONE')
    expect(text[1]).toContain('TWO')
  })

  it('a READ-ONLY peer cannot write into the shared document', async () => {
    const { owner, guest } = await room({ joinWith: 'ro' })
    expect(guest.session.readOnly).toBe(true)

    owner.editor.commands.setContent('<p>owner text</p>')
    await settle()
    // The ro peer RECEIVES the document (it can read live edits) …
    expect(guest.editor.getJSON()).toEqual(owner.editor.getJSON())

    // … but its own edits never reach the rw peer: it holds no RW-MAC key, so its
    // frames are not authoritative and the rw peer refuses them.
    guest.editor.commands.insertContentAt(1, 'VANDAL ')
    await settle()

    const ownerText = owner.editor.getJSON().content[0].content.map((n) => n.text).join('')
    expect(ownerText).toBe('owner text')
    expect(ownerText).not.toContain('VANDAL')
  })

  it('a hostile peer in the room cannot inject an unrenderable document', async () => {
    const { owner, guest } = await room()
    owner.editor.commands.setContent('<p>safe</p>')
    await settle()
    const before = owner.editor.getJSON()

    // The guest is rw (it holds the key — an invite link can be forwarded to
    // anyone), and crafts a Y update carrying a node type the schema has no idea
    // about. y-prosemirror would throw building the view; the ingress clamp must
    // drop it first.
    const evil = new Y.Doc()
    const frag = evil.getXmlFragment(Y_FRAGMENT)
    const el = new Y.XmlElement('evilNode')
    el.insert(0, [new Y.XmlText('boom')])
    frag.insert(0, [el])
    await guest.session._broadcast(
      { type: 'yu', u: bytesToB64(Y.encodeStateAsUpdate(evil)) },
      { authoritative: true },
    )
    await settle()

    expect(owner.session.rejectedUpdates).toBeGreaterThan(0)
    expect(owner.editor.getJSON()).toEqual(before)
    // The editor survived and still works.
    owner.editor.commands.insertContentAt(1, 'ok ')
    expect(owner.editor.getJSON().content[0].content[0].text).toContain('ok')
  })
})
