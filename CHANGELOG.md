# Changelog

All notable changes to Vulos Office are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Vulos Office uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.2.0] — 2026-07-07

The **structured-content + real-time collaboration + redesign** release. Docs,
Sheets, and Slides gained their major editing features; live co-editing now runs
over three transports; and the whole suite was rebuilt on a token-driven,
near-black design system. A dedicated security wave hardened the collab and
sanitiser ingress paths.

### Added — Real-time collaboration (three transports)

- **Server-mediated collab (SSE)** — new `ServerCollabSession` (`src/lib/crdt/
  serverSession.js`, `src/apps/docs/useServerCollab.js`): ops stream over SSE
  (`GET …/collab/stream`), are pushed via `POST …/collab/ops`, ACL-gated, and
  persisted authoritatively. A document converges and stays saved with **zero
  peers**, and a late joiner bootstraps from the server. Degrades to local-only
  autosave when the endpoint is absent.
- **Cloud P2P fabric** — `DocsCollabSession`/`GridSession`/`TreeSession` fan CRDT
  ops over the Vulos peer fabric (WebRTC + relay fallback) for low-latency
  co-editing.
- **E2E-encrypted P2P** ("Collaborate via link") — `P2PCollabSession` seals ops
  with AES-256-GCM; the HKDF-derived room key rides the URL fragment (never sent
  to the server), and the server path is suppressed while it is active so
  encrypted ops never hit a readable relay.
- **Presence + remote cursors** — live avatar stack, peer count, and remote
  caret/selection layers across Docs, Sheets, and Slides.
- All transports share one idempotent/commutative CRDT base (RGA text mirroring
  `backend/crdt/text.go`, plus LWW grid, fractional-index tree, HLC
  comment/suggestion stores) so cross-transport ops converge without
  double-apply.

### Added — Docs structured content

- **Tables** (resizable columns, header scope), **inline images** (raster-only,
  base64 or http(s), resize / align / alt), and real **footnotes** (auto-numbered
  inline refs + a re-derived footnote list, baked into HTML/DOCX/Markdown export).
- **Comments** — anchored text-range comments with threading and resolve/reopen.
- **Suggestions** — track-changes mode with insert/delete proposals and an
  accept/reject workflow.
- **Version history** — named snapshots with restore, plus an activity feed.
- **Find/replace**, a live **document outline / ToC**, and a **word-count** modal.
- **Export** — DOCX (images + tables + footnotes preserved), Markdown (GFM
  pipe-tables), HTML (sanitised), and PDF.

### Added — Sheets

- **Charts** (column / bar / line / area / pie) rendered as live SVG, persisted
  locally and round-tripped through a "Vulos Charts" metadata sheet on XLSX export.
- **Data validation** (list / checkbox / date / number / text / custom),
  **number formats** (currency / percent / date / accounting, XLSX-roundtripped),
  and **conditional formatting**.
- **Filters** (named views), **pivot tables** (SUM/AVG/COUNT/MAX/MIN into a new
  sheet), and **named ranges**.
- **CSV** and **XLSX** import/export (cells, merges, number formats, chart metadata).

### Added — Slides

- **Themes** (preset gallery), editable **master slides** (title/content/section
  layouts), per-slide **transitions** and entrance animations.
- **Presenter view** — a second window with current/next slide, speaker notes,
  timer, and progress, synced via BroadcastChannel.
- **Template gallery** (pitch / project plan / lesson plan / quarterly review)
  and **PPTX** export (via pptxgenjs) alongside PDF.

### Changed — UI/UX redesign

- Rebuilt on a **token-first, near-black design system** (`src/design/tokens.css`)
  aligned with the vulos-cloud landing: IDE aesthetic, one deep-teal accent,
  Inter chrome + mono micro-UI, hairline borders, deep no-bloom elevation. Dark
  is the default canvas; a clean light theme is opt-in.
- New shared primitives: `SaveStatus` (breathing save dot), `Avatar`/`AvatarStack`
  (deterministic presence chips), `EmptyState`, `DocThumb` (per-type launcher
  thumbnails), plus a `.toolbar-surface` / `<ToolbarButton>` toolbar language and
  premium `.doc-desk` / `.slide-stage` canvas surfaces. `docs/DESIGN.md` updated
  to the near-black token model.

### Security

