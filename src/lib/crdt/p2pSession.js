/**
 * src/lib/crdt/p2pSession.js — secure local/P2P collab session (WAVE-25).
 *
 * The ADDITIVE local/P2P collaboration mode. Structurally parallel to
 * DocsCollabSession (./index.js) — same TextCRDT, same FabricClient transport,
 * same {op, snap-req, snap} wire vocabulary and offline-buffer-then-sync
 * behaviour — but every frame is:
 *
 *   • E2E-ENCRYPTED under a room key derived from the invite link, with a fresh
 *     per-message nonce (AES-256-GCM). The relay and any uninvited peer are
 *     CONTENT-BLIND. (p2pRoom.sealFrame / openFrame.)
 *
 *   • CAPABILITY-GATED: the fabric session id is the roomId derived from the
 *     roomKey, so a peer without the key cannot even seal a frame the room will
 *     accept — knowing the roomId alone admits nothing. rw frames carry an HMAC
 *     proving RW authority; ro peers cannot forge it.
 *
 *   • RO-ENFORCED: a read-only peer decrypts + renders live edits but its own op
 *     frames are NOT authoritative (no RW-MAC), so rw peers reject them. Mirrors
 *     Board wave-15 ro enforcement.
 *
 * Offline-local: when no peer is connected, edits still apply to the local CRDT
 * and buffer; on reconnect a snap-req/snap exchange converges the state.
 *
 * Usage (see DocsEditor.jsx collab mode selector):
 *   const session = await P2PCollabSession.fromInvite({ inviteLink, peerId })
 *   session.on('change', (e) => applyToEditor(e.detail.text))
 *   await session.join()
 *   session.applyLocal(prev, next)   // no-op writes for ro peers
 */

import { FabricClient } from '@vulos/relay-client/fabric'
import { TextCRDT } from './text.js'
import {
  parseInvite, generateInvite, deriveRoomKeys,
  sealFrame, openFrame, CAP_RW, CAP_RO,
} from './p2pRoom.js'

const SNAP_KEY_PREFIX = 'vulos_p2p_snap_'
const SNAPSHOT_DEBOUNCE_MS = 3000

export class P2PCollabSession extends EventTarget {
  /**
   * Construct from already-derived room material. Prefer the fromInvite() /
   * create() factories which handle key derivation.
   *
   * @param {object} opts
   * @param {object}   opts.room       { encKey, macKeyRw|null, roomId }
   * @param {string}   opts.cap        'rw' | 'ro'
   * @param {string}   opts.peerId     stable id for this peer/tab
   * @param {string}   opts.fileId     local document id (for snapshot keying)
   * @param {string}  [opts.signalingUrl]
   * @param {string}  [opts.iceUrl]
   * @param {string}  [opts.relayBaseUrl]
   * @param {string}  [opts.authToken]
   * @param {string}  [opts.rendezvousBaseUrl]  see transportSelection.js — when
   *   set, runs the FabricClient against any relayd's open rendezvous surface
   *   instead of a host box's /api/peering/*.
   * @param {FabricClient} [opts.fabric]  inject a transport (tests / custom hosts)
   */
  constructor({
    room, cap, peerId, fileId,
    signalingUrl, iceUrl, relayBaseUrl, authToken, rendezvousBaseUrl, rendezvousPrefix, fabric,
  }) {
    super()
    if (!room || !room.encKey) throw new Error('P2PCollabSession: missing room keys')
    if (cap !== CAP_RW && cap !== CAP_RO) throw new Error(`P2PCollabSession: bad cap "${cap}"`)

    this._room = room
    this._cap = cap
    this._peerId = peerId
    this._fileId = fileId || room.roomId
    this._crdt = new TextCRDT(peerId)
    this._joined = false
    this._snapTimer = null

    if (fabric) {
      this._fabric = fabric
    } else {
      // The fabric SESSION ID is the roomId — never the raw key. Rendezvous is
      // over the derived, non-secret roomId; the relay learns only that some
      // peers share a room, never the key or the content.
      const wsBase =
        signalingUrl ||
        (typeof window !== 'undefined'
          ? window.location.origin.replace(/^http/, 'ws') + '/api/peering/stream'
          : 'ws://localhost:8080/api/peering/stream')
      this._fabric = new FabricClient({
        sessionId: room.roomId,
        peerId,
        signalingUrl: wsBase,
        iceUrl: iceUrl || '/api/peering/ice',
        relayBaseUrl: relayBaseUrl || '',
        authToken: authToken || null,
        rendezvousBaseUrl: rendezvousBaseUrl || '',
        // Same-origin proxy mount (see transportSelection.js); the relay's own
        // default is used when a caller passes nothing.
        ...(rendezvousPrefix ? { rendezvousPrefix } : {}),
      })
    }

    this._fabric.addEventListener('state', (ev) => {
      this.dispatchEvent(new CustomEvent('state', { detail: ev.detail }))
      // RESYNC ON REACHABILITY — see the same guard in yP2PSession.js for the
      // full story. join()'s snapshot request is emitted before any peer
      // transport exists (ICE takes seconds) and FabricClient drops sends to a
      // peer that is still 'connecting', so the bootstrap has to happen when the
      // peer actually becomes reachable, not when we joined. Idempotent: a
      // snapshot is MERGED, never overwritten.
      const { peerId, state } = ev.detail || {}
      if (!peerId) return
      if (state !== 'connected' && state !== 'relay') return
      this._sendTo(peerId, { type: 'snap-req' })
        .catch(() => { /* peer vanished again — the next state event retries */ })
    })
    this._fabric.addEventListener('message', (ev) => {
      // Frames are E2E-sealed; open is async, so we fire-and-forget.
      this._onPeerFrame(ev.detail).catch(() => { /* undecryptable frame — drop */ })
    })
  }

