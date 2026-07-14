/**
 * src/lib/crdt/yServerSession.js — Yjs document sync over the ACL-gated server
 * relay (the CLOUD / account collaboration path).
 *
 * Same transport as before (backend/handlers/docsync.go):
 *   GET  /v1/documents/:id/collab/state     — late-joiner bootstrap (VIEWER+)
 *   GET  /v1/documents/:id/collab/stream    — SSE fan-out (VIEWER+)
 *   POST /v1/documents/:id/collab/ops       — publish ops / snapshot (EDITOR+)
 *   POST /v1/documents/:id/collab/presence  — live cursors + roster (VIEWER+)
 *
 * What changed is the PAYLOAD. An op is no longer an RGA TextOp built from a
 * plain-text diff (which could not carry formatting or structure at all, and
 * whose character offsets did not map to ProseMirror positions) — it is a Yjs
 * update envelope { y:1, u:<base64> } carrying real document structure. The
 * server stores ops as opaque JSON, so the transport needed no change; the
 * document format did.
 *
 * ── MIGRATION (explicit, one-way, on first open) ────────────────────────────
 * An existing document has an op log in the OLD format (RGA TextOps + a
 * {nodes:[…]} snapshot). We do NOT convert it, and we never apply it. We cannot,
 * and — importantly — we do not need to:
 *
 *   The op log was only ever the live-sync TRANSPORT. The document's actual
 *   content has always been, and still is, the TipTap JSON persisted through the
 *   normal autosave (PUT /api/files/:id → models.File.Content). That is what the
 *   editor has always opened, and it is the only representation that ever held
 *   the formatting and structure.
 *
 * So on first open of a legacy document we SEED the Y.Doc deterministically from
 * that authoritative content (see ydoc.seedUpdateFromPMJSON) and publish it as
 * the new compaction SNAPSHOT. The server's SaveSnapshot sets the new base and
 * PRUNES the ops at or below it, which drops the legacy log for good. Nothing is
 * lost (the legacy log never carried anything the JSON did not) and nothing is
 * corrupted (the legacy ops are never fed to the new format). The upgrade is
 * one-way and visible in the log: `legacyOpsIgnored` counts what was dropped.
 *
 * Concurrent first-open is safe: the seed is derived deterministically from the
 * content, so two peers that seed the same document produce the SAME Yjs items
 * and merging them is a no-op (see the note on hash31 in ydoc.js).
 *
 * ── FAIL-CLOSED INGRESS ─────────────────────────────────────────────────────
 * Every inbound byte (SSE frame, bootstrap snapshot, replayed op) is untrusted:
 * it goes through decodeUpdateEnvelope + applyRemoteUpdate, which validate the
 * envelope, the update bytes, and the DOCUMENT the update would produce (against
 * the real ProseMirror schema, with the image/link clamps) before it is allowed
 * to touch the live document. A rejected frame is dropped and counted; it never
 * throws, never half-applies, and never reaches the renderer.
 */

import * as Y from 'yjs'
import { api } from '../api.js'
import {
  Y_FRAGMENT,
  MAX_SNAPSHOT_BYTES,
  REMOTE_ORIGIN,
  SEED_ORIGIN,
  encodeUpdateEnvelope,
  decodeUpdateEnvelope,
  isYEnvelope,
  isLegacyTextPayload,
  applyRemoteUpdate,
  seedUpdateFromPMJSON,
  isFragmentEmpty,
  checkFragmentRenderable,
} from './ydoc.js'

const PUBLISH_DEBOUNCE_MS = 250
const SNAPSHOT_DEBOUNCE_MS = 10000
const RECONNECT_GRACE_MS = 8000
const PRESENCE_DEBOUNCE_MS = 120
const PRESENCE_TTL_MS = 15000
const PRESENCE_HEARTBEAT_MS = 8000