- **CRDT DoS fail-close** — remote text ops are validated (codepoint bounds, no
  UTF-16 surrogates) before apply and dropped on failure instead of throwing, so
  a malformed/oversized op can't crash or DoS the editor on bootstrap.
- **Sanitiser hardening** — centralised DOMPurify policy in `src/lib/sanitize.js`;
  inline `style` moved from a brittle blocklist to a **property allow-list**
  (positioning overlays, `content:`, fetch/exec functions all dropped fail-closed).
- **Image src policy + collab ingress** — `<img>` restricted to raster data: URIs
  (require `;base64,`; reject SVG/XML/HTML and the raster MIME-lie form) and
  http(s)/relative URLs; `srcset`/`href`/`xlink:href` channels closed. The same
  `isSafeImageSrc` predicate gates the collab/JSON-reload ingress path so a
  hostile peer op can't smuggle an unsafe `src`.
- **Chart export injection** — spreadsheet formula-injection prefixes
  (`=`/`+`/`-`/`@`) neutralised and cell data escaped before SVG render; charts
  clamped to finite geometry on draft-restore.

---

## [0.1.0] — 2026-06-29

### Added — Standalone, server-honest Settings + admin surface

A self-hoster running Vulos Office standalone now gets a Settings surface that
reports what the instance is **actually** doing, instead of hardcoded placeholders.

- **New endpoint** `GET /api/system/info` — honest runtime facts: build version,
  storage backend (`local`/`postgres`) + data/uploads directories, object-store
  status (MinIO/S3/Tigris, endpoint + bucket, never credentials), auth mode
  (`disabled`/`shared`/`per-user`) + registered-user count, standalone-vs-cloud
  integration mode, and the caller's account id + admin status. All derived from
  live config and stores (`backend/handlers/system.go`,
  `storage.DescribeObjectStore`).
- **Working password change** `POST /api/auth/password` — authenticated
  self-service rotation against the per-user credential store (re-verifies the
  current password first; `userauth.Store.UpdatePassword` added to both the
  SQLite and in-memory backends). Replaces the previous Settings call to a route
  that did not exist. Shared-password and auth-disabled modes return honest
  guidance pointing at `config.yaml` rather than silently failing.
- **Settings overhaul** (`src/components/Settings.jsx`): Account / Appearance /
  Security / Storage tabs reading `/api/system/info`, plus an **Admin** tab
  (invite tokens + audit log, reusing the existing admin panels) shown only to
  admins — folding the previously unrouted admin console into the single-user
  self-hoster's Settings.
- **Screenshots**: added a `settings` capture to `npm run screenshots` and the
  README gallery (`scripts/screenshots.mjs`, `docs/screenshots/settings.png`).

### Changed — Calendar + Contacts moved to Vulos Mail/PIM

Vulos Office is now **documents-only** (Docs, Sheets, Slides, PDF/Signing). Calendar
and Contacts were redundant with the canonical PIM surfaces now owned by the **Vulos
Mail** product (vulos-mail CalDAV/CardDAV server + lilmail `/v1/calendar` +
`/v1/contacts` + `@vulos/mail-ui`), so they have been removed from this repo. This
mirrors the earlier Meet/Talk extractions.

- **Frontend removed**: the `src/apps/calendar` + `src/apps/contacts` apps, the
  `calendar.vulos.org` entry/shell/bundle (`src/entries/calendar.jsx`,
  `src/shells/CalendarShell.jsx`, `vite.config.calendar.js`, `index.calendar.html`,
  `dist-calendar/`), the `build:calendar` script (dropped from `build:all`), the
  `./calendar` + `./contacts` library exports (`src/lib/index.js`, `package.json`
  `exports`/`files`, `vite.config.lib.js`), the contacts client methods in
  `src/lib/api.js`, and the Calendar/Contacts sidebar rail items.
- **Backend removed**: the calendar event/reminder/subscription + contacts VCF
  handlers, the `calstore`/`contactstore` SQLite stores, the `calendar_rrule` +
  `contacts_vcf` services, and all `/calendar/*` + `/contacts/*` routes and store
  init (`VULOS_CALSTORE_DB` / `VULOS_CONTACTSTORE_DB`) from `main.go`.
- **seam-C handoff**: `/calendar` and `/contacts` deep-links now redirect to the
  Mail product (`VITE_MAIL_URL`, default `https://mail.vulos.org`) instead of
  routing in-process.

