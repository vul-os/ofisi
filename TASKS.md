# Vulos Office — Task Backlog

**Status: 35 / 35 tasks done (100%).** Office Core, Real-time Collaboration (CRDT +
fabric), PDF Auto-Sign, and Vulos Spaces (channels, calls, screen-share, meetings) are
all shipped. Design-system pillar applied to core surfaces (see `src/design/DESIGN.md`
§9); remaining surfaces deferred to the next pass (§10).

Actionable work for autonomous coding agents, grouped by area and
**priority-ordered**. Vulos Office is the productivity surface of the Vulos
project: Documents / Sheets / Slides / PDF today, growing into a networked office
(real-time collaboration, e-signature, and a chat+meetings pillar) that rides the
**Vulos peer fabric** — the same CRDT-bucket + WebRTC + relay/TURN transport the
OS uses for device routing.

> **Stack invariants (FROZEN):** Go backend (`vulos-office`, Gin); React 18 / Vite
> / Tailwind frontend, **JSX only — NEVER `.tsx`**; MIT license. Collaboration,
> chat, and calling reuse the Vulos fabric (cr-sqlite/CRDT sync to buckets,
> WebRTC P2P, **Vulos relay/TURN fallback** — see vulos-cloud RELAY signaling),
> NOT a bespoke server. Local single-binary mode needs no account and emits no
> telemetry. Frontend embeds into the Go binary; `go build ./... && npm run build`
> is the universal gate.

---

## How to read a task

```
### [OFFICE-NN] short title
`todo` · P0|P1|P2|P3 · S|M|L · dep: <IDs or none> · parallel: yes|no — owned file path(s)
Scope: one paragraph; enough for an autonomous agent.
AC: [ ] verifiable outcome [ ] … [ ] go build ./... && npm run build (or the stated gate)
```

**Status token** — `` `todo` `` or `` `done` `` on the line after `### [ID]`.
**Priority** — `P0` highest → `P3` lowest. **Effort** — `S`/`M`/`L`.
**`parallel: no`** — touches a hot shared file; rebase on main before PR.
**Picking a task** — any `todo` whose `dep:` entries are all `done` is fair game.

---

## Area: Office Core

_Roadmap: [`ROADMAP.md` § 1](ROADMAP.md)_ · _Prefix: `OFFICE-`_

> The existing local-first single-binary suite. Several pieces are already
> shipped (`done`); the rest harden fidelity, versioning, and PDF depth so the
> document models are clean enough for the CRDT layer to wrap.

### [OFFICE-01] Documents editor (TipTap rich text)
`done` · P0 · L · dep: none · parallel: no — src/apps/docs/DocsEditor.jsx, src/apps/docs/DocsToolbar.jsx
Scope: Rich-text document editor on TipTap StarterKit with headings, tables, lists, task lists, links, images (base64), text style/color/highlight/underline, text-align, typography, and live word/character count. Autosave (debounced) to the file store, title editing, save state indicator. Already implemented.
AC: [x] open/edit/save a doc with tables + task lists [x] autosave + manual save [x] word/char count [x] go build ./... && npm run build

### [OFFICE-02] Sheets editor (Fortune Sheet grid)
`done` · P0 · L · dep: none · parallel: no — src/apps/sheets/SheetsEditor.jsx, src/apps/sheets/sheetsExport.js
Scope: Spreadsheet editor on @fortune-sheet/react: formula grid, multi-sheet workbooks, cell formatting; debounced autosave; `.xlsx` and `.csv` export. Already implemented.
AC: [x] multi-sheet workbook edits persist [x] xlsx + csv export [x] autosave [x] go build ./... && npm run build

### [OFFICE-03] Slides editor (Reveal.js)
`done` · P0 · M · dep: none · parallel: no — src/apps/slides/SlidesEditor.jsx, src/apps/slides/SlidePreview.jsx, src/apps/slides/slidesExport.js
Scope: Slide authoring + preview on Reveal.js with present-from-browser and `.pptx` export. Already implemented.
AC: [x] create/edit/reorder slides [x] present mode [x] pptx export [x] go build ./... && npm run build

