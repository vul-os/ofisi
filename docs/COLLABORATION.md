# Vulos Office — How Collaboration Works

This chapter explains real-time collaboration in Vulos Office end to end: how documents merge concurrent edits (CRDTs), how edits travel **peer-to-peer** with no central document server, what is and is not encrypted, how rooms are gated, and what happens on conflicts. It is written for users who want to understand what they're trusting, and for admins who need to know what their server can and cannot see. Everything here describes the actual implementation in this repository.

---

## 1. The one-minute model

- Collaboration in Office is **always peer-to-peer**. There is **no central document server** — no server ever stores, relays, or reads your document's collaborative edits. This is the defining difference from server-mediated office suites (Collabora, OnlyOffice), where every keystroke passes through a document server.
- Every edit becomes a small **CRDT update**. CRDT updates are commutative and idempotent: peers can receive them in any order, more than once, over more than one channel, and still converge to the same document.
- The document you see is always your **local** copy, hydrated from your own saved content. Collaboration never blocks typing: if no peer is reachable, you keep editing locally and your changes autosave to your own storage.
- When you collaborate, edits ride an **end-to-end-encrypted peer-to-peer room**. Peers connect **directly** to each other over WebRTC; a relay is used only as a last-resort fallback for hard NATs, and even then it is **content-blind** (it moves ciphertext it cannot read).

| What travels | Where it goes | Who can read it |
|--------------|---------------|-----------------|
| Your document's collaborative edits | Directly between peers (WebRTC), E2E-encrypted | Only peers holding the invite key |
| Fallback when peers can't connect directly | A content-blind relay circuit (ciphertext only) | Nobody but the peers — the relay is blind |
| Peer discovery (rendezvous) | The host's signaling + ICE endpoints | The host learns *that* peers share a room (a random id) — never content |
| Your own saved copy | Your own file storage (your box) | You (and whomever you grant account access) |

---

## 2. The CRDTs

All CRDT code lives in `src/lib/crdt/` (frontend).

- **Docs** — a **Yjs** document (`ydoc.js`). The ProseMirror/TipTap document is kept in lock-step with a `Y.XmlFragment` by y-prosemirror. Remote changes arrive as Yjs updates and become ProseMirror transactions with real positions — so **formatting and structure** (bold, headings, tables, lists, images, links) propagate correctly, and a remote change can never land at a wrong text offset. Yjs is a CRDT, so peers converge with **no central authority** — exactly what a serverless model requires.
- **Whiteboards** — a **Yjs** scene (`boardYdoc.js`): Excalidraw elements live one-per-id in a `Y.Map` so concurrent edits to *different* shapes merge cleanly, and image blobs in a second `Y.Map`. The whiteboard rides the **same** `yP2PSession` transport, the same E2E-encrypted room and the same content-blind relay fallback as Docs — there is **no** separate whiteboard/collab server. The session validates an untrusted peer's update through a fail-closed board validator (element/file ceilings + a raster-only image allow-list) instead of the ProseMirror one; the seam is a pluggable `applyUpdate` on the Y context.
- **Sheets grid** — a **last-writer-wins grid CRDT** (`grid.js`): concurrent writes to the *same cell* resolve to the later writer; writes to different cells merge cleanly. Charts, pivots, and conditional-formatting rules broadcast as their own ops.
- **Slides tree** — a **fractional-index tree CRDT** (`tree.js`) for slide/object ordering and object properties.
- **Comments and suggestions** have their own CRDTs (`comments.js`, `suggestions.js`).

**Ingress is fail-closed.** Every inbound update is untrusted (an invite link can be forwarded to anyone). It is decoded, applied to a **shadow document** first, converted to a ProseMirror document against the real schema, and checked (renderable? image/link clamps?) before it is allowed to touch the live document. A rejected update is dropped and counted; it never throws, never half-applies, and never reaches the renderer.

---

## 3. The transport — direct peer-to-peer first, content-blind relay only as fallback

Office uses a `FabricClient` from `@vulos/relay-client` to move CRDT updates between peers. Its connection strategy, in order:

1. **Direct WebRTC data channel (the default).** For each peer, the client negotiates an `RTCPeerConnection` and opens a data channel. Once connected (`connectionState === 'connected'`), edits flow **directly browser-to-browser** — nothing in the middle. NAT traversal uses **ICE/STUN** servers the host provides.
2. **Content-blind relay circuit (fallback only).** If the direct connection *fails* (symmetric NAT, restrictive firewall — the ~10–20 % of pairs that can't hole-punch), the client falls back to a relay circuit. Payloads on this path are sealed with a per-session X25519 box, so the relay **routes ciphertext it cannot read**. This fallback is the *only* time a relay is involved, and it still never sees plaintext.

The only always-needed server pieces are **lightweight, content-blind peer discovery**:

- Signaling (rendezvous): `wss://<host>/api/peering/stream` — exchanges WebRTC offer/answer/ICE candidates so two peers can find each other. It carries no document content.
- ICE config: `GET /api/peering/ice` — returns the STUN/TURN servers to use for NAT traversal.

**Important:** the standalone Office binary does **not** serve `/api/peering/*`. Those endpoints are provided by the **host** — a Vulos OS / Vulos Relay deployment. On a bare standalone server with no host fabric, peers cannot discover each other, so collaboration stays **local-only** (you keep editing; your work autosaves) and the UI says so honestly rather than showing a false "Live". Self-hosting the discovery + a STUN/TURN server (e.g. coturn) is enough to get direct P2P working for your own users; it stores nothing and reads nothing.

---

## 4. E2E-encrypted rooms ("Collaborate via link")

Collaboration is entered by sharing an **invite link**. Implementation: `src/lib/crdt/p2pRoom.js` (crypto), `src/lib/crdt/yP2PSession.js` (the Yjs document over the room), `src/apps/docs/useP2PCollab.js` + `P2PShareModal` (Docs UI).

### Room creation and invites

- Sharing mints a random **32-byte room key**.
- The invite payload (version, room id, capability, room key) is base64url-encoded into the **URL fragment**: `…/docs/collab#vp2p=<payload>`. Fragments are never sent in HTTP requests, so **no server ever receives the key**.
- Two links are minted from the *same* key: a **read-write** link (`cap=rw`) and a **read-only** link (`cap=ro`).

### Key derivation and framing

From the single room key, HKDF-SHA256 (WebCrypto, no third-party crypto JS) derives three independent values:

| Derived value | Held by | Purpose |
|---------------|---------|---------|
| `encKey` | rw + ro peers | AES-256-GCM content key — seals every update/presence frame |
| `macKeyRw` | **rw peers only** | HMAC proving read-write authority on document frames |
| `roomId` | everyone incl. relay | Non-secret rendezvous id |

Every frame on the wire is `magic "VP2P1" ‖ flags ‖ 12-byte fresh nonce ‖ AES-256-GCM(ciphertext‖tag)`, with authenticated associated data. The fabric session id is the derived `roomId` — **knowing the roomId admits nothing**; without `encKey` you cannot produce or read a single valid frame.

### What this guarantees (and what it doesn't)

Encrypted: document updates, snapshots (state-vector deltas), and presence frames. The relay and the host are **content-blind**.

- **The link is the key.** Anyone who obtains a link — from a chat log, a forwarded email, a shoulder-surf — has full access at that link's capability. There is no per-person identity inside the room. Treat rw links like passwords.
- **Revocation = rotation.** "Rotate" mints a brand-new room + key and re-shares; old links go dead. There is no finer-grained revocation.
- **Read-only is enforced cryptographically.** ro sessions never receive `macKeyRw` (it is stripped before the session is constructed), so an ro peer's update frames carry no RW MAC and rw peers reject them. An ro peer *can* decrypt content (it holds `encKey`) — read-only means "cannot write", not "cannot read".
- **Not hidden:** the fact that *some* peers share a room (the discovery service sees `roomId`, peer count, timing, IPs). This is metadata, not content.
- A malformed or tampered invite **fails closed**: the join throws, the editor logs `[p2p] join from link failed: …`, and stays in local mode.
- **Persistence is yours.** The room stores nothing anywhere central. Each participant's own copy autosaves through their normal document save path (to their own storage); a browser-local snapshot aids offline recovery.

---

## 5. The life of an edit

1. **Keystroke** — the editor updates instantly; the change becomes a Yjs update. Read-only sessions stop here (they produce no authoritative updates).
2. **Seal + send** — the update is sealed (AES-256-GCM, fresh nonce) and sent over the room: directly to each connected peer's WebRTC data channel, or over the content-blind relay circuit if direct failed.
3. **Apply** — receiving peers run the update through the fail-closed ingress (shadow-apply → validate → live-apply). Duplicates are no-ops (Yjs dedups by `(client, clock)`).
4. **Late joiners & reconnects** — on join (and after any reconnect) a peer sends its **state vector**; peers answer with exactly the delta it lacks. Two peers who both edited offline both keep their edits — a union merge, never "whoever has more wins".
5. **Presence** — cursor moves are coalesced (~120 ms); a roster entry not heard from for ~15 s is dropped (that's how a crashed tab disappears). Presence rides the same E2E room; it is never persisted.
6. **Autosave** — independently, your own copy autosaves to your storage with a crash-safe IndexedDB draft, and every save leaves a restorable version snapshot.

### A worked example

Alice (rw) shares a `#vp2p=` link with Bob (rw); Carol opens the ro link.

- Alice types "risks" into paragraph 2 while Bob deletes a sentence in paragraph 4 — both see their own change instantly, and each other's within a WebRTC round-trip. Yjs keeps both; no dialog, no lock.
- Carol's caret is visible (presence), but her write frames carry no RW MAC, so Alice and Bob discard them — she reads live, cannot write.
- Bob's laptop sleeps. Alice keeps editing. Bob wakes 10 minutes later: his session reconnects and sends its state vector; Alice's peer answers with exactly the edits he missed. Both converge — with no server involved.

---

## 6. Conflict behavior

**Live collaboration:** no locking, no "someone else is editing" dialogs. Concurrent edits merge via Yjs; both sides' edits survive. In Sheets, two simultaneous writes to the *same cell* resolve last-writer-wins; different cells always both apply.

**Duplicate delivery:** an update arriving over both a direct channel and the relay applies once — dedup by `(client, clock)`.

**Offline divergence:** each side keeps editing locally; on reconnect the state-vector exchange fetches exactly what each side missed and converges. Nothing is discarded.

**Whole-document saves (revision CAS):** independent of live collab, every file save carries the revision it was based on. A stale save gets `409 Conflict` with the current copy instead of clobbering it — the client reconciles and retries. This protects the "two devices, no live session" case.

**Undo:** undo operates on your own edits (the Yjs UndoManager is user-scoped); a remote peer's edit is not undone by your `Mod+Z`.

**Version history as the backstop:** every save produces restorable version snapshots with diffs, so even a semantically-wrong merge is recoverable by a human.

---

## 7. Access control — admin summary

- **Account sharing (the ACL)** — `backend/fileacl/`: roles `viewer` < `commenter` < `editor`, plus `owner`. Grants are owner-gated server-side, land in the append-only **audit log**, and no-access responses are `404` to avoid existence leaks. Read-only **share links** (256-bit token, optional bcrypt-hashed password, expiry capped at one year) reach *only* the anonymous read path. This governs who may open the document from **your storage** — it does **not** put a server in the live-collaboration path.
- **Live collaboration** — possession of the invite fragment. The host cannot enumerate, join, or read rooms; it also cannot audit their content. If your compliance posture requires all collaboration to be server-auditable, note that Office's collaboration is deliberately end-to-end and peer-to-peer — auditing happens at the account-save and version-history layer, not in the wire.
- **Peer discovery** is available only where a host provides the peering fabric (Vulos OS / Relay). No fabric ⇒ no live P2P, automatically — the editor stays local-only.

---

## 8. Presence and cursors

- The presence bar shows everyone in the room (avatar stack + roster); remote carets/selections render in the text with per-user colors.
- Presence rides the E2E-encrypted room like everything else — the host does not learn who is in a room.
- Presence is ephemeral: it is never persisted anywhere.

---

## 9. Verifying it yourself (admins)

You can confirm the serverless property from the outside:

```bash
# 1. There is NO server-mediated collab endpoint. These must 404:
curl -i "https://office.example.org/v1/documents/<id>/collab/stream"   # expect 404
curl -i "https://office.example.org/v1/documents/<id>/collab/ops"      # expect 404

# 2. Is the peering fabric present? (host-provided, not the Office binary)
curl -i "https://office.example.org/api/peering/ice"   # 404 ⇒ standalone, no P2P discovery
```

In the browser, DevTools → Network shows the truth: opening a `#vp2p=` link opens a **WebSocket to `/api/peering/stream`** (discovery only) and then a **WebRTC data channel** — and **no `collab/*` request ever appears**, because there is no document server to call. The document bytes travel inside the encrypted data channel, not any HTTP request.

---

## 10. Frequently asked questions

**Does my document ever touch a central server during collaboration?** No. Collaborative edits travel peer-to-peer, end-to-end-encrypted. The only server role is content-blind peer discovery (a rendezvous id and ICE config). Your saved copy lives in *your* storage.

**Can the admin read what we're editing live?** No — frames are AES-256-GCM sealed under a key that only exists in invite links (URL fragments never reach the server). The admin *can* see that a room exists (its derived id, peer count, timing, IPs) if the discovery service and relay are theirs.

**Can the admin read my saved document?** They can read what your storage holds, gated by the account ACL — that is ordinary file access, not collaboration. Collaboration itself is content-blind.

**Why is read-only "enforcement" if ro users can still read?** ro peers hold the decryption key but not the RW MAC key, so their write frames are unauthenticated and rw peers discard them. Read-only means "cannot write".

**Is there a maximum number of collaborators?** No explicit cap in the collab code; the practical bound is WebRTC mesh fan-out (each peer connects to the others) and your discovery/relay capacity.

**Does collaboration work across two different Office servers?** Yes, as long as the peers can reach the same peering fabric — collaboration is between *browsers*, not servers. The document does not live on either server for the purpose of the live session.

**What happens with no network at all?** You keep editing; the CRDT applies locally and an IndexedDB draft protects your work. It syncs to peers when you reconnect, and autosaves to your storage.

---

## 11. What is stored where

| State | Location | Lifetime |
|-------|----------|----------|
| The document itself | **Your** file storage (`data/<id>.json` or Postgres schema `office`) | Until deleted; every save also snapshots into version history |
| Live collaboration edits | **Nowhere central** — only in the peers' browsers, in transit E2E-encrypted | The session; the host holds nothing |
| Presence (who's here, cursors) | In the peers' browsers only | Seconds — never written anywhere |
| Room recovery snapshot | Participant's browser `localStorage` | Per-browser; the server holds nothing for the room |
| Crash-safety drafts | Browser IndexedDB (`vulos-office-drafts`) | Until the next successful save |

Consequences: server backups capture your saved documents and version history; they never capture live collaboration traffic (there is nothing to capture). Clearing a browser's site data erases drafts and local snapshots but never the saved document.

---

## 12. Glossary

- **CRDT** — Conflict-free Replicated Data Type: a data structure whose operations commute, so replicas converge without coordination or locks.
- **Yjs** — the CRDT library backing the Docs document; carries structure and formatting, not just text.
- **Update** — one atomic Yjs change, carried as an envelope `{ y:1, u:<base64> }`.
- **Fabric** — the Vulos peering transport (`@vulos/relay-client`): direct WebRTC first, content-blind relay fallback, discovery via `/api/peering/*`.
- **Room** — an E2E-encrypted collaboration session identified by a key-derived `roomId`; membership = possession of the invite key.
- **Capability (`rw`/`ro`)** — what an invite link grants; `rw` links carry MAC authority to write, `ro` links can only decrypt.
- **Rotation** — minting a fresh room + key to revoke all previously shared links.
- **STUN / TURN** — NAT-traversal helpers; STUN discovers your public address for a direct connection, TURN relays (content-blind here) when direct fails.

---

## 13. Quick reference — "what can the server see?"

| You did… | Live path | Server can read live edits? |
|----------|-----------|-----------------------------|
| Clicked *Collaborate via link* / opened a `#vp2p=` link, peers connect directly | Direct WebRTC, E2E | **No** — content-blind, and no server is even in the path |
| Same, but a peer pair can't hole-punch | Content-blind relay fallback, E2E | **No** — the relay routes ciphertext |
| No peering fabric on the host (bare standalone) | Local-only (autosave) | n/a — nothing is sent |
| Created a read-only share link | Anonymous read endpoint | Yes (it serves your saved copy) |
| No network at all | Local CRDT + IndexedDB draft | n/a — syncs when back |

For symptoms and fixes (peers not connecting, docs not syncing), see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
