/**
 * src/lib/crdt/serverSession.js — WAVE37 server-mediated collaboration session.
 *
 * ServerCollabSession is the CLOUD / account collaboration path. It mirrors the
 * public API of DocsCollabSession (index.js) — `applyLocal(prev, next)`,
 * `getText()`, `join()`, `leave()`, and `'change'` events — but instead of the
 * peer-to-peer FabricClient it speaks the ACL-gated server relay:
 *
 *   - DOWN: an SSE stream (GET /v1/documents/:id/collab/stream) pushes CRDT ops
 *     that OTHER authorized editors published. We apply them to the SAME RGA
 *     TextCRDT the p2p/cloud sessions use — TextCRDT.apply is idempotent (dedup
 *     by op id {r,c}), so an op that also arrived over p2p never double-applies.
 *   - UP: local edits are diffed to CRDT ops (identical diffToOps as index.js)
 *     and POSTed to /v1/documents/:id/collab/ops. The server persists them
 *     authoritatively and relays them to the other editors. Editor-gated: a
 *     viewer's POST is rejected 403 (we surface `readOnly` and stop publishing).
 *   - BOOTSTRAP: on join we GET /collab/state (the server's snapshot + trailing
 *     ops) so a late joiner catches up to current state even with ZERO p2p peers.
 *
 * Why this exists (the gap it closes): the p2p path (FabricClient) degrades to
 * LOCAL-ONLY when no relay/peer is reachable — two editors then diverge and only
 * localStorage saves. This session provides a server fallback/complement so the
 * account path stays in sync + saved regardless of p2p reachability. It does NOT
 * replace p2p: the E2E-encrypted p2p path is deliberately NOT routed through
 * this readable server (see useServerCollab.js for the p2p-vs-server decision).
 *
 * Honesty note: this is server-mediated RELAY + PERSISTENCE of the existing RGA
 * CRDT, NOT a full OT engine. Convergence is provided by the RGA CRDT itself
 * (idempotent, commutative apply); the server guarantees durability, per-doc
 * ordering, and fan-out.
 */

import { TextCRDT } from './text.js'
import { diffToOps } from './index.js'
import { api } from '../api.js'

const SNAP_KEY_PREFIX = 'vulos_srv_snap_'
const SNAPSHOT_DEBOUNCE_MS = 3000
// Coalesce rapid keystroke ops into one POST to bound request rate (the server
// write surface is token-bucket limited).
const PUBLISH_DEBOUNCE_MS = 250
// If the SSE stream drops and cannot re-open within this window we treat it as
// "not live" so the caller can reflect degraded status.
const RECONNECT_GRACE_MS = 8000