### [OFFICE-04] PDF annotate + sign canvas (single-user)
`done` · P0 · L · dep: none · parallel: no — src/apps/pdf/PDFEditor.jsx
Scope: PDF viewer (pdfjs-dist) with page thumbnails, zoom/fit, text annotations, freehand draw, and signature placement (draw/type via signature_pad, saved-signature library in localStorage); flatten + download via pdf-lib. Already implemented as a single-user annotator.
AC: [x] open PDF, add text/draw/signature, download flattened PDF [x] page nav + thumbnails [x] go build ./... && npm run build

### [OFFICE-05] Import / Export pipeline (docx/xlsx/pptx/pdf/md)
`done` · P1 · M · dep: OFFICE-01, OFFICE-02, OFFICE-03 · parallel: yes — src/lib/importFile.js, src/apps/docs/docsExport.js, src/apps/sheets/sheetsExport.js, src/apps/slides/slidesExport.js
Scope: Import from URL/local file (mammoth for docx, xlsx, pdf hand-off) and export to `.docx` (docx), `.xlsx` (xlsx), `.pptx` (pptxgenjs), `.pdf`, Markdown (turndown/marked). Already implemented.
AC: [x] import docx → docs editor [x] export each app to its native format + markdown [x] go build ./... && npm run build

### [OFFICE-06] Storage backends (local JSON + PostgreSQL) + file CRUD API
`done` · P0 · M · dep: none · parallel: no — backend/storage/storage.go, backend/storage/local.go, backend/storage/postgres.go, backend/handlers/files.go, backend/models/models.go
Scope: Storage interface with local JSON (default) and PostgreSQL implementations; REST file CRUD (`GET/POST/PUT/DELETE /api/files`, `GET /api/files/:id`) plus upload. Already implemented.
AC: [x] file create/list/get/update/delete via API [x] local + postgres backends behind one interface [x] go build ./...

### [OFFICE-07] Optional password auth (JWT) + single-binary embed
`done` · P1 · M · dep: none · parallel: no — backend/handlers/auth.go, backend/middleware/auth.go, backend/config/config.go, main.go, src/components/LoginScreen.jsx, src/store/authStore.js
Scope: Optional password auth (off by default) with JWT, lockout after N failed attempts; Gin server embeds the built `dist/` for single-binary deploy; PWA manifest. Already implemented.
AC: [x] auth disabled → open access [x] auth enabled → login required, lockout enforced [x] single binary serves embedded frontend [x] go build ./...

### [OFFICE-08] Local document version history + snapshots
`done` · P1 · M · dep: OFFICE-06 · parallel: yes — backend/models/models.go, backend/storage/local.go, backend/storage/postgres.go, backend/handlers/files.go, src/components/Settings.jsx
Scope: Add per-file version snapshots: on save, retain the prior content as a version row/record (cap N, configurable). New endpoints `GET /api/files/:id/versions` and `POST /api/files/:id/versions/:vid/restore`. Surface a minimal history/restore UI in the editor top bars. Document-model agnostic (works for doc/sheet/slide content blobs). JSX only.
AC: [ ] saves create version snapshots, capped at N [ ] list + restore a prior version via API [ ] history panel renders + restore works in at least the Docs editor [ ] go build ./... && npm run build

### [OFFICE-09] Crash-safe autosave + offline write recovery
`done` · P1 · M · dep: OFFICE-01, OFFICE-02 · parallel: yes — src/store/filesStore.js, src/lib/api.js, src/apps/docs/DocsEditor.jsx, src/apps/sheets/SheetsEditor.jsx
Scope: Make autosave robust: queue dirty content to IndexedDB/localStorage before the network write, retry on failure, and recover unsaved edits on reload (prompt to restore). Explicit dirty/saving/saved state shared across editors. No data loss on tab close mid-save.
AC: [x] kill the tab mid-edit → reload restores unsaved content [x] failed save retries and surfaces an error state [x] no spurious "Saved" when a write failed [x] npm run build