  // ── factories ──────────────────────────────────────────────────────────────

  /** Join an existing room from an invite link (or bare fragment). */
  static async fromInvite({ inviteLink, peerId, fileId, ...rest }) {
    const { roomId, cap, roomKey } = await parseInvite(inviteLink)
    const keys = await deriveRoomKeys(roomKey)
    // ro peers must NOT hold macKeyRw — that is what prevents them from forging
    // authoritative op frames. Strip it here so it never enters a ro session.
    const room = cap === CAP_RO
      ? { encKey: keys.encKey, macKeyRw: null, roomId }
      : { encKey: keys.encKey, macKeyRw: keys.macKeyRw, roomId }
    return new P2PCollabSession({ room, cap, peerId, fileId: fileId || roomId, ...rest })
  }

  /**
   * Create a brand-new room (the sharer). Returns { session, rwLink, roLink }.
   * The rw link is the owner's; the ro link derives from the SAME roomKey so ro
   * peers can decrypt, but is minted with cap="ro".
   */
  static async create({ peerId, fileId, baseUrl, ...rest }) {
    const rw = await generateInvite({ cap: CAP_RW, baseUrl })
    const ro = await generateInvite({ cap: CAP_RO, baseUrl, roomKey: rw.roomKey })
    const keys = await deriveRoomKeys(rw.roomKey)
    const room = { encKey: keys.encKey, macKeyRw: keys.macKeyRw, roomId: keys.roomId }
    const session = new P2PCollabSession({
      room, cap: CAP_RW, peerId, fileId: fileId || keys.roomId, ...rest,
    })
    return { session, rwLink: rw.link, roLink: ro.link, roomId: keys.roomId }
  }

  // ── public API (mirrors DocsCollabSession) ───────────────────────────────────

  get cap() { return this._cap }
  get roomId() { return this._room.roomId }
  get readOnly() { return this._cap === CAP_RO }
  get fabric() { return this._fabric }

  async join() {
    if (this._joined) return
    this._joined = true
    this._restoreSnapshot()
    await this._fabric.join()
    // Late-joiner bootstrap: ask peers for a snapshot (sealed).
    await this._broadcast({ type: 'snap-req' })
  }

  /**
   * Re-request a snapshot from peers. Call after a transport reconnect so any
   * edits missed while offline are pulled back in (offline-buffer-then-sync).
   * Safe to call repeatedly; incoming snapshots are MERGED (union) into local
   * state, so a reconnecting peer never loses its own offline edits.
   */
  async resync() {
    await this._broadcast({ type: 'snap-req' })
  }

  /**
   * Diff prev→next, apply locally, and broadcast ops.
   *
   * READ-ONLY: a ro peer applies nothing and broadcasts nothing — its edits
   * would be rejected by rw peers anyway (no RW-MAC), so we make the local
   * editor honest and reject the write outright rather than let it diverge.
   * Returns the ops emitted (empty for ro).
   */
  applyLocal(prevText, nextText) {
    if (this.readOnly) return []           // ro peers cannot produce ops
    // diffToOps applies each op locally as it is produced (so multi-char inserts
    // chain their parents correctly), then we broadcast the authoritative frame.
    const ops = diffToOps(prevText, nextText, this._crdt)
    for (const op of ops) {
      // op frames are AUTHORITATIVE — carry the RW-MAC so rw peers accept them.
      this._broadcast({ type: 'op', op }, { authoritative: true })
    }
    this._scheduleSnapshotFlush()
    return ops
  }

  getText() { return this._crdt.toString() }

  leave() {
    this._joined = false
    clearTimeout(this._snapTimer)
    this._fabric.leave()
  }

  // ── inbound ─────────────────────────────────────────────────────────────────

