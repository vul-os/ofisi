# Vulos Office — How Collaboration Works

This chapter explains real-time collaboration in Vulos Office end to end: how documents merge concurrent edits (CRDTs), the three transports edits travel over (server relay, peer-to-peer fabric, and end-to-end-encrypted rooms), what is and is not encrypted on each path, how rooms are gated, and what happens on conflicts. It is written for users who want to understand what they're trusting, and for admins who need to know what their server can and cannot see. Everything here describes the actual implementation in this repository.

---

## 1. The one-minute model

- Every edit is turned into a small **CRDT operation** (op). Ops are commutative and idempotent: peers can receive them in any order, more than once, over more than one channel, and still converge to the same document.
- Ops fan out over up to **three transports at once**. Because applying an op twice is a no-op, using several transports simultaneously is safe — it only adds redundancy, never corruption.
- The document you see is always your **local** copy. Collaboration never blocks typing: if nothing is reachable, edits apply locally and sync later.

| Transport | When it's used | Who can read content |
|-----------|----------------|----------------------|
| **Server-mediated (SSE)** | Always, on the account path | The Office server (it persists ops) — gated by per-file ACL |
| **Cloud P2P fabric** | When a peering backend is reachable | Peers in the session; the relay sees plaintext frames |
| **E2E-encrypted P2P room** | "Collaborate via link" / opening a `#vp2p=` invite | Only holders of the invite link's key — relay and server are content-blind |

---

## 2. The CRDTs

All CRDT code lives in `src/lib/crdt/` (frontend) with a mirrored text CRDT on the Go side for server-side awareness.

- **Docs text** — an RGA (Replicated Growable Array) **text CRDT** (`text.js`). Local edits are diffed (`diffToOps`) into insert/delete ops identified by `{replica, counter}` pairs. Apply is idempotent — ops are deduplicated by id — and commutative, so concurrent edits at the same position interleave deterministically instead of conflicting. Character-level merging: two people editing different words of the same paragraph both keep their edits.
- **Sheets grid** — a **last-writer-wins grid CRDT** (`grid.js`): concurrent writes to the *same cell* resolve to the later writer; writes to different cells merge cleanly. Charts, pivots, and conditional-formatting rules are broadcast as their own ops so collaborators merge the same descriptors.
- **Slides tree** — a **fractional-index tree CRDT** (`tree.js`) for slide/object ordering and object properties.
- **Comments and suggestions** have their own CRDTs (`comments.js`, `suggestions.js`) so annotation edits merge like content does.

Ingress is fail-closed: remote text ops are validated (codepoint bounds, no lone UTF-16 surrogates) before apply and silently dropped on failure, so a malformed or hostile op cannot crash the editor.

---

## 3. Transport 1 — server-mediated relay (the account path)

This is the always-available path, and the only one that **persists** ops. Implementation: `src/lib/crdt/serverSession.js` + `src/apps/docs/useServerCollab.js` (client), `backend/handlers/docsync.go` + `backend/realtime/hub.go` + `backend/docsync/` (server).

Endpoints (all under `/v1`, ACL-gated):

| Endpoint | Access required | Purpose |
|----------|-----------------|---------|
| `GET /v1/documents/:id/collab/stream` | read (viewer+) | SSE stream of other editors' ops + presence events |
| `GET /v1/documents/:id/collab/state` | read (viewer+) | Bootstrap snapshot + trailing ops for late joiners |
| `POST /v1/documents/:id/collab/ops` | **editor** | Publish local ops; persisted authoritatively, fanned out |
| `POST /v1/documents/:id/collab/presence` | read (viewer+) | Ephemeral presence/cursor announcement |

Behavior worth knowing:

- **Durability with zero peers**: ops are persisted server-side, so a document converges and stays saved even if no other browser is open, and a late joiner catches up from `/collab/state`.
- **Viewer enforcement**: a viewer can subscribe and show a live caret, but their op `POST` is rejected `403` — the client surfaces read-only mode and stops publishing.
- **No existence leak**: requesting collab on a document you can't read returns `404`, the same as any other inaccessible file.
- **Presence is ephemeral**: presence rides the same hub but is *never written* to the op log; the roster expires entries after ~15 s without a heartbeat (client heartbeats every ~8 s).
- **Batching and limits**: keystroke ops are coalesced client-side (~250 ms) and cursor moves (~120 ms); the server's write/collab endpoints share a per-IP token bucket (burst 30, refill 10/s), so a hot loop can see `429`.
- **Degraded is graceful**: if the SSE stream drops and can't reconnect within ~8 s, the editor shows a degraded status; edits keep applying locally and are re-synced later.
- **Honesty note (from the source itself)**: this is server-mediated *relay + persistence* of CRDT ops, not an operational-transform engine. Convergence comes from the CRDT; the server adds durability, per-document ordering, and fan-out.

**What the server sees on this path: everything.** Ops are plaintext to the Office server — that's what lets it persist and serve them. Access is controlled by the per-file ACL (owner / editor / commenter / viewer), not by encryption.

The server-mediated text-op path is currently wired into **Docs**. Sheets and Slides sync their CRDTs over the peer fabric (below) and persist through normal document saves.

---

## 4. Transport 2 — the cloud P2P fabric (plaintext, low-latency)

Docs (`DocsCollabSession` in `src/lib/crdt/index.js`), Sheets, and Slides (via `src/lib/collab/useCollabFabric.js`) can also connect a `FabricClient` from `@vulos/relay-client`: WebRTC with relay fallback, using these same-origin endpoints for rendezvous:

- Signaling: `wss://<host>/api/peering/stream`
- ICE config: `GET /api/peering/ice`

**Important:** the standalone Office binary does **not** serve `/api/peering/*`. Those endpoints exist when Office runs behind a host that provides the Vulos peering fabric (a Vulos OS / Vulos Relay deployment). On a bare standalone server the fabric client simply fails to configure and the editor stays on the server path (Docs) or local-only with autosave (Sheets/Slides). This is by design — the hook "fails graceful" and no error escapes.

On this path, frames are **not** end-to-end encrypted: transport is TLS, but a relay in the path can read the frames. Session membership is keyed by file id and gated by the same login/ACL context as the app. Presence (avatar roster, live cursors) rides this fabric too, and is merged with server-side presence so nobody is double-counted.

---

## 5. Transport 3 — E2E-encrypted rooms ("Collaborate via link")

This is the privacy-maximal path, implemented in `src/lib/crdt/p2pRoom.js` (crypto) and `src/lib/crdt/p2pSession.js` (session), used by Docs (`useP2PCollab.js`, `P2PShareModal`).

### Room creation and invites

- Sharing mints a random **32-byte room key**.
- The invite payload (version, room id, capability, room key) is base64url-encoded into the **URL fragment**: `…/docs/collab#vp2p=<payload>`. Fragments are never sent in HTTP requests, so **no server ever receives the key**.
- Two links are minted from the *same* key: a **read-write** link (`cap=rw`) and a **read-only** link (`cap=ro`).

### Key derivation and framing

From the single room key, HKDF-SHA256 (WebCrypto, no third-party crypto JS) derives three independent values:

| Derived value | Label | Held by | Purpose |
|---------------|-------|---------|---------|
| `encKey` | `vulos-office-p2p/enc` | rw + ro peers | AES-256-GCM content key — seals every op/snapshot/presence frame |
| `macKeyRw` | (rw label) | **rw peers only** | HMAC proving read-write authority on op frames |
| `roomId` | (room-id label) | everyone incl. relay | Non-secret rendezvous id |

Every frame on the wire is `magic "VP2P1" ‖ flags ‖ 12-byte fresh nonce ‖ AES-256-GCM(ciphertext‖tag)`, with authenticated associated data. The fabric session id is the derived `roomId` — **knowing the roomId admits nothing**; without `encKey` you cannot produce or read a single valid frame.

### What this actually guarantees (and what it doesn't)