export class ServerCollabSession extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.fileId  document id (server sync channel key)
   * @param {string} opts.peerId  stable per-tab id (CRDT replicaId + op origin)
   */
  constructor({ fileId, peerId }) {
    super()
    this._fileId = fileId
    this._peerId = peerId
    this._crdt = new TextCRDT(peerId)

    this._joined = false
    this._live = false
    this._readOnly = false
    this._es = null
    this._graceTimer = null
    this._snapTimer = null

    // Outbound op batching.
    this._pendingOps = []
    this._publishTimer = null
    // Server-assigned sequence high-water mark we've observed (informational).
    this._seq = 0
  }

  // ─── Public API (mirrors DocsCollabSession) ─────────────────────────────────

  /** True while the SSE stream is open. */
  get live() { return this._live }
  /** True once a publish was rejected as read-only (viewer/commenter). */
  get readOnly() { return this._readOnly }

  /** Connect: restore local snapshot, bootstrap from server, open the stream. */
  async join() {
    if (this._joined) return
    this._joined = true

    // Restore last local snapshot (offline / cold start) before bootstrapping.
    this._restoreSnapshot()

    // Late-joiner bootstrap: pull the server's authoritative current state.
    await this._bootstrap()

    // Open the live server-push stream.
    this._openStream()
  }

  /**
   * Diff prevText→nextText into CRDT ops, apply locally, and queue them for the
   * server relay. Same contract as DocsCollabSession.applyLocal. Returns the ops.
   */
  applyLocal(prevText, nextText) {
    if (this._readOnly) return []
    const ops = diffToOps(prevText, nextText, this._crdt)
    if (ops.length === 0) return ops
    for (const op of ops) this._pendingOps.push(op)
    this._schedulePublish()
    this._scheduleSnapshotFlush()
    return ops
  }

  /** Current visible text from the CRDT. */
  getText() { return this._crdt.toString() }

  /** Disconnect and release resources. */
  leave() {
    this._joined = false
    this._live = false
    clearTimeout(this._snapTimer)
    clearTimeout(this._publishTimer)
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
    // Flush any pending ops best-effort so a fast unmount doesn't drop the last edit.
    this._flushPublish()
    if (this._es) { try { this._es.close() } catch { /* ignore */ } this._es = null }
  }

  // ─── Bootstrap (late joiner) ────────────────────────────────────────────────

  async _bootstrap() {
    let state
    try {
      state = await api.docCollabState(this._fileId)
    } catch (err) {
      // No server sync available (offline, endpoint down, self-host without the
      // route) — degrade to local-only. The editor still saves via autosave.
      console.warn('[server-collab] bootstrap failed (local-only):', err?.message)
      return
    }
    let changed = false
    // MERGE the compaction snapshot (union), never a count-gated restore(). If a
    // user edited OFFLINE, their local snapshot holds nodes the server's snapshot
    // lacks; the old "restore only if server snap is larger" replaced (and thus
    // DROPPED) those offline edits, or skipped the server state entirely when the
    // local count happened to be higher. merge() folds the server nodes in via
    // idempotent RGA apply so the offline edits survive and still converge.
    if (state?.snap) {
      if (this._crdt.merge(state.snap)) changed = true
    }
    // Then replay trailing ops (idempotent — dedups by op id).
    for (const rec of state?.ops || []) {
      if (rec?.op && this._crdt.apply(rec.op)) changed = true
      if (typeof rec?.seq === 'number' && rec.seq > this._seq) this._seq = rec.seq
    }
    if (typeof state?.seq === 'number' && state.seq > this._seq) this._seq = state.seq
    if (changed) {
      this.dispatchEvent(new CustomEvent('change', { detail: { text: this._crdt.toString(), remote: true } }))
      this._scheduleSnapshotFlush()
    }
  }

  // ─── Inbound: SSE stream ────────────────────────────────────────────────────

  _openStream() {
    if (typeof EventSource === 'undefined') {
      // No EventSource (SSR/test) — bootstrap already ran; stay poll-free/local.
      return
    }
    let es
    try {
      es = new EventSource(api.docCollabStreamUrl(this._fileId), { withCredentials: true })
    } catch (err) {
      console.warn('[server-collab] stream open failed (local-only):', err?.message)
      return
    }
    this._es = es

    es.onopen = () => { this._clearGrace(); this._live = true }
    es.onerror = () => { this._markNotLive() } // EventSource auto-reconnects
    es.onmessage = (e) => {
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (!ev || !ev.type) return
      if (ev.type === 'ping') {
        this._clearGrace(); this._live = true
        return
      }
      if (ev.type === 'op' && ev.payload) {
        // Drop our own echo — we already applied it locally in applyLocal.
        if (ev.origin && ev.origin === this._peerId) return
        if (typeof ev.seq === 'number' && ev.seq > this._seq) this._seq = ev.seq
        // Idempotent apply → dedup by op id, safe even if a p2p peer also
        // delivered this same op.
        if (this._crdt.apply(ev.payload)) {
          this.dispatchEvent(new CustomEvent('change', { detail: { text: this._crdt.toString(), remote: true } }))
          this._scheduleSnapshotFlush()
        }
      }
    }
  }

  _markNotLive() {
    if (this._graceTimer) return
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null
      this._live = false
    }, RECONNECT_GRACE_MS)
  }
  _clearGrace() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null }
  }

  // ─── Outbound: op publish (batched) ─────────────────────────────────────────

  _schedulePublish() {
    if (this._publishTimer) return
    this._publishTimer = setTimeout(() => { this._publishTimer = null; this._flushPublish() }, PUBLISH_DEBOUNCE_MS)
  }

  _flushPublish() {
    if (this._pendingOps.length === 0) return
    const batch = this._pendingOps
    this._pendingOps = []
    api.docCollabPublish(this._fileId, { origin: this._peerId, ops: batch })
      .then((res) => {
        if (res && typeof res.seq === 'number' && res.seq > this._seq) this._seq = res.seq
      })
      .catch((err) => {
        if (err?.status === 403) {
          // Editor-gated: we're a viewer/commenter. Stop publishing; still
          // receive relayed ops read-only. (Matches the wave-14 requireEditor
          // gate — a viewer must not push ops.)
          this._readOnly = true
          this.dispatchEvent(new CustomEvent('readonly', { detail: {} }))
          return
        }
        // Transient failure (offline, endpoint down): the ops are already in the
        // local CRDT and localStorage snapshot; re-queue so a later flush retries
        // rather than losing them.
        this._pendingOps = batch.concat(this._pendingOps)
        console.warn('[server-collab] publish failed (will retry):', err?.message)
      })
  }

  // ─── Snapshot persistence (localStorage, offline recovery) ──────────────────

  _snapKey() { return SNAP_KEY_PREFIX + this._fileId }

  _restoreSnapshot() {
    try {
      const raw = localStorage.getItem(this._snapKey())
      if (!raw) return
      this._crdt.restore(JSON.parse(raw))
    } catch { /* corrupt snapshot — ignore */ }
  }

  _scheduleSnapshotFlush() {
    clearTimeout(this._snapTimer)
    this._snapTimer = setTimeout(() => {
      try {
        localStorage.setItem(this._snapKey(), JSON.stringify(this._crdt.snapshot()))
      } catch { /* storage full — best-effort */ }
    }, SNAPSHOT_DEBOUNCE_MS)
  }
}