export class YServerCollabSession extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.fileId
   * @param {string} opts.peerId  stable per-tab id (self-echo hint only)
   * @param {object} opts.ctx     { ydoc, shadow, schema } from createYContext()
   */
  constructor({ fileId, peerId, ctx }) {
    super()
    this._fileId = fileId
    this._peerId = peerId
    this._ctx = ctx

    this._joined = false
    this._live = false
    this._readOnly = false
    this._degraded = false          // bootstrap failed → local-only, no stream
    this._es = null
    this._graceTimer = null
    this._snapTimer = null
    this._publishTimer = null
    this._pendingUpdates = []
    this._seq = 0
    this._myAuthor = null

    // Observability for the migration + the ingress clamp (asserted in tests).
    this.legacyOpsIgnored = 0
    this.rejectedUpdates = 0
    this.seeded = false

    // Presence (unchanged semantics: ephemeral, server-stamped identity).
    this._roster = new Map()
    this._presence = null
    this._presenceTimer = null
    this._presencePending = false
    this._presenceHeartbeat = null
    this._presenceSweep = null

    // Fan every LOCAL change out to the relay.
    //   • REMOTE_ORIGIN — it came FROM the relay; re-publishing would be an echo.
    //   • SEED_ORIGIN   — the seed is published explicitly, once, as the
    //     compaction snapshot; publishing it as an op too would duplicate it in
    //     the log for no reason.
    //   • degraded      — we never reached the server, so we do not know whether
    //     it already holds Yjs state for this document. Pushing our locally-seeded
    //     updates into it could merge two different lineages of the same document
    //     (i.e. show it twice). Fail closed: local-only means local-only.
    this._onLocalUpdate = (update, origin) => {
      if (origin === REMOTE_ORIGIN || origin === SEED_ORIGIN) return
      if (this._readOnly || this._degraded) return
      this._pendingUpdates.push(update)
      this._schedulePublish()
      this._scheduleSnapshot()
    }
    ctx.ydoc.on('update', this._onLocalUpdate)
  }

  get live() { return this._live }
  get readOnly() { return this._readOnly }
  get degraded() { return this._degraded }

  // ── Join ──────────────────────────────────────────────────────────────────

  /**
   * Bootstrap from the server, seed the document if the server has no Yjs state
   * for it (a NEW doc, or a LEGACY doc being upgraded), then open the stream.
   *
   * @param {object} opts
   * @param {object} opts.seedJSON  the document's authoritative ProseMirror JSON
   *   (from models.File.Content). Used ONLY if the server holds no Yjs state.
   * @returns {Promise<{seeded:boolean, degraded:boolean, legacyOpsIgnored:number}>}
   */
  async join({ seedJSON } = {}) {
    if (this._joined) return { seeded: this.seeded, degraded: this._degraded, legacyOpsIgnored: this.legacyOpsIgnored }
    this._joined = true

    const hadRemoteState = await this._bootstrap()

    if (this._degraded) {
      // We could not reach the sync service. Seed LOCALLY so the document is
      // readable + editable, but do NOT open the stream and do NOT publish: with
      // no bootstrap we cannot know whether the server already holds Yjs state,
      // and merging our fresh seed into an existing one would duplicate the
      // document. Local-only is the honest, safe degrade — autosave still
      // persists the content exactly as it always did.
      if (seedJSON && isFragmentEmpty(this._ctx.ydoc)) this._seed(seedJSON)
      return { seeded: this.seeded, degraded: true, legacyOpsIgnored: this.legacyOpsIgnored }
    }

    if (!hadRemoteState) {
      // The server holds no Yjs state: either a brand-new document, or a LEGACY
      // one whose old RGA op log we just ignored. Seed from the authoritative
      // content and publish it as the new compaction base (which prunes the
      // legacy ops server-side — the one-way upgrade).
      if (seedJSON && isFragmentEmpty(this._ctx.ydoc)) {
        this._seed(seedJSON)
        await this._publishSnapshot()
      }
    }

    this._openStream()
    this._presenceHeartbeat = setInterval(() => {
      if (this._presence) this._flushPresence(true)
    }, PRESENCE_HEARTBEAT_MS)
    this._presenceSweep = setInterval(() => this._sweepRoster(), PRESENCE_TTL_MS / 3)

    return { seeded: this.seeded, degraded: false, legacyOpsIgnored: this.legacyOpsIgnored }
  }

  /** Apply the deterministic seed for `docJSON` to the live document. */
  _seed(docJSON) {
    const update = seedUpdateFromPMJSON(this._ctx.schema, docJSON)
    Y.applyUpdate(this._ctx.ydoc, update, SEED_ORIGIN)
    this.seeded = true
    this.dispatchEvent(new CustomEvent('seeded', { detail: { legacyOpsIgnored: this.legacyOpsIgnored } }))
  }

  /**
   * Pull the authoritative state. Returns true when the server held Yjs state we
   * applied. Sets _degraded when the endpoint is unreachable.
   */
  async _bootstrap() {
    let state
    try {
      state = await api.docCollabState(this._fileId)
    } catch (err) {
      this._degraded = true
      console.warn('[y-collab] bootstrap failed (local-only):', err?.message)
      return false
    }
    if (state?.you) this._myAuthor = state.you

    let applied = 0
    // The snapshot may be a Yjs snapshot, a LEGACY RGA snapshot, or absent.
    if (state?.snap) {
      if (this._ingest(state.snap, MAX_SNAPSHOT_BYTES)) applied++
    }
    for (const rec of state?.ops || []) {
      if (this._ingest(rec?.op)) applied++
      if (typeof rec?.seq === 'number' && rec.seq > this._seq) this._seq = rec.seq
    }
    if (typeof state?.seq === 'number' && state.seq > this._seq) this._seq = state.seq

    if (this.legacyOpsIgnored > 0) {
      console.info(
        `[y-collab] document ${this._fileId}: ignored ${this.legacyOpsIgnored} legacy ` +
        'text-CRDT op(s)/snapshot — upgrading to the structure-aware format from the ' +
        'authoritative document content (one-way, see yServerSession.js).',
      )
    }
    return applied > 0
  }

  /**
   * Ingest one untrusted payload (a bootstrap snapshot, a replayed op, or an SSE
   * frame). Returns true iff it changed the live document.
   */
  _ingest(payload, maxBytes) {
    if (isLegacyTextPayload(payload)) {
      // Pre-Yjs format. Deliberately NOT applied: it carries no structure, and
      // its offsets are meaningless against a real document. Counted so the
      // migration is visible rather than silent.
      this.legacyOpsIgnored++
      return false
    }
    if (!isYEnvelope(payload)) return false
    const update = decodeUpdateEnvelope(payload, maxBytes)
    if (!update) { this.rejectedUpdates++; return false }
    const res = applyRemoteUpdate(this._ctx, update)
    if (!res.applied) {
      this.rejectedUpdates++
      console.warn('[y-collab] rejected a remote update (fail-closed):', res.reason)
      return false
    }
    return true
  }

  // ── Inbound: SSE ──────────────────────────────────────────────────────────

  _openStream() {
    if (typeof EventSource === 'undefined') return // SSR/test — bootstrap already ran
    let es
    try {
      es = new EventSource(api.docCollabStreamUrl(this._fileId), { withCredentials: true })
    } catch (err) {
      console.warn('[y-collab] stream open failed (local-only):', err?.message)
      return
    }
    this._es = es
    es.onopen = () => { this._clearGrace(); this._live = true }
    es.onerror = () => { this._markNotLive() }
    es.onmessage = (e) => {
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (!ev || !ev.type) return
      if (ev.type === 'ping') { this._clearGrace(); this._live = true; return }
      if (ev.type === 'presence') { this._applyRemotePresence(ev.payload, ev.origin); return }
      if (ev.type !== 'op' || !ev.payload) return
      // Our own echo: applying it would be a harmless no-op (Yjs dedups by
      // (client, clock)), but skip the work. We require BOTH the same-tab origin
      // AND the server-stamped author, so a peer that spoofs our origin cannot
      // make us drop its real op.
      if (
        ev.origin && ev.origin === this._peerId &&
        (this._myAuthor == null || ev.author === this._myAuthor)
      ) return
      if (typeof ev.seq === 'number' && ev.seq > this._seq) this._seq = ev.seq
      if (this._ingest(ev.payload)) {
        this.dispatchEvent(new CustomEvent('change', { detail: { remote: true } }))
        this._scheduleSnapshot()
      }
    }
  }

  _markNotLive() {
    if (this._graceTimer) return
    this._graceTimer = setTimeout(() => { this._graceTimer = null; this._live = false }, RECONNECT_GRACE_MS)
  }
  _clearGrace() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  _schedulePublish() {
    if (this._publishTimer) return
    this._publishTimer = setTimeout(() => { this._publishTimer = null; this._flushPublish() }, PUBLISH_DEBOUNCE_MS)
  }

  _flushPublish() {
    if (this._pendingUpdates.length === 0 || this._readOnly || this._degraded) return
    const batch = this._pendingUpdates
    this._pendingUpdates = []
    // Coalesce a burst of keystrokes into ONE update — bounds request rate and
    // keeps every op comfortably under the server's per-op byte cap.
    let merged
    try {
      merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch)
    } catch {
      merged = null
    }
    if (!merged) return
    const envelope = encodeUpdateEnvelope(merged)
    api.docCollabPublish(this._fileId, { origin: this._peerId, ops: [envelope] })
      .then((res) => {
        if (res && typeof res.seq === 'number' && res.seq > this._seq) this._seq = res.seq
      })
      .catch((err) => {
        if (err?.status === 403) {
          // Editor-gated: we are a viewer/commenter. Stop publishing; keep
          // receiving. (Same gate as PATCH /v1/documents/:id.)
          this._readOnly = true
          this._pendingUpdates = []
          this.dispatchEvent(new CustomEvent('readonly', { detail: {} }))
          return
        }
        // Transient (offline / endpoint down): re-queue so a later flush retries
        // rather than dropping the user's edit.
        this._pendingUpdates = [merged, ...this._pendingUpdates]
        console.warn('[y-collab] publish failed (will retry):', err?.message)
      })
  }

  _scheduleSnapshot() {
    if (this._readOnly || this._degraded) return
    clearTimeout(this._snapTimer)
    this._snapTimer = setTimeout(() => { this._publishSnapshot().catch(() => {}) }, SNAPSHOT_DEBOUNCE_MS)
  }

  /**
   * Publish the whole document state as the compaction base. The server prunes
   * every op at or below it, which bounds the op log AND (on first open of a
   * legacy document) is what drops the old text-CRDT log.
   */
  async _publishSnapshot() {
    if (this._readOnly || this._degraded) return
    const state = Y.encodeStateAsUpdate(this._ctx.ydoc)
    if (state.length > MAX_SNAPSHOT_BYTES) {
      console.warn('[y-collab] snapshot exceeds the size cap — skipping compaction')
      return
    }
    try {
      const res = await api.docCollabPublish(this._fileId, {
        origin: this._peerId, ops: [], snap: encodeUpdateEnvelope(state),
      })
      if (res && typeof res.seq === 'number' && res.seq > this._seq) this._seq = res.seq
    } catch (err) {
      if (err?.status === 403) {
        this._readOnly = true
        this.dispatchEvent(new CustomEvent('readonly', { detail: {} }))
        return
      }
      console.warn('[y-collab] snapshot publish failed:', err?.message)
    }
  }

  // ── Presence (unchanged: ephemeral, server-stamped identity) ───────────────

  setPresence(presence) {
    if (!presence || !this._joined || this._degraded) return
    this._presence = presence
    if (this._presenceTimer) { this._presencePending = true; return }
    this._flushPresence()
    this._presenceTimer = setTimeout(() => {
      this._presenceTimer = null
      if (this._presencePending) { this._presencePending = false; this._flushPresence() }
    }, PRESENCE_DEBOUNCE_MS)
  }

  getRoster() { this._sweepRoster(); return [...this._roster.values()] }

  _flushPresence(heartbeat = false) {
    if (!this._presence || !this._joined) return
    const { displayName, color, cursor } = this._presence
    api.docCollabPresence(this._fileId, { origin: this._peerId, displayName, color, cursor })
      .catch((err) => {
        if (!heartbeat) console.debug?.('[y-collab] presence skipped:', err?.message)
      })
  }

  _applyRemotePresence(payload, origin) {
    if (!payload) return
    if (origin && origin === this._peerId) return
    const accountId = payload.account_id
    if (!accountId) return
    if (payload.gone) {
      if (this._roster.delete(accountId)) this._emitPresence()
      return
    }
    this._roster.set(accountId, {
      accountId,
      displayName: payload.display_name || '',
      color: payload.color || '',
      cursor: payload.cursor || null,
      lastSeen: Date.now(),
    })
    this._emitPresence()
  }

  _sweepRoster() {
    const now = Date.now()
    let changed = false
    for (const [k, v] of this._roster) {
      if (now - (v.lastSeen || 0) > PRESENCE_TTL_MS) { this._roster.delete(k); changed = true }
    }
    if (changed) this._emitPresence()
  }

  _emitPresence() {
    this.dispatchEvent(new CustomEvent('presence', { detail: { roster: [...this._roster.values()] } }))
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  leave() {
    this._joined = false
    this._live = false
    clearTimeout(this._snapTimer)
    clearTimeout(this._publishTimer)
    if (this._presenceTimer) { clearTimeout(this._presenceTimer); this._presenceTimer = null }
    if (this._presenceHeartbeat) { clearInterval(this._presenceHeartbeat); this._presenceHeartbeat = null }
    if (this._presenceSweep) { clearInterval(this._presenceSweep); this._presenceSweep = null }
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
    try { this._ctx.ydoc.off('update', this._onLocalUpdate) } catch { /* already gone */ }
    // Flush the last edit best-effort so a fast unmount doesn't drop it.
    this._flushPublish()
    if (this._presence) {
      try { api.docCollabPresence(this._fileId, { origin: this._peerId, gone: true }) } catch { /* ignore */ }
    }
    this._roster.clear()
    this._presence = null
    if (this._es) { try { this._es.close() } catch { /* ignore */ } this._es = null }
  }

  // ── Read helpers (tests) ──────────────────────────────────────────────────

  /** The current document as ProseMirror JSON (null when unrenderable). */
  docJSON() {
    const res = checkFragmentRenderable(this._ctx.ydoc.getXmlFragment(Y_FRAGMENT), this._ctx.schema)
    return res.ok ? res.json : null
  }
}