> Follow-up (not in this change): repoint the Vulos OS AppRegistry
> `vulos-calendar` / `vulos-contacts` tiles and the Workspace registry to the Mail
> product's Calendar/Contacts surfaces.

### Changed — Office is now documents-only

Vulos Office is now scoped to **documents only** (Docs, Sheets, Slides, PDF/Signing).
Real-time chat + Spaces and video calling/meetings have been
split into their own products, combined with Office by the **Vulos Workspace** shell:

- **Vulos Meet → `vulos-meet`**: the standalone video product. Office's meeting/lobby/
  TURN/recording surface and the `/meet/*` routes were removed from this repo.
- **Vulos Talk → `vulos-talk`**: team chat + Spaces (channels, DMs, threads, reactions,
  pins, presence). The `/spaces/*` routes, message CRDT store, and chat UI were removed.

### Removed (dead code left by the Meet/Talk extraction)

- **Backend models**: deleted `models.Meeting` / `models.MeetingRecording` (meetings.go)
  and the Spaces chat models (spaces.go) — all unreferenced after the extraction.
- **Storage interface**: dropped the `Meeting`/`Recording` CRUD methods from the
  `Storage` interface and their `LocalStorage`/`PostgresStorage` implementations,
  the `recordings` data dir, and the meetings/recordings Postgres schema migrations.
- **Frontend**: removed the dead `api.spaces*` client methods (calling now-absent
  `/spaces/*` endpoints), the Spaces-only `sanitizeChatMarkdown` helper, and the
  unused Meet `speaker-glow` Tailwind animation.
- **Docs/scripts**: pruned meet/talk/spaces references from README, DEPLOY, ROADMAP,
  THREAT-MODEL, the design system, and the deploy/seed/screenshot scripts; deleted the
  Meet recording design note and the Spaces/Meetings demo seeding + screenshots.

Office's sidebar keeps an **external** launcher link to Talk (`talk.vulos.org`) — a
cross-product link, not an in-process surface.

### Added (Google-parity Wave H — Sheets/Slides/Docs polish)

**Sheets:**
- **SHEETS-FORMULA-BAR**: Fortune Sheet `showFormulaBar={true}` prop enabled — built-in formula bar now appears above the grid, showing and allowing editing of the active cell's content/formula.
- **SHEETS-FREEZE**: Freeze Rows/Columns UI added (`FreezePanel` component). Lock icon in toolbar opens a popover with: Freeze top row, Freeze first column, Freeze rows (custom count), Freeze columns (custom count), Unfreeze. Calls `workbookRef.current.freeze()` API on the FortuneSheet `WorkbookInstance`.
- **SHEETS-CELL-COMMENTS**: Cell-level comment annotations (`CellCommentPanel`). MessageSquarePlus toolbar button opens a popover showing the current comment for the active cell (`ps.value` field in Fortune Sheet format), with edit/save/delete. Active cell tracked via `afterSelectionChange` hook.

**Slides:**
- **SLIDES-TEXT-COLOR**: Text color picker added to the slide formatting toolbar (Palette icon + overlaid `<input type="color">`). Uses TipTap Color extension (`setColor`) already loaded.
- **SLIDES-GRID-VIEW**: Slide grid/overview mode (LayoutGrid button in topbar). Replaces the editor area with a 4-column thumbnail grid of all slides. Click any card to jump to that slide (closes grid). Drag-to-reorder via existing drag state. Exit via "Edit" button.

**Docs:**
- **DOCS-FIND-HIGHLIGHT**: Find & Replace now highlights ALL matches in the document canvas using ProseMirror inline decorations (`FindHighlightExtension` registered as a TipTap extension). Yellow highlight for all matches; orange/outlined highlight for the current match. Decorations update live as the search term changes, and clear when the bar is closed.
- **DOCS-FIND-REGEX**: Regex mode toggle (`.*` button) in the Find bar. When active, the search term is used as a raw RegExp pattern. Invalid regex patterns show a danger indicator and return no results safely. Replace/ReplaceAll also respect the regex flag.
- **DOCS-PAGE-BREAK**: "Page break" item in the Docs overflow menu (Insert section). Inserts a `<p style="page-break-after:always">` with a visual dashed line — renders as a section separator in edit mode and triggers a real CSS page break when printing.