### [OFFICE-10] PDF page operations (reorder / insert / delete / rotate)
`done` · P2 · M · dep: OFFICE-04 · parallel: yes — src/apps/pdf/PDFEditor.jsx
Scope: Extend the PDF editor with page-level operations via pdf-lib: reorder pages (drag thumbnails), insert blank/imported page, delete page, rotate page. Keep annotations anchored to their pages across reorder. JSX only.
AC: [ ] reorder/insert/delete/rotate reflected in thumbnails + saved PDF [ ] annotations stay on their correct pages after reorder [ ] npm run build

### [OFFICE-11] Import/export fidelity hardening
`done` · P2 · L · dep: OFFICE-05 · parallel: yes — src/lib/importFile.js, src/apps/docs/docsExport.js, src/apps/sheets/sheetsExport.js, src/apps/slides/slidesExport.js, src/lib/roundTripCheck.js
Scope: Close round-trip gaps: nested tables and merged cells (sheets), embedded images and lists in docx, slide ordering/notes in pptx. Add a fixtures-based round-trip check (import → export → re-import) for representative files. JSX only.
AC: [x] merged-cell xlsx round-trips without loss [x] docx with images + nested lists round-trips [x] round-trip fixture check passes [x] npm run build

---

## Area: Real-time Collaboration

_Roadmap: [`ROADMAP.md` § 2](ROADMAP.md)_ · _Fabric: vulos-cloud RELAY signaling_ · _Prefix: `OFFICE-`_

> CRDT documents synced over the Vulos fabric (cr-sqlite/bucket transport, P2P
> WebRTC data channels, **Vulos relay fallback**). No bespoke sync server, no OT.
> Presence/cursors/comments/suggestions layer on the CRDT substrate.

### [OFFICE-20] Fabric client adapter (P2P data channel + relay fallback)
`done` · P0 · L · dep: OFFICE-06 · parallel: no — src/lib/fabric.js, src/lib/signaling.js
Scope: Implement a browser-side fabric client that, given a document/session id, joins a Vulos fabric session: negotiate a WebRTC data channel P2P via the OS RELAY signaling service (offer/answer/ICE), and fall back to a Vulos relay circuit when P2P fails. Mint TURN creds via the cloud `/api/turn/credentials`. Expose a duplex message channel + connection-state events. Pure transport — no document semantics here. JSX/JS only.
AC: [ ] two browser peers establish a data channel via signaling [ ] relay-circuit fallback used when P2P blocked [ ] connection-state events surfaced [ ] reconnect after drop [ ] npm run build

### [OFFICE-21] CRDT document core + bucket sync
`done` · P0 · L · dep: OFFICE-20 · parallel: no — src/lib/crdt/index.js, src/lib/crdt/text.js, src/lib/crdt/grid.js, src/lib/crdt/tree.js
Scope: Define CRDT wrappers for the three doc models — sequence/text CRDT (Docs), grid CRDT (Sheets), tree CRDT (Slides) — that serialize op-logs compatible with the OS cr-sqlite/bucket sync. Merge is commutative/idempotent; offline edits converge on reconnect. Snapshot + op-log persistence to the bucket for cold/late joiners. No UI yet.
AC: [ ] concurrent edits on two replicas converge identically [ ] offline edits merge on reconnect with no loss [ ] cold joiner reconstructs from snapshot + ops [ ] unit tests cover text/grid/tree merge [ ] npm run build

### [OFFICE-22] Wire Docs editor to CRDT collaborative session
`done` · P0 · L · dep: OFFICE-21, OFFICE-01 · parallel: no — src/apps/docs/DocsEditor.jsx, src/lib/crdt/text.js
Scope: Bind the TipTap document to the text CRDT over a fabric session keyed by file id: local edits produce CRDT ops broadcast to peers; remote ops apply to the editor without clobbering the local caret. Replace single-writer autosave with CRDT-backed convergence (keep snapshot persistence). JSX only.
AC: [ ] two users edit the same doc live and converge [ ] no caret jump on remote apply [ ] offline edits reconcile on reconnect [ ] npm run build

