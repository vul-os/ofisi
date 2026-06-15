# Changelog

All notable changes to Vulos Office are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Vulos Office uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — 2026-06-15

### Added
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