### Tests
- 12 new unit tests in `src/apps/docs/__tests__/findReplace.test.js` covering `findAllMatches`: case-insensitive, case-sensitive, no match, empty term, special-char escaping, regex digit pattern, invalid regex safety, position accuracy, regex case flags, and literal-dot behaviour.
- Total: 284 tests passing (was 272).

### Fixed (PDF signing pipeline — Wave G)
- **SEAL-HASH-FIX**: Fixed a circular-dependency bug in the seal→verify hash design.  
  Previously `FinalDocHash` was computed *after* attaching the manifest JSON to the PDF,
  meaning the manifest already embedded inside the PDF contained a *stale* hash and
  `sha256(sealedPDF) ≠ manifest.final_doc_hash` on every round-trip — all verify
  calls returned `hash_match=false`.  
  Fix: `FinalDocHash = sha256(certPDF[:lastEOF])` (computed before manifest attachment);
  verify.go re-extracts the pre-manifest slice from the sealed PDF using the manifest
  object marker and re-hashes it to confirm. (`seal.go`, `verify.go`)
- **SEAL-XREF-OFFSET-FIX**: Fixed `startXref` offset recorded in incremental PDF
  updates (`appendCertificatePage`, `attachManifest`).  The offset was captured at the
  start of the base section (before the new objects were written) instead of at the
  position of the `xref` keyword.  PDF readers using the `startxref` value to locate
  the cross-reference table would jump to the wrong offset.  (`seal.go`)
- **CHAIN-ALL-EVENTS**: All audit events (created, sent, viewed, signed, declined,
  voided, completed) now participate in the tamper-evident hash chain, not just
  `signed` events.  New `appendChainedAuditEvent` helper in `signing.go` loads prior
  events, computes `prev_event_hash`, and appends atomically — called from
  `envelopes.go`, `signing.go`, `orchestration.go`, and `seal.go`.

### Added (PDF signing pipeline — Wave G)
- **PUBKEY-ENDPOINT**: `GET /api/sign/pubkey` returns the server's Ed25519 public key
  in base64 so external parties can independently verify OFFICE-44 signature tokens
  without contacting the server again.  (`verify.go`, `main.go`)
- **SEAL-VERIFY-TESTS**: 10 new end-to-end tests in `backend/handlers/seal_verify_test.go`
  covering the full sign → seal → verify round-trip, tamper detection (byte-flip in
  pre-manifest area), HTTP multipart verify endpoint (200 clean / 422 tampered),
  verify-by-envelope-id, pubkey endpoint, download gate (409 before all signed),
  manifest FinalHash presence, chain-broken detection, and idempotent sealing.
- **DASHBOARD-DOWNLOAD-VERIFY**: `EnvelopeDashboard.jsx` — completed envelopes gain a
  Download sealed PDF anchor (⬇) and a Verify document integrity button (🛡) in the
  action toolbar.  Clicking Verify runs `api.verifyEnvelope` inline and shows a
  pass/fail verdict in the expanded signer panel without leaving the page.
- **SIGNVIEW-VERIFY-LINK**: `SignView.jsx` done-screen now includes a quiet link to
  `/verify` so signers know where to validate the sealed document once all parties sign.
- **API-SIGNING-HELPERS**: `api.js` adds `sealedPDFUrl(envelopeId)`, 
  `verifyEnvelope(envelopeId)`, and `signingPublicKey()`.

### Added
- **DOCS-SUB-SUP**: Subscript (`X₂`) and Superscript (`X²`) toolbar buttons in `DocsToolbar.jsx`.
  - Implemented as lightweight inline `Mark.create()` extensions (`Subscript`, `Superscript`) in `DocsEditor.jsx` — no extra npm packages; renders `<sub>`/`<sup>` HTML.
  - Keyboard shortcuts: `Mod+,` (subscript) and `Mod+.` (superscript).
  - Buttons appear after Strikethrough in the character-formatting group.
- **DOCS-PRINT**: Print action wired to `Ctrl+P` / `Cmd+P` in `DocsEditor.jsx`.
  - Sets `document.title` to the file name before `window.print()` so the print dialog shows the correct filename; restores afterwards.
  - "Print" menu item added to the Export dropdown in `DocsToolbar.jsx`.