### [OFFICE-23] Wire Sheets + Slides editors to CRDT sessions
`done` · P1 · L · dep: OFFICE-21, OFFICE-02, OFFICE-03 · parallel: yes — src/apps/sheets/SheetsEditor.jsx, src/apps/slides/SlidesEditor.jsx, src/lib/crdt/grid.js, src/lib/crdt/tree.js
Scope: Bind Fortune Sheet to the grid CRDT (cell edits as ops) and the Reveal.js deck to the tree CRDT (slide add/remove/reorder/content as ops) over fabric sessions, mirroring OFFICE-22. JSX only.
AC: [ ] concurrent cell edits converge in Sheets [ ] concurrent slide reorder/content edits converge in Slides [ ] offline reconcile [ ] npm run build

### [OFFICE-24] Presence roster (who's here)
`done` · P1 · M · dep: OFFICE-20 · parallel: yes — src/lib/presence.js, src/components/PresenceBar.jsx
Scope: A presence primitive over the fabric session: broadcast {accountId/accountAddress, displayName, color, online} on join/heartbeat; render an avatar roster in editor top bars; reusable by Sheets/Slides/Spaces. Identity from the Vulos Vulos account when present, else a session-scoped guest identity. JSX only.
AC: [ ] roster shows all live collaborators with stable colors [ ] entries drop on disconnect/timeout [ ] reused across docs/sheets/slides [ ] npm run build

### [OFFICE-25] Live cursors + selections
`done` · P1 · M · dep: OFFICE-22, OFFICE-24 · parallel: yes — src/apps/docs/DocsEditor.jsx, src/apps/sheets/SheetsEditor.jsx, src/lib/presence.js
Scope: Broadcast and render remote carets/selection ranges in Docs (TipTap decorations) and selected cell ranges in Sheets, keyed to presence identity/color. Throttle updates; map positions through CRDT so they stay valid under concurrent edits. JSX only.
AC: [ ] remote caret + selection render in Docs with correct color [ ] remote cell selection renders in Sheets [ ] positions remain valid under concurrent edits [ ] npm run build

### [OFFICE-26] Comments (anchored, threaded, resolvable)
`done` · P2 · L · dep: OFFICE-22 · parallel: yes — src/lib/crdt/comments.js, src/components/CommentsPanel.jsx, src/apps/docs/DocsEditor.jsx, src/apps/sheets/SheetsEditor.jsx
Scope: Comments anchored to a text range / cell / slide object, stored as CRDT data so they converge over the fabric; threaded replies; resolve/reopen; author identity from presence. Comments panel + inline markers; mention + unread tracking optional. JSX only.
AC: [ ] add/reply/resolve a comment anchored to a range [ ] comments converge across peers [ ] anchors survive concurrent edits or gracefully orphan [ ] npm run build

### [OFFICE-27] Suggestion (track-changes) mode
`done` · P2 · L · dep: OFFICE-22, OFFICE-26 · parallel: yes — src/apps/docs/DocsEditor.jsx, src/lib/crdt/suggestions.js, src/components/SuggestionPanel.jsx
Scope: Suggestion mode for Docs: edits are recorded as CRDT-friendly suggestion annotations (insert/delete proposals) rather than direct mutations; a reviewer accepts/rejects each; accepted suggestions fold into the base CRDT. Visual diff styling for pending suggestions. JSX only.
AC: [ ] edits in suggestion mode render as pending, not applied [ ] accept folds into doc, reject discards [ ] suggestions converge across peers [ ] npm run build