  async _onPeerFrame({ from, data }) {
    const frameB64 = typeof data === 'string' ? data : new TextDecoder().decode(data)
    // openFrame throws on wrong-key / tamper (AEAD) — uninvited peers & the
    // relay can never reach here. authoritative === true iff a valid RW-MAC was
    // present AND we hold macKeyRw to verify it (i.e. we are an rw peer).
    const { msg, authoritative } = await openFrame(this._room, frameB64)

    if (msg.type === 'op' && msg.op) {
      // ── RO ENFORCEMENT (rw side) ──────────────────────────────────────────
      // An rw peer only merges ops that carry a valid RW-MAC. A ro peer that
      // tries to write emits a non-authoritative op frame; we drop it here so
      // its edits never reach the shared document. (A ro RECEIVER has no
      // macKeyRw and thus can't verify anyone's ops — but a ro receiver merging
      // a genuine rw op is fine; it's read-only for OUTPUT, not input. We still
      // require authoritative on the rw side, which is where divergence would
      // otherwise be introduced.)
      if (this._room.macKeyRw && !authoritative) {
        // We are rw and the op is not RW-authoritative → reject (ro peer write).
        return
      }
      const changed = this._crdt.apply(msg.op)
      if (changed) {
        this.dispatchEvent(new CustomEvent('change', {
          detail: { text: this._crdt.toString(), remote: true },
        }))
        this._scheduleSnapshotFlush()
      }
    } else if (msg.type === 'snap-req') {
      // Serve a snapshot. Only rw peers serve AUTHORITATIVE snapshots (so a ro
      // peer can't seed a poisoned document into an rw peer). ro peers may still
      // answer other ro peers with a non-authoritative snapshot for read-only
      // catch-up, but rw peers ignore non-authoritative snapshots below.
      const snap = this._crdt.snapshot()
      await this._sendTo(from, { type: 'snap', snap }, { authoritative: !this.readOnly })
    } else if (msg.type === 'snap' && msg.snap) {
      // rw peers only accept AUTHORITATIVE snapshots. ro peers accept any (they
      // never write back, so a poisoned read is contained to their own view).
      if (this._room.macKeyRw && !authoritative) return
      // MERGE the snapshot (union), never a count-gated restore(). When two peers
      // edit OFFLINE and reconnect, each holds nodes the other lacks; a "replace
      // only if remote is larger" rule silently DROPS the smaller side's offline
      // work. merge() folds the incoming nodes via idempotent RGA apply so both
      // peers reach the union with zero loss. (The resync() docstring's old
      // "only replace strictly-larger state" claim was the bug.)
      const changed = this._crdt.merge(msg.snap)
      if (changed) {
        this.dispatchEvent(new CustomEvent('change', {
          detail: { text: this._crdt.toString(), remote: true },
        }))
        this._scheduleSnapshotFlush()
      }
    }
  }

  // ── outbound (sealed) ─────────────────────────────────────────────────────────

  async _broadcast(msg, opts) {
    const frame = await sealFrame(this._room, msg, opts)
    this._fabric.send(frame)
  }

  async _sendTo(peerId, msg, opts) {
    const frame = await sealFrame(this._room, msg, opts)
    if (peerId) this._fabric.sendTo(peerId, frame)
    else this._fabric.send(frame)
  }

  // ── snapshot persistence (offline recovery) ──────────────────────────────────

  _snapKey() { return SNAP_KEY_PREFIX + this._fileId }

  _restoreSnapshot() {
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(this._snapKey())
      if (!raw) return
      this._crdt.restore(JSON.parse(raw))
    } catch { /* corrupt snapshot — ignore */ }
  }

  _scheduleSnapshotFlush() {
    clearTimeout(this._snapTimer)
    this._snapTimer = setTimeout(() => {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(this._snapKey(), JSON.stringify(this._crdt.snapshot()))
        }
      } catch { /* storage full / unavailable — best-effort */ }
    }, SNAPSHOT_DEBOUNCE_MS)
  }
}

// ── diffToOps (shared shape with index.js) ────────────────────────────────────

function diffToOps(prevText, nextText, crdt) {
  const ops = []
  if (prevText === nextText) return ops

  // Diff in CODE POINTS, not UTF-16 units — the CRDT is one node per code point.
  // Indexing a raw string by code unit splits astral chars (emoji, etc.) into
  // lone surrogates that the CRDT rejects, silently dropping the glyph. See the
  // matching note in index.js diffToOps.
  const prev = Array.from(prevText)
  const next = Array.from(nextText)

  let prefixLen = 0
  while (
    prefixLen < prev.length && prefixLen < next.length &&
    prev[prefixLen] === next[prefixLen]
  ) prefixLen++

  let suffixLen = 0
  while (
    suffixLen < prev.length - prefixLen &&
    suffixLen < next.length - prefixLen &&
    prev[prev.length - 1 - suffixLen] === next[next.length - 1 - suffixLen]
  ) suffixLen++

  const prevMid = prev.slice(prefixLen, prev.length - suffixLen)
  const nextMid = next.slice(prefixLen, next.length - suffixLen)

  // Delete old middle (right-to-left preserves indices). Apply as we go so the
  // subsequent inserts see the post-delete visible order.
  for (let i = prevMid.length - 1; i >= 0; i--) {
    const op = crdt.localDelete(prefixLen + i)
    if (op) { crdt.apply(op); ops.push(op) }
  }
  // Insert new middle (left-to-right). Apply each op BEFORE producing the next
  // so the next character's parent is the character we just inserted — otherwise
  // every insert would attach to the same parent and RGA would render the run
  // reversed.
  for (let i = 0; i < nextMid.length; i++) {
    const op = crdt.localInsert(prefixLen + i, nextMid[i])
    if (op) { crdt.apply(op); ops.push(op) }
  }
  return ops
}