Encrypted: document content ops, snapshots, and presence frames. The relay and the Office server are **content-blind**.

- While an E2E session is active, the server-mediated path is **suppressed** (`useServerCollab` is disabled when `e2eActive`), so encrypted-room edits never traverse the readable server relay — this is enforced in code, not just policy.
- Not hidden: the fact that *some* peers share a room (the relay sees `roomId`, peer count, timing, and IP addresses). This is metadata privacy, not anonymity.
- **The link is the key.** Anyone who obtains a link — from a chat log, a forwarded email, a shoulder-surf — has full access at that link's capability. There is no per-person identity inside the room. Treat rw links like passwords.
- **Revocation = rotation.** "Rotate" mints a brand-new room + key and re-shares; old links go dead. There is no finer-grained revocation.
- Read-only is enforced cryptographically at the "authority" level: ro sessions never receive `macKeyRw` (it is stripped before the session is constructed), so an ro peer's op frames carry no RW MAC and rw peers reject them. An ro peer *can* decrypt content (it holds `encKey`) — read-only means "cannot write", not "cannot read".
- A malformed or tampered invite **fails closed**: the join throws, the editor logs `[p2p] join from link failed: …` to the console, and stays in normal local/cloud mode.
- Persistence: each participant's browser snapshots the CRDT to `localStorage` (`vulos_p2p_snap_…`, debounced ~3 s). The room itself stores nothing server-side. Each participant's own copy of the document still autosaves through their normal document save path.

---

## 6. The life of an edit (timings that explain what you see)

What actually happens between a keystroke and your collaborator's screen, with the real constants from the code:

1. **Keystroke** — the editor updates instantly; the change is diffed against the previous text into CRDT ops. Read-only sessions stop here (op production is a no-op for `ro`).
2. **Local persistence** — the session debounces a CRDT snapshot to `localStorage` every **~3 s** (`vulos_srv_snap_*` for the server session, `vulos_p2p_snap_*` for E2E rooms), and the document store writes an IndexedDB draft before every network save.
3. **Publish** — server path: ops are coalesced for **~250 ms** and POSTed in one batch (bounding request rate under the per-IP token bucket). P2P paths: ops are sealed and sent frame-by-frame.
4. **Fan-out** — the server hub relays to every SSE subscriber of that one document (strictly per-doc; no cross-document leakage). A subscriber that can't keep up (slow consumer) is dropped and its client transparently reconnects and re-bootstraps from `/collab/state`.
5. **Apply** — receiving peers validate then apply the ops; duplicates (same op over two transports) are no-ops.
6. **Presence** — cursor moves are coalesced to at most one POST per **~120 ms**; every client re-announces itself every **~8 s**; a roster entry not heard from for **~15 s** is dropped (that's how a crashed tab disappears). Presence is never persisted.
7. **Reconnect** — if the SSE stream drops and cannot reopen within **~8 s**, the editor reports itself not-live (degraded), keeps applying edits locally, and converges when the stream returns.

### A worked example

Alice (editor) and Bob (editor) both have `Q3 Plan` open; Carol (viewer) is watching.

- Alice types "risks" into paragraph 2 while Bob deletes a sentence in paragraph 4 — both see their own change instantly, and each other's within a network round-trip. The RGA merge keeps both; no dialog, no lock.
- Carol's caret is visible to both (presence), but if her client somehow POSTs an op it is refused `403` server-side.
- Bob's laptop sleeps. Alice keeps editing. Bob wakes 10 minutes later: his session re-opens the stream, bootstraps from `/collab/state`, replays Alice's ops, and pushes his buffered ones. Both converge.
- That evening, Alice opens the doc on her tablet, edits *without* live collab, and saves. Meanwhile her desktop tab (stale) tries to save the old revision — the server answers `409 Conflict` and the desktop reconciles against the current revision before retrying. Nothing is clobbered; every save also left a restorable version snapshot.

---

## 7. Conflict behavior — what happens when edits collide

**Live collaboration (character level):** no locking, no "someone else is editing" dialogs. Concurrent inserts/deletes merge via the RGA CRDT; both sides' edits survive. In Sheets, two simultaneous writes to the *same cell* resolve last-writer-wins; different cells always both apply.

**Duplicate delivery:** an op arriving over both the fabric and the server (or twice over one) applies once — dedup by op id.

**Offline divergence:** each side keeps editing locally; buffered ops exchange on reconnect (`snap-req`/`snap` on the p2p path, `/collab/state` bootstrap on the server path) and converge. Nothing is discarded.

**Whole-document saves (revision CAS):** independent of live collab, every file save carries the revision it was based on. A stale save gets `409 Conflict` with the current server copy instead of clobbering it — the client store reconciles (`onConflict`) and retries against the current revision. This protects the "two devices, no live session" case.

**Undo:** undo operates on your local history; a remote peer's edits are not undone by your `Mod+Z`.

**Version history as the backstop:** every save produces restorable version snapshots with diffs, so even a merge that is *semantically* wrong (both of you renamed the same heading differently) is recoverable by a human.

---

## 8. Room gating and access control — admin summary

Three distinct gates, one per transport:

1. **Server path** — the per-file ACL (`backend/fileacl/`): roles `viewer` < `commenter` < `editor`, plus `owner`. Grants are owner-gated server-side, changes land in the append-only **audit log** (visible in the admin panel), and no-access responses are `404` to avoid existence leaks. Read-only **share links** (256-bit token, optional bcrypt-hashed password, expiry capped at one year) reach *only* the read path.
2. **Cloud fabric** — available only where an admin has deployed the peering backend (Vulos OS / Relay). No fabric backend ⇒ no plaintext p2p, automatically.
3. **E2E rooms** — possession of the invite fragment. The server cannot enumerate, join, or read rooms; it also cannot audit them. If your compliance posture requires all collaboration to be server-auditable, the E2E path is the one to communicate policy about — it is a deliberate user-controlled escape hatch.

Rate limiting: collab writes share the global write token bucket (per-IP, burst 30, refill 10/s); presence has its own generous bucket. Both can be disabled with the server flag `--no-rate-limit-writes` for trusted internal tooling.

---

## 9. Presence and cursors

- The presence bar shows everyone in the document (avatar stack + roster); remote carets/selections render in the text with per-user colors.
- Presence is transport-merged: p2p roster and server roster fold together keyed by account, so a peer reachable both ways appears once.
- Server-side presence is **identity-stamped by the server** (a client cannot claim to be someone else on the account path) and never persisted.
- On the E2E path, presence frames are sealed like everything else — the server does not learn who is in an encrypted room.

---

## 10. Verifying it yourself (admins)

You can watch every layer from the outside:

```bash
# 1. Is the server relay alive for a doc you can read? (SSE — leave it running)
curl -N -H "Authorization: Bearer <session-jwt>" \
  "https://office.example.org/v1/documents/<id>/collab/stream"

# 2. Bootstrap state a late joiner would receive
curl -H "Authorization: Bearer <session-jwt>" \
  "https://office.example.org/v1/documents/<id>/collab/state"

# 3. Confirm viewer enforcement: publish ops with a viewer token → expect 403
curl -X POST -H "Authorization: Bearer <viewer-jwt>" -H 'Content-Type: application/json' \
  -d '{"ops":[]}' "https://office.example.org/v1/documents/<id>/collab/ops"

# 4. Is the peering fabric present? (host-provided, not the Office binary)
curl -i "https://office.example.org/api/peering/ice"    # 404 ⇒ standalone, no P2P
```

In the browser, DevTools → Network shows exactly which of the three paths is live: an open `collab/stream` request (server), a WebSocket to `/api/peering/stream` (fabric), and — for E2E rooms — a `#vp2p=` fragment in the address bar with *no* `collab/ops` traffic.

---

## 11. Frequently asked questions

**Can the admin read my E2E room?** No — frames are AES-256-GCM sealed under a key that only exists in invite links (URL fragments never reach the server). The admin *can* see that a room exists (its derived id, peer count, timing, IPs) if the relay is theirs.

**Can the admin read normal shared documents?** Yes. The account path is server-persisted plaintext, gated by ACLs — that's what makes durability, late-join, and audit possible. If you need the server blind, use *Collaborate via link*.

**Why does my read-only link let people read but "read-only" is called enforcement?** Two different mechanisms: on the server path, roles are enforced by the server (`403` on viewer writes). In E2E rooms, ro peers hold the decryption key but not the RW MAC key, so their write frames are unauthenticated and rw peers discard them.

**Is there a maximum number of collaborators?** No explicit cap in the collab code; the practical bounds are the per-IP write token bucket (burst 30, 10/s refill) and SSE fan-out capacity of your deployment.

**Does collaboration work across two different Office servers?** Not for the server path — ops persist on the server that owns the document. Cross-instance sharing goes through account-scoped sharing on one instance, a read-only share link, or an E2E room whose peers can all reach the same peering fabric. (`/v1` sharing to a recipient on another cell responds with an explicit "recipient is not on this cell; share via peering" error.)

**What happens if two people paste huge different texts simultaneously?** Both op sets apply; the RGA interleaves deterministically by op identity. The result is both texts present (order decided by the CRDT), never a corrupted mix of half of each.

---

## 12. What is stored where

Collaboration touches four kinds of state; knowing which is which explains most recovery questions:

| State | Location | Lifetime |
|-------|----------|----------|
| The document itself | Server document store (`data/<id>.json` or Postgres schema `office`) | Until deleted; every save also snapshots into version history |
| Server collab op log | `backend/docsync` store on the server (durable, per-document ordered) | Authoritative record of the account path's ops |
| Presence (who's here, cursors) | In-memory hub only | Seconds — never written anywhere |
| E2E room state | Participants' browsers only: `localStorage` CRDT snapshots (`vulos_p2p_snap_*`) + each user's own account saves | Per-browser; the server holds nothing for the room |
| Crash-safety drafts | Browser IndexedDB (`vulos-office-drafts`) | Until the next successful save |
| Server session snapshots | Browser `localStorage` (`vulos_srv_snap_*`) | Rolling, debounced ~3 s |

Consequences: server backups capture all account-path collaboration; they never capture E2E room traffic (there is nothing to capture); clearing a browser's site data erases drafts and local snapshots but never the saved document.

---

## 13. Glossary

- **CRDT** — Conflict-free Replicated Data Type: a data structure whose operations commute, so replicas converge without coordination or locks.
- **RGA** — Replicated Growable Array, the text CRDT used for Docs.
- **Op** — one atomic CRDT change (e.g. "insert char with id {replica,counter} after X").
- **SSE** — Server-Sent Events; the one-way HTTP stream carrying ops/presence down from the server.
- **Fabric** — the Vulos peering transport (`@vulos/relay-client`): WebRTC with relay fallback, rendezvous via `/api/peering/stream`.
- **Room** — an E2E-encrypted collaboration session identified by a key-derived `roomId`; membership = possession of the invite key.
- **Capability (`rw`/`ro`)** — what an invite link grants; `rw` links carry MAC authority to write, `ro` links can only decrypt.
- **Rotation** — minting a fresh room + key to revoke all previously shared links.

---

## 14. Quick reference — "which path am I on?"

| You did… | Path | Server can read content? |
|----------|------|--------------------------|
| Shared with a teammate's account, both editing | Server SSE (+ fabric if available) | **Yes** (ACL-gated, persisted) |
| Opened a doc on a Vulos OS box with Relay | Fabric + server SSE | **Yes** |
| Clicked *Collaborate via link* / opened a `#vp2p=` link | E2E room only (server path suppressed) | **No** — content-blind |
| Created a read-only share link | Anonymous read endpoint | Yes (it serves the content) |
| No network at all | Local CRDT + IndexedDB draft | n/a — syncs when back |

For symptoms and fixes (peers not connecting, docs not syncing), see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