### [OFFICE-28] Document activity feed + named snapshots from op-log
`done` · P3 · M · dep: OFFICE-21, OFFICE-08 · parallel: yes — src/lib/crdt/index.js, src/components/HistoryPanel.jsx
Scope: Derive a per-document activity feed and named version snapshots from the CRDT op-log (who changed what, when); allow naming/restoring a snapshot. Reconcile with the local version history from OFFICE-08. JSX only.
AC: [ ] activity feed lists ops with author + time [ ] name + restore a snapshot from the op-log [ ] npm run build

---

## Area: PDF Auto-Sign

_Roadmap: [`ROADMAP.md` § 3](ROADMAP.md)_ · _Prefix: `OFFICE-`_

> DocuSign-style: place fields, send signing links, multi-signer order, a
> cryptographic token per signature, a tamper-evident audit trail, and a
> completion certificate. Identity ties to the Vulos Vulos account where it can.
> Builds on the existing PDF canvas (OFFICE-04).

### [OFFICE-40] Signing data model + backend store
`done` · P0 · L · dep: OFFICE-06 · parallel: no — backend/models/signing.go, backend/storage/storage.go, backend/storage/local.go, backend/storage/postgres.go
Scope: Add domain models for a signing envelope: Envelope (id, source PDF ref, status, signing-order mode), Field (page, x, y, w, h, type ∈ signature|initial|date|name|text, required, assigned signer), Signer (id, name, email/account-address/account, order, status), and AuditEvent (envelope id, signer id, action ∈ created|sent|viewed|signed|declined, ts, ip, identity, doc_hash_before, doc_hash_after, token). Extend the Storage interface + both backends (local JSON + postgres) with envelope CRUD and append-only audit insert.
AC: [ ] envelope/field/signer/audit models persist in local + postgres [ ] audit log is append-only (no update/delete) [ ] storage interface extended without breaking file CRUD [ ] go build ./...

### [OFFICE-41] Field-placement editor (assign fields to signers)
`done` · P0 · L · dep: OFFICE-04, OFFICE-40 · parallel: no — src/apps/pdf/PDFEditor.jsx, src/apps/pdf/SigningSetup.jsx
Scope: A "Prepare to sign" mode in the PDF editor: drag signature/initial/date/name/text fields onto any page/coordinate (reuse the existing annotation positioning), assign each to a named signer/role, toggle required/optional, set signing order (sequential/parallel). Persist as an envelope via OFFICE-40. JSX only.
AC: [ ] place + assign each field type to a signer [ ] required/optional + signing-order set [ ] envelope saved via API [ ] fields reload on reopen [ ] npm run build

### [OFFICE-42] Signing-link generation + scoped signer view
`done` · P0 · M · dep: OFFICE-41 · parallel: no — backend/handlers/signing.go, main.go, src/apps/pdf/SignView.jsx, src/App.jsx
Scope: Generate a unique, scoped, expiring link per signer (`POST /api/sign/:envelopeId/send` → per-signer tokens). Public route `/sign/:token` opens a focused signing view showing only that signer's assigned fields on the rendered PDF; logs `viewed` to the audit trail on open. Enforce signing order (a signer's link is inactive until prior signers complete). JSX only.
AC: [ ] send issues one scoped token per signer [ ] /sign/:token shows only that signer's fields [ ] open logs a viewed audit event [ ] out-of-order signer link → 403/locked [ ] go build ./... && npm run build

### [OFFICE-43] Signer ceremony (draw/type/upload + submit)
`done` · P0 · M · dep: OFFICE-42 · parallel: yes — src/apps/pdf/SignView.jsx
Scope: In the signer view, let the signer draw (signature_pad), type, or upload a signature/initial, auto-fill date fields, fill assigned text/name fields, check a consent box, and submit. Submit posts the filled field values to `POST /api/sign/:token/complete`. Block submit until all required fields are filled. JSX only.
AC: [ ] draw/type/upload signature works [ ] date auto-fills, text fields editable [ ] cannot submit with required fields empty [ ] submit posts field values [ ] npm run build