- **DOCS-CUSTOM-FONTSIZE**: Custom font-size text input in `FontSizeSelector` dropdown.
  - A number input (1–400) appears at the top of the dropdown; pressing Enter applies the size as `Xpt` via `setMark('textStyle', { fontSize })`.
- **DOCS-HTML-EXPORT**: HTML export added to the Docs Export dropdown.
  - `exportToHtml(editor, filename)` in `docsExport.js` calls `editor.getHTML()`, wraps it in a styled HTML5 page, and triggers a `.html` download via `file-saver`.
- **DOCS-LINESPACING-FIX**: Line spacing now applies at paragraph-node level via `updateAttributes` instead of the incorrect `textStyle` mark.
  - Uses `editor.chain().focus().updateAttributes('paragraph', { style: 'line-height:X' })` (also attempts `heading` nodes).
- **SHEETS-FIND-REPLACE**: New `SheetsFindReplace.jsx` component with Ctrl+F / Ctrl+H shortcut in `SheetsEditor.jsx`.
  - Searches all sheets' `celldata` (case-insensitive or case-sensitive toggle).
  - Prev/Next navigation (↑↓ buttons or Shift+Enter / Enter).
  - Replace one / Replace all with live count display.
  - Search button added to the Sheets topbar actions.
- **SLIDES-TOOLBAR-PARITY**: Slides inline toolbar (`SlidesEditor.jsx`) extended with:
  - **Undo / Redo** buttons (disabled when unavailable).
  - **Heading style selector** (Normal / H1 / H2 / H3) hover dropdown.
  - **Font size selector** from a curated set (14–72pt).
  - **Strikethrough** button.
  - **Link insert** button (window.prompt like Docs; `Link` extension added to slides TipTap instance).

### Changed
- `DocsToolbar.jsx`: Import `Printer` from `lucide-react`; import `exportToHtml` from `docsExport`.
- `DocsEditor.jsx`: Import `Mark` from `@tiptap/react`; define `Subscript`/`Superscript` marks locally.
- `SlidesEditor.jsx`: Import `Link` extension; import additional Lucide icons (`Strikethrough`, `LinkIcon`, `Undo`, `Redo`, `TypeIcon`).

### Tests
- `docs.test.jsx` +41 tests: subscript/superscript chain routing, custom font size validation,
  HTML export shape, Sheets `collectCells` / `findMatches` / `applyReplace` helpers (6 cases).
- `slides.test.jsx` +9 tests: undo/redo/strikethrough/link/heading/setParagraph/font-size chain routing,
  `SLIDE_FONT_SIZES` constant.
- Total: **272 tests** (all passing).

### Added (Wave C)
- **CHANNEL-INVITE-UI**: `InviteMemberModal` in the Spaces channel header (private channels only).
  - `UserPlus` icon button appears in the `ChannelView` topbar actions for `type === 'private'` channels.
  - Modal lets any channel member enter an account id and optional display name, calls `spacesInviteMember`, shows 201 success / 409 "already a member" / generic error, refreshes the member list on success.
  - Org-roster autocomplete: typing in the account-id field filters live-presence roster entries and clicking a suggestion fills both fields.
  - Consistent with existing `CreateChannelModal` / `NewDMModal` design (shared Modal + Button + Input primitives, warm-paper tokens).
  - Backend test: `backend/handlers/spaces_invite_test.go` — 4 cases: happy-path (201 + roster reflects name), duplicate (409), non-member denied (403), no-display-name fallback.
- **MODAL-FOCUS-TRAP**: `useFocusTrap` hook added to `src/components/ui/Modal.jsx` (~80 lines, zero external deps).
  - On open: saves the previously-focused element, moves focus to the first focusable child via `requestAnimationFrame`.
  - Tab/Shift-Tab: cycles within the dialog's focusable elements; never escapes to the page.
  - On close: restores focus to the element that triggered the modal.
  - Applied to the shared `Modal` component; all existing modals (CreateChannel, NewDM, DisplayName, InviteMember, meeting create, etc.) benefit automatically.
- **CONTACTS-CRUD**: Individual contact REST CRUD (`GET/POST/PUT/DELETE /api/contacts`, `/api/contacts/:uid`).
  - Account isolation via `callerScope` — non-owners get 404, no existence leak.
  - `ContactsApp.jsx` uses REST API as primary when `VITE_CARDDAV_BASE` is not set; falls back to CardDAV only when explicitly configured.
  - JSON payload mirrors `contacts_vcf.Contact`; snake_case normalised to camelCase in UI.
