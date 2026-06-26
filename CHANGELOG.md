# Changelog

All notable changes to Vulos Office are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Vulos Office uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — 2026-06-26

### Changed — Office is now documents-only

Vulos Office is now scoped to **documents only** (Docs, Sheets, Slides, PDF/Signing,
Calendar, Contacts). Real-time chat + Spaces and video calling/meetings have been
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

---

## [Unreleased] — 2026-06-16

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

---

## [Unreleased] — 2026-06-15

### Added
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

### Fixed
- FIX-OFFICE-STORE-WIRE-01: Wire OrgBucketClient into file CRUD, sealed PDFs — blob sync to S3/Tigris when configured; SQLite-only fallback when not
- OFFICE-27 (Postgres): Implement CreateSuggestion/GetSuggestion/UpdateSuggestion/DeleteSuggestion in PostgresStorage
- OFFICE-62: Replace fabric-null presence stub with working REST/poll heartbeat + roster (15 s interval)
- P1-4: Add POST /api/spaces/channels/:channelId/members (private-channel invite) with membership authz
- P1-5: Wire optional SMTP reminder emails (VULOS_SMTP_* env); honest "no mailer configured" when absent

### Changed
- P2-7: Call cap: render capacity warning at ≥6 participants; MEET-SPACES-01 clarified: P2P mesh only, no SFU/LiveKit (intentional product limit — no change)
- P2-8: Replace alert() in importFile.js with thrown errors (caller handles UI feedback)

### Added (Wave C / prior unreleased)
- Build-time version injection via `-ldflags "-X main.Version=vX.Y.Z"`.
- `GET /version` endpoint returns the build version as JSON.
- `--version` / `version` CLI subcommand prints the build version and exits.
- `.github/workflows/release.yml`: automated release pipeline triggered on `v*`
  tags — cross-compiles linux/amd64 and linux/arm64, builds `@vulos/office-client`
  lib, generates SHA-256 checksums, creates a GitHub Release, and optionally
  publishes to npm (gated on `NPM_TOKEN` secret).

### Changed (Wave C / prior unreleased)
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

---

## [1.0.0] — 2026-05-24

### Added

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
  `sheets`, `slides`, `pdf`, `spaces`, `calendar`, `contacts` as individually
  importable sub-packages for embedding in the Vulos OS shell.

### Removed
- **LiveKit / SFU dependency**: LiveKit client SDK removed from the calling
  stack. Spaces calling now uses the P2P mesh via `@vulos/relay-client` only;
  large-room SFU integration is a future milestone.
- **Go CRDT engine** (`backend/crdt/`): the standalone Go CRDT document engine
  was removed. Client-side CRDT modules remain live; live P2P doc sync is
  dormant pending relay fabric integration.
- **Dual meeting endpoints**: the two parallel meeting handler implementations
  were merged into one.

### Changed
- Identity: all references updated from `@vumail.org` to `@vulos.org`.
- Storage interface extended with file versioning (OFFICE-08): `ListVersions`,
  `GetVersion`, `RestoreVersion`, `PruneVersions`, `LabelVersion`.
- Observability: `backend/obs/` provides Prometheus metrics
  (`vulos_office_*`) and OpenTelemetry tracing.

---

[Unreleased]: https://github.com/vul-os/vulos-office/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/vul-os/vulos-office/releases/tag/v1.0.0