### [OFFICE-44] Cryptographic token + tamper-evident audit trail
`done` · P0 · L · dep: OFFICE-42, OFFICE-43 · parallel: no — backend/handlers/signing.go, backend/signing/crypto.go, backend/storage/local.go
Scope: On each signer completion: compute the document hash before/after applying that signer's fields, generate a cryptographic token (sign {envelope id, signer id, doc_hash_before, doc_hash_after, ts, identity} with a server keypair — Ed25519; key from env, generate-if-missing for dev), and append an immutable `signed` audit event chaining the prior event's hash (hash-chained log). Identity = Vulos Vulos account if authenticated, else link identity. No third-party signing service.
AC: [ ] each signature yields a verifiable Ed25519 token bound to the doc hash [ ] audit log is hash-chained + append-only [ ] before/after hashes recorded per signer [ ] identity captured (Vulos account or link) [ ] go build ./... && go test ./backend/signing/...

### [OFFICE-45] Multi-signer orchestration + reminders
`done` · P1 · M · dep: OFFICE-44 · parallel: yes — backend/handlers/signing.go
Scope: Drive the envelope state machine across signers: sequential mode invites the next signer only after the prior completes; parallel mode activates all at once; track per-signer status; expose `GET /api/sign/:envelopeId/status`; emit reminder hooks (log/notify stub) for pending signers; handle decline (terminal envelope state + audit event).
AC: [ ] sequential order enforced end-to-end [ ] parallel mode activates all signers [ ] decline terminates envelope with audit event [ ] status endpoint reflects each signer [ ] go build ./...

### [OFFICE-46] Completion certificate + sealed PDF
`done` · P1 · M · dep: OFFICE-44, OFFICE-45 · parallel: yes — backend/handlers/signing.go, src/apps/pdf/SignView.jsx
Scope: When all signers complete, flatten all signature/field overlays into the PDF (pdf-lib server-side or client export), append a generated completion-certificate page summarizing every signer, token, hash, timestamp, and IP/identity, and attach a machine-readable manifest (JSON) of the audit chain. Expose `GET /api/sign/:envelopeId/download` for the sealed PDF + certificate.
AC: [ ] sealed PDF includes all signatures flattened [ ] certificate page lists signers/tokens/hashes/timestamps [ ] machine-readable manifest attached/available [ ] download endpoint returns sealed PDF [ ] go build ./...

### [OFFICE-47] Signature + audit verification tool
`done` · P2 · M · dep: OFFICE-44, OFFICE-46 · parallel: yes — backend/handlers/signing.go, backend/signing/crypto.go, src/components/VerifyView.jsx
Scope: A verifier (`POST /api/sign/verify` + a `/verify` UI) that, given a sealed PDF (or envelope id), re-hashes the document, validates each signature token against the server public key, re-checks the hash-chained audit log, and reports tamper status per signer + overall. JSX only.
AC: [ ] valid sealed PDF verifies green [ ] any post-sign byte change flags tampering [ ] broken audit chain detected [ ] go build ./... && npm run build

---

## Area: Vulos Spaces

_Roadmap: [`ROADMAP.md` § 4](ROADMAP.md)_ · _Fabric: vulos-cloud RELAY signaling_ · _Prefix: `OFFICE-`_

> Slack + Google-Meet equivalent on the peer fabric: channels/DMs/threads
> (CRDT-synced, reusing the collaboration substrate), presence, and WebRTC
> voice/video/screen-share + scheduled meeting rooms with **Vulos relay/TURN
> fallback**. No third-party media stack, no separate identity, no bespoke
> signaling — reuse OFFICE-20 fabric client + the OS RELAY signaling layer.