- **SHEETS-PASTE-VALUES**: Real Cmd+Shift+V paste-values-only in `KeyboardShortcuts.jsx`.
  - Reads clipboard via `navigator.clipboard.readText()`, parses TSV (tab-separated rows).
  - Formula prefix (`=`) stripped to prevent re-evaluation (prefixed with `'`).
  - Multi-cell paste: iterates rows × columns, calls `setCellValueInData` per cell, single `onChange`.
- **DEPLOY-SCRIPT**: `scripts/deploy-static.sh` — build all four SPA targets and upload to Tigris.
  - Supports `office|meet|talk|calendar|all` (default: all).
  - `--latest` flag writes SHA pointer object for CDN routing.
  - `DEPLOY.md` added documenting credentials, usage, CDN URL scheme, and Fly SPA fallback config.
  - Vite config TODO comments resolved (now reference `scripts/deploy-static.sh` and `DEPLOY.md`).
- **OFFICE-08** (complete): version snapshot ACs marked done — both local and Postgres `UpdateFile` call `CreateVersion`; `HistoryPanel` exists and works.
- **MEET-RECORDING**: Real client-side meeting recording (MediaRecorder on local stream).
  - `RecordingControl` replaces `RecordingStub` — consent banner, start/stop, pulsing red indicator.
  - After stop, WebM blob uploads to `/api/meet/:roomId/recordings`; falls back to local
    `data/recordings/` when no S3 bucket is configured.
  - Backend: `POST/GET/GET/:rid/DELETE` recording endpoints; `MeetingRecording` model;
    `CreateRecording/ListRecordings/GetRecording/DeleteRecording` in Storage interface +
    LocalStorage (JSON files) + PostgresStorage (`meeting_recordings` table).
  - `recording_enabled` on meetings now settable (was hardcoded false); toggle wired in
    the create-meeting modal.
  - `RecordingsList` component lets organisers download past recordings from the call UI.
- **PPTX-IMPORT**: Real `.pptx` import via JSZip + OOXML XML parsing.
  - `importFile.js` extracts `ppt/slides/slideN.xml`, maps shape text to slide objects,
    builds a slides-editor-compatible content model (`{ slides, theme, transition }`).
  - Works for both drag-and-drop (`importFile`) and backend-served local files (`importFromUrl`).
  - `jszip ^3.10.1` added as a dependency.
- **DEEP-LINK ROUTING**: Wired in `App.jsx`.
  - `/meet/:meetId` route resolves a meeting ID → session → `/room/:sessionId` (works
    both public-prefix and authenticated).
  - `web+vulosoffice://` protocol handler registered on mount via
    `navigator.registerProtocolHandler`; `?goto=<path>` query param parsed and navigated on load.
  - `/pdf/:id` route added (was missing from the main monolithic app router).
- **Build-time version injection** via `-ldflags "-X main.Version=vX.Y.Z"`.
- `GET /version` endpoint returns the build version as JSON.
- `--version` / `version` CLI subcommand prints the build version and exits.
- `.github/workflows/release.yml`: automated release pipeline triggered on `v*`
  tags — cross-compiles linux/amd64 and linux/arm64, builds `@vulos/office-client`
  lib, generates SHA-256 checksums, creates a GitHub Release, and optionally
  publishes to npm (gated on `NPM_TOKEN` secret).

### Fixed (Wave C)
- FIX-OFFICE-STORE-WIRE-01: Wire OrgBucketClient into file CRUD, sealed PDFs — blob sync to S3/Tigris when configured; SQLite-only fallback when not
- OFFICE-27 (Postgres): Implement CreateSuggestion/GetSuggestion/UpdateSuggestion/DeleteSuggestion in PostgresStorage
- OFFICE-62: Replace fabric-null presence stub with working REST/poll heartbeat + roster (15 s interval)
- P1-4: Add POST /api/spaces/channels/:channelId/members (private-channel invite) with membership authz
- P1-5: Wire optional SMTP reminder emails (VULOS_SMTP_* env); honest "no mailer configured" when absent

### Changed (Wave C)
- P2-7: Call cap: render capacity warning at ≥6 participants; MEET-SPACES-01 clarified: P2P mesh only, no SFU/LiveKit (intentional product limit — no change)
- P2-8: Replace alert() in importFile.js with thrown errors (caller handles UI feedback)
- Renamed internal `forumHandler` variable → `spacesHandler` in `main.go`
  (the `/api/spaces/*` routes are Spaces, not a forum).
- `docs/ARCHITECTURE.md` rewritten to reflect current reality: REST-based
  collaboration, no standalone Go CRDT engine, live P2P doc sync is dormant,
  correct component map and handler names.
- `ROADMAP.md` section "Spaces-on-LiveKit" replaced with "Current reality +
  near-term work" accurately describing what is and is not live.
- `backend/services/meeting/ratelimit.go`: removed stale SFU comment.
- CI: fixed `node-version-file: package.json` (no `engines.node` field) → pin
  to Node 22.

### Added (Foundation)

#### Vulos Spaces
- Full team-chat surface: channels, DMs, threads, reactions, pins, user status,
  message search (FTS5), threading. Backed by a durable SQLite `SpacesStore`
  with CRDT op-log convergence (`backend/spaces/store.go`).
- REST API: channels CRUD, messages CRUD, reactions, pins, read-state, op
  export/merge, thread views, user status (`/api/spaces/*`).
- Client-side CRDT modules for messages, comments, suggestions, text, grid, and
  tree in `src/lib/crdt/`.

#### Meetings (collapsed to single system)
- Dual meeting systems removed and collapsed to one: `MeetingHandler` handles
  lobby, join, TURN credential minting, and meeting audit
  (`backend/handlers/meetings.go`, `backend/services/meeting/`).
- P2P WebRTC mesh via `@vulos/relay-client` for voice/video; relay/TURN fallback
  from the Vulos circuit.

#### Calendar + Contacts (durable + account-scoped)
- `CalendarHandler`: events, recurrence (rrule), reminders, iCalendar
  import/export, subscription refresh worker.
- `ContactsHandler`: contact CRUD, vCard import/export, duplicate detection +
  merge (`backend/handlers/contacts_handler.go`,
  `backend/services/contacts_vcf/`).
- Both stores are durable SQLite-backed, keyed by `@vulos.org` account.

#### Org-bucket wiring
- `OfficeBackendConfig` struct defined (`backend/storage/backendconfig.go`) for
  per-org S3 bucket + CRDT snapshot configuration; injectable by the Vulos
  control plane.

#### Security
- `.ics` import SSRF guard: calendar subscription URLs are validated against a
  blocklist before fetch.
- Meeting-list scoping: participants can only see meetings they are members of.
- Per-file ACLs: `backend/fileacl/` enforces read/write/admin permissions on
  every file; backed by SQLite (local) or Postgres (multi-user).
- Pentest suites covering auth bypass, Spaces scoping, file ACL, meeting scoping,
  and signing workflow (`backend/handlers/pentest_*_test.go`).

#### @vulos/office-client library
- Multi-entry Vite library build (`vite.config.lib.js`) exporting `docs`,
  `sheets`, `slides`, `pdf` as individually importable sub-packages for embedding
  in the Vulos OS shell.

### Removed (Foundation)
- **LiveKit / SFU dependency**: LiveKit client SDK removed from the calling
  stack. Spaces calling now uses the P2P mesh via `@vulos/relay-client` only;
  large-room SFU integration is a future milestone.
- **Go CRDT engine** (`backend/crdt/`): the standalone Go CRDT document engine
  was removed. Client-side CRDT modules remain live; live P2P doc sync is
  dormant pending relay fabric integration.
- **Dual meeting endpoints**: the two parallel meeting handler implementations
  were merged into one.

### Changed (Foundation)
- Identity: all references updated from `@vumail.org` to `@vulos.org`.
- Storage interface extended with file versioning (OFFICE-08): `ListVersions`,
  `GetVersion`, `RestoreVersion`, `PruneVersions`, `LabelVersion`.
- Observability: `backend/obs/` provides Prometheus metrics
  (`vulos_office_*`) and OpenTelemetry tracing.

---

[Unreleased]: https://github.com/vul-os/vulos-office/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vul-os/vulos-office/releases/tag/v0.1.0