### [OFFICE-60] Spaces data model + message store (CRDT-synced)
`done` · P1 · L · dep: OFFICE-21 · parallel: no — backend/models/spaces.go, backend/storage/local.go, backend/storage/postgres.go, src/lib/crdt/messages.js
Scope: Models for Channel (id, name, public/private, members), Message (id, channel/dm id, author, body, ts, thread-parent), and membership/read-state. Messages sync as CRDT data over the fabric (append + edit/delete tombstones) so channels converge across instances offline-tolerant; persist to local + postgres for history. No UI yet.
AC: [ ] channel/message/membership models persist in local + postgres [ ] messages converge across two replicas including offline [ ] edit/delete tombstones converge [ ] go build ./... && npm run build

### [OFFICE-61] Channels + DMs + threads UI
`done` · P1 · L · dep: OFFICE-60, OFFICE-24 · parallel: no — src/apps/spaces/SpacesApp.jsx, src/apps/spaces/ChannelView.jsx, src/apps/spaces/MessageList.jsx, src/App.jsx
Scope: The Vulos Spaces surface: channel sidebar (public/private), DM + group-DM list, message composer, threaded replies, unread/mention indicators, presence-aware member list (reuse OFFICE-24). Route `/spaces` (+ `/spaces/:channelId`) registered in App.jsx. Messages flow over the CRDT message store. JSX only.
AC: [ ] create/join channel, post + thread-reply [ ] DMs + group DMs work [ ] unread/mention indicators update live [ ] /spaces routes registered [ ] npm run build

### [OFFICE-62] Presence + status for Vulos Spaces
`done` · P2 · S · dep: OFFICE-61, OFFICE-24 · parallel: yes — src/lib/presence.js, src/apps/spaces/ChannelView.jsx
Scope: Extend the presence primitive with custom status (online/away/in-a-call + free-text), shown next to members in Vulos Spaces and reused by Office editors. In-a-call state is set by the calling layer (OFFICE-63). JSX only.
AC: [ ] status changes propagate live to other peers [ ] in-a-call status reflects active calls [ ] presence reused in editors + spaces [ ] npm run build

### [OFFICE-63] 1:1 + group voice/video calling (WebRTC P2P + relay/TURN fallback)
`done` · P1 · L · dep: OFFICE-20, OFFICE-61 · parallel: no — src/lib/call/rtc.js, src/apps/spaces/CallView.jsx
Scope: WebRTC voice/video calling over the fabric: signaling (offer/answer/ICE) via the OS RELAY signaling service, P2P mesh for small groups, **Vulos relay/TURN fallback** for NAT-blocked peers (TURN creds from the cloud `/api/turn/credentials`). In-call UI: mute, camera toggle, participant roster, active-speaker, leave. No third-party media SFU. JSX only.
AC: [ ] 1:1 video call connects P2P [ ] 3-party mesh call works [ ] relay/TURN fallback when P2P blocked [ ] mute/camera/leave controls work [ ] npm run build

### [OFFICE-64] Screen-share in calls
`done` · P2 · M · dep: OFFICE-63 · parallel: yes — src/lib/call/rtc.js, src/apps/spaces/CallView.jsx
Scope: Add getDisplayMedia screen/window sharing to an active call as an additional track/stream; presenter indicator; stop-sharing control; viewers render the shared stream prominently. JSX only.
AC: [ ] start/stop screen-share in a live call [ ] other participants see the shared screen [ ] presenter indicator shown [ ] npm run build

### [OFFICE-65] Scheduled meetings + meeting rooms (Google-Meet equivalent)
`done` · P2 · L · dep: OFFICE-63 · parallel: yes — backend/models/meetings.go, backend/handlers/meetings.go, src/apps/spaces/Meetings.jsx, src/apps/spaces/Room.jsx, src/App.jsx
Scope: Named, persistent or scheduled meeting rooms with a join link, lobby/admit, per-room presence, and calendar-style scheduling. Backend stores room + schedule metadata (`/api/meetings`); `/room/:roomId` joins the room and starts a call via OFFICE-63. Reuse presence + calling; no third-party media. JSX only.
AC: [ ] create a scheduled room with a join link [ ] join via link enters lobby then the call [ ] per-room presence + roster [ ] /room route registered [ ] go build ./... && npm run build

### [OFFICE-66] In-call chat tied to channel/thread
`done` · P3 · S · dep: OFFICE-63, OFFICE-61 · parallel: yes — src/apps/spaces/CallView.jsx, src/lib/crdt/messages.js
Scope: A lightweight in-call chat panel that posts to the originating channel/thread (or an ephemeral room thread for ad-hoc meeting rooms) using the existing CRDT message store, so call chat persists in Vulos Spaces history. JSX only.
AC: [ ] in-call messages post to the channel/room thread [ ] messages persist in Vulos Spaces history after the call [ ] npm run build

---

## Area: Future

### Multi-target builds (web subdomain + OS-embed library) for all app surfaces
`todo` · P2 · L · dep: none · parallel: no — vite.config.*, package.json, src/apps/*/lib.jsx (NOTE: OWNED BY SUBDOMAIN AGENT while active — do not edit these files in parallel)
Add a Vite multi-entry config that builds each app (docs, sheets, slides, spaces, calendar, meet) as both a standalone web bundle (for subdomain serving) and an embeddable `lib.jsx` export (for the OS shell app wrapper). Coordinate with the vulos-cloud subdomain routing pipeline. The OS-embed library target exports a single React component per app.
AC: [ ] `npm run build` produces both web and lib outputs [ ] lib.jsx exports a single component per app [ ] web output deployable to app-specific subdomain [ ] no .tsx files introduced

### Deep-link routing per app surface
`todo` · P2 · M · dep: none · parallel: yes — src/App.jsx
Add canonical deep-link routes for each app surface: `vulos-office://docs/{id}`, `vulos-office://meet/{roomId}`, `vulos-office://calendar/{eventId}`, etc. The `src/App.jsx` router handles both web-subdomain URL patterns and the OS deep-link scheme. Coordinate with the multi-target build work and the OS app wrapper tasks in the `vulos` repo.
AC: [ ] deep-link URLs for docs/sheets/slides/spaces/calendar/meet defined [ ] App.jsx routes resolve them correctly [ ] OS launcher links tested against the routing table [ ] npm run build

---

## Area: BYO Mail integration + bundling

_Spec: [`ROADMAP.md §Bundling decision`](ROADMAP.md)_  ·  _Prefix: `OFFICE-BYO-*`_
_Cross-repo: [`vulos-cloud`](https://github.com/vul-os/vulos-cloud) · [`vulos-mail`](https://github.com/vul-os/vulos-mail)_

> Office is bundled from Starter and up. These tasks ensure the bundling is surfaced correctly in
> the product and that BYO Mail customers at Starter+ tier get Office access without extra steps.

### [OFFICE-BYO-01] OS installer hook: install vulos-office alongside vulos-mail for Starter+
`in-progress` · P2 · M · dep: none · parallel: yes — docs/INSTALL.md (new or update)
Scope: Document the OS install wizard integration point: when a Vulos OS user selects Starter or
higher, the wizard installs vulos-office (Docs, Sheets, Slides, Spaces, Calendar) as a built-in
service alongside vulos-mail. No code change to vulos-office itself — this is a doc + install
script integration task. Coordinate with the vulos-mail MAIL-BYO-04 bash installer.
AC: [ ] INSTALL.md documents vulos-office install alongside vulos-mail for Starter+ [ ] install hook point documented for OS wizard team [ ] no .go or .jsx changes [ ] npm run build passes unmodified

### [OFFICE-BYO-02] Pricing copy verification: Office bundled from Starter
`in-progress` · P3 · S · dep: none · parallel: yes — (doc only)
Scope: Verify that all user-facing copy in vulos-office README.md, ROADMAP.md, and any marketing
copy in `docs/` correctly reflects that Office is bundled from Starter and up — no standalone
Office tier exists. Fix any copy that implies a standalone Office tier.
AC: [ ] README.md mentions bundling from Starter [ ] ROADMAP.md §Bundling decision present [ ] no copy implies standalone Office tier [ ] npm run build passes unmodified
