# Vulos Office — Roadmap

Vulos Office is the **documents** surface of the Vulos project — a self-hosted,
open-source (MIT) suite for Documents, Sheets, Slides, and PDF/Signing that runs
as a single Go binary with a React frontend. (Calendar and Contacts come through
the mail connector — CalDAV/CardDAV via lilmail.) Today it is a
fast, private, local-first editor. This roadmap charts its growth into a
**networked** office: the same documents, edited together in real time by people
on different Vulos instances, and PDFs signed with cryptographic audit trails —
all riding the **Vulos peer fabric** that already connects and routes instances
across the network, with relay/TURN fallback.

> **Product scope.** Vulos Office is documents-only. Team chat + Spaces ship as the
> separate **vulos-talk** product and video calling as **vulos-meet**; the **Vulos
> OS** hosts the apps and the **Vulos Workspace** hub app consolidates Office, Talk,
> and Meet into one cockpit. Chat/calling roadmap items previously tracked here now
> live in those repos.

The throughline: Vulos Office never invents its own network. Real-time document
collaboration reuses the **same fabric the Vulos OS uses for device routing** —
P2P first (cr-sqlite/CRDT sync to buckets), relay/TURN when direct connectivity
fails. *Vulos — open.*

> **Stack invariants (FROZEN):** Go backend; React 18 / Vite / Tailwind frontend,
> **JSX only — never `.tsx`**; MIT license. Collaboration transport is the Vulos
> fabric (CRDT + relay), not a bespoke server. No telemetry, no required cloud
> account for the local single-binary mode.

The sections below are **priority-ordered**.

---

## 1. Office Core — Documents, Sheets, Slides, PDF

The foundation, and what ships today: a clean, single-binary suite that opens in
the browser with no account required. Documents are edited with TipTap (rich
text, tables, task lists, images, links, pagination, headers/footers, equations),
Sheets with Fortune Sheet (a comprehensive formula engine, multi-sheet,
formatting, charts, pivots), Slides on a **from-scratch positioned-object
canvas** (free drag/resize/rotate of text, shapes, and images in normalized slide
space — not a Reveal.js document; Reveal.js survives only as the full-screen
*present* surface that hosts the same positioned objects), and PDFs with an
annotate-and-sign canvas. Files autosave to local JSON by default (PostgreSQL for
multi-user), and everything imports from / exports to Microsoft (`.docx`/`.xlsx`/
`.pptx`) and ODF (`.odt`/`.ods`/`.odp`) plus `.pdf`, `.csv`, and Markdown. Before
we network the suite, the single-player experience must be solid, lossless, and
trustworthy.

### Goals

- Keep the local-first, single-binary experience excellent and dependency-light.
- Make import/export round-trips lossless enough that Vulos Office is a credible
  daily driver against LibreOffice and the incumbents.
- Harden autosave and storage so no edit is ever silently lost.
- Establish clean document models that the collaboration layer (Section 2) can
  wrap in CRDTs without a rewrite.

### Concrete features

- **Documents (TipTap):** headings, tables, lists, task lists, links, images,
  text styling, highlight, alignment, typography, live word/character count,
  page pagination, headers/footers, and equations.
- **Sheets (Fortune Sheet):** a comprehensive formula engine, multi-sheet
  workbooks, cell formatting, number formats, conditional formatting, data
  validation, charts, filters, pivot tables, named ranges, freeze panes, and
  `.xlsx`/`.ods`/`.csv` export.
- **Slides (from-scratch positioned-object canvas):** free-positioning authoring
  — drag/resize/rotate text boxes, shapes, and images in normalized [0,1] slide
  space (`SlideCanvas.jsx` / `slideObjects.js`), per-element entrance/emphasis/exit
  **animations**, editable **master slides**, themes, **presenter view** (notes +
  timer), and present-from-browser. The full-screen present overlay uses Reveal.js
  purely as a slide-to-slide **transition host** that renders our positioned
  objects — it is not the authoring model or the editor.
- **PDF:** render, page thumbnails, zoom; place text, freehand draw, and
  signature/initial annotations; flatten and download via pdf-lib.
- **Import / Export:** open from URL or local file. Export `.docx`, `.xlsx`,
  `.pptx`, `.pdf`, and Markdown. Import Microsoft (`.docx` via mammoth, `.xlsx`
  via SheetJS, `.pptx` via OOXML/JSZip) and ODF (`.odt`, `.ods`, `.odp`) — slide
  decks import as positioned objects (text + geometry + embedded raster images).
  Every import runs through one hardened trust boundary (`lib/importBounds.js`):
  size + zip-bomb + zip-slip + XXE caps, then a per-app content sanitiser.
- **Storage:** local JSON store; PostgreSQL backend for multi-user installs;
  optional password auth (JWT) off by default.
- **Single binary + PWA:** the Go binary embeds the built frontend; installable
  as a desktop/mobile app.

### Gaps to close

- **Fidelity:** track-and-fix import/export edge cases (nested tables, merged
  cells, embedded media, slide transitions) so round-trips are lossless.
- **Versioning:** local document history / snapshots and restore.
- **Autosave robustness:** conflict-free local recovery on crash; explicit dirty
  state and offline-safe writes.
- **PDF depth:** page reorder/insert/delete/rotate, form-field detection, true
  text extraction (not just overlay annotations).

### Explicit non-goals

- **Not a clone of every legacy feature.** We do not chase macro languages,
  VBA, or pixel-exact legacy layout — we target the editing the majority needs.
- **No telemetry, no required account** for the local single-binary mode.
- **No proprietary file formats.** Open, inspectable JSON document models only.

---

## 2. Real-time Collaboration — Editing Over the Peer Fabric

The first networked pillar: open the same Document, Sheet, or Slide deck on two
Vulos instances and edit it together, live. Vulos Office does not stand up a
collaboration server. It rides the **Vulos peer fabric** — the OS already syncs
state via **cr-sqlite/CRDT to buckets** and connects instances **P2P with
relay/TURN fallback**. Office models its documents as CRDTs over that same
transport, so a doc converges across peers exactly the way the OS converges
device state. See the [Vulos peering / RELAY layer](../vulos-cloud/roadmap/RELAY.md)
for the signaling and relay primitives this builds on.

### Goals

- Conflict-free concurrent editing of Docs, Sheets, and Slides across instances,
  with no central authority and no lost edits — convergence guaranteed by CRDTs.
- Reuse the OS fabric end-to-end: P2P (WebRTC data channels) first, **Vulos
  relay/TURN** fallback, bucket-backed CRDT sync for offline/late joiners.
- Make presence feel alive — who's here, where their cursor is, what they select.
- Layer human collaboration affordances (comments, suggestions) on top of the
  CRDT substrate, not bolted beside it.

### Concrete features

- **CRDT document model:** wrap each doc type in a CRDT (text/sequence CRDT for
  Docs, grid CRDT for Sheets, tree CRDT for Slides) that serializes to the same
  bucket/cr-sqlite sync the OS uses; offline edits merge on reconnect.
- **Fabric session join:** open a doc → join its fabric session keyed by file ID;
  P2P data channel where reachable, **relay circuit fallback** otherwise; bucket
  snapshot for cold/late joiners.
- **Presence:** live roster of collaborators with identity (Vulos account /
  accountAddress), color, and online state.
- **Live cursors & selections:** remote carets and selection ranges rendered in
  each editor.
- **Comments:** anchored, threaded comments on a text range / cell / slide
  object; resolve/reopen; notifications via the fabric.
- **Suggestion (track-changes) mode:** propose edits as suggestions a doc owner
  can accept/reject, stored as CRDT-friendly annotations.
- **Activity & version history:** per-document change feed and named snapshots
  derived from the CRDT op log.

### Explicit non-goals

- **No bespoke collaboration backend.** Transport is the Vulos fabric; we do not
  ship a parallel WebSocket sync server.
- **No OT (operational transform).** CRDTs only — to match the OS sync model and
  guarantee offline convergence.
- **No global hosted document cloud** in the OSS core. Documents live on the
  user's instances/buckets; the cloud control plane only routes peers.
- **Not real-time co-editing inside the PDF annotator** in v1 — PDF collaboration
  is the signing flow (Section 3), not live canvas co-editing.

---

## 3. PDF Auto-Sign — E-Signature with Cryptographic Audit Trail

A DocuSign-style signing pillar built on the existing PDF canvas. Open a PDF,
**place signature / initial / date / text fields anywhere** on the document,
then send a **signing link** to one or more signers. Each signer opens the link
and signs (draw, type, or upload). Every completed signature **generates a
cryptographic token** and appends to a **tamper-evident audit trail** — who
signed, when, from where, and the document hash before and after. The result is
a sealed, verifiable PDF plus a completion certificate. Where possible, signer
identity ties to the **Vulos account**.

### Goals

- Turn the PDF annotator into a real, multi-party signing workflow with legal-
  grade auditability — self-hosted, no third-party signing service.
- Make every signature cryptographically verifiable and every document
  tamper-evident: any post-sign modification must be detectable.
- Support real signing ceremonies — multiple signers, defined order, reminders,
  and a final completion certificate.
- Anchor identity in Vulos account when available; allow link-based
  signers when not.

### Concrete features

- **Field-placement editor:** drag signature, initial, date, name, and free-text
  fields onto any page/coordinate; assign each field to a named signer/role;
  mark required/optional.
- **Signing links:** generate a unique, scoped, expiring link per signer; link
  opens a focused signing view of only that signer's fields.
- **Signer experience:** draw / type / upload a signature; auto-fill date; fill
  assigned text fields; consent checkbox; submit.
- **Multi-signer & signing order:** sequential or parallel signing; the next
  signer is invited only when prior steps complete; status per signer.
- **Cryptographic token per signature:** on completion, hash the document and
  the signature event and sign it (server keypair / signer identity) to produce
  a verifiable token bound to the document hash.
- **Tamper-evident audit trail:** immutable, append-only log of every event
  (sent, viewed, signed, declined) with timestamp, IP/identity, document hash
  before/after, and the per-signature token.
- **Completion certificate:** a generated certificate page (and machine-readable
  manifest) summarizing all signers, tokens, hashes, and timestamps, embedded
  in / attached to the final sealed PDF.
- **Verification:** a checker that re-hashes a sealed PDF and validates each
  token + audit chain, flagging any tampering.
- **Identity binding:** prefer authenticated Vulos account identity;
  fall back to link + email/typed identity for external signers.

### Explicit non-goals

- **Not a hosted SaaS signing service.** It runs on the user's own instance; no
  documents leave the operator's control by default.
- **No qualified/eIDAS-QES smartcard or HSM signing** in v1 — we provide strong
  tamper-evidence and audit trails, not (yet) government-grade qualified
  signatures.
- **No paid identity-verification vendors** (ID-scan, KYC) in the OSS core.
- **No always-on signing requires the cloud** — signing works on a self-hosted
  instance; the cloud only relays the link/notification where used.

---

## 4. Chat, Calling & Meetings — moved to vulos-talk / vulos-meet

Team chat + Spaces (channels, DMs, threads, reactions, pins, presence) and
real-time voice/video calling + meetings were originally planned as an Office
pillar. They have since been **extracted into their own products**:

- **vulos-talk** — team chat + Spaces (the Slack equivalent).
- **vulos-meet** — voice/video calling, screen-share, and meeting rooms (the
  Google-Meet equivalent).

Both ride the same Vulos peer fabric (CRDT/bucket sync for messages, WebRTC +
relay/TURN for media) and share the one Vulos account identity with Office. The
the **Vulos OS** hosts the apps and the **Vulos Workspace** hub app consolidates
Office, Talk, and Meet into a single cockpit; Office's sidebar links out to
Talk/Meet but never embeds them. See the
`vulos-talk` and `vulos-meet` repos for their roadmaps and threat models.

---

## Storage backend & co-location (finalized 2026-05-24)

### Storage-backend choice

Vulos Office stores documents, sheets, and slides in the same S3-compatible
object store as OS sync and mail. The same two-backend choice applies:

- **Tigris (default):** Per-org bucket prefix on Vulos Tigris; managed, durable, replicated.
- **MinIO local (complete BYO):** Customer's own MinIO instance. Document data never touches
  Vulos storage. Same Go storage interface; only the endpoint + credentials differ.

The storage backend is set by the Vulos OS or control plane at provisioning time. `vulos-office`
does not select or provision the backend — it receives the endpoint and credentials as
configuration (consistent with `vulos-mail`'s model).

### Co-location on a single instance

Vulos Office can run co-located with the OS and vulos-mail on a single box, sharing one bucket
and one CRDT/peering fabric. The BYO single-box story — "one box = your whole Vulos" — requires
only one shared bucket endpoint for all three services. The meta-bundle installer (`BUNDLE-01`
in `vulos`) wires this up; no vulos-office code changes are needed.

### Anchor inbox / identity

Vulos Office uses the same `@vulos.org` identity as mail and OS. There is no separate Office
identity — the Vulos account is the single identity for all surfaces. Collaboration sessions
are keyed by Vulos account address; the cloud control plane routes presence and CRDT sync
using the same identity service as mail.

---

## Bundling decision

**Office is bundled from Starter and up.** There is no standalone Office tier. The Vulos Mail
tier (R19/user) is mail-only; from Starter (R39/user) and up, the full Vulos Workspace —
Office (documents), Talk, and Meet — is included in the tier price with no separate line item.

This is a deliberate product decision: Google Workspace refugees should not have to choose
between mail and office — they are bundled together from the first paid tier above Vulos Mail.
The messaging on the pricing page reflects this: "Office, Talk, Meet, and Mail (with Calendar +
Contacts) are included from Starter and up."

Cross-repo: see `vulos-cloud/ROADMAP.md` billing model section and `src/pages/Pricing.jsx` for
the pricing copy that reflects this bundling.

---

## BYO Mail support (in progress — parallel implementation)

Vulos Office is not directly involved in the BYO Mail delivery flow (that is `vulos-mail` and
`vulos-cloud`). However, Office (alongside the Talk and Meet products) is a bundled feature
available to all BYO and hosted Mail customers at Starter and above. The Vulos OS install wizard
installs vulos-office alongside vulos-mail when the user selects a Starter+ tier.

Cross-repo: see `vulos-cloud/ROADMAP.md §BYO Mail support`.

---

## Future work

### Multi-target builds: web subdomain + OS-embed library for all apps
Build each Office app surface (docs, sheets, slides, pdf) as two targets:
(1) a standalone web build served from a subdomain (`office.vulos.org`), and
(2) an embeddable library (`lib.jsx` export) consumed by the
Vulos OS shell as a native app wrapper. Vite multi-entry config wires both outputs from the
same source tree. The subdomain builds integrate with the `vulos-cloud` multi-target routing
pipeline. Do not touch `src/apps/*/lib.jsx`, `vite.config.*`, or `package.json` — those are
owned by the subdomain agent while it is active.

### Deep-link routing per app ✓ (done — Wave E)
`src/App.jsx` handles per-document deep links (e.g. `/pdf/:id`) as public routes. The
`web+vulosoffice://` protocol handler is registered on mount; `?goto=<path>` is parsed and
navigated. Coordinate with the multi-target build work above for OS launcher integration.

---

## Current reality + near-term work (v1.1 wave — 2026-06)

### What is live today

- **Docs / Sheets / Slides / PDF** editing and signing are the core product, with
  comments, suggestions (track-changes), and version history.
  - **Docs** (TipTap): rich text, tables, task lists, images, links, pagination,
    headers/footers, and equations.
  - **Sheets** (Fortune Sheet): a comprehensive formula engine, number/conditional
    formatting, data validation, charts, filters, pivots, named ranges, freeze panes.
  - **Slides**: the **from-scratch positioned-object canvas** — drag/resize/rotate
    text, shapes, and images in normalized slide space, per-element animations,
    master slides, themes, presenter view. Reveal.js is used only for the
    full-screen *present* transition, not authoring.
- **Calendar** and **Contacts** moved to the mail connector (CalDAV/CardDAV via
  lilmail `/v1/calendar` + `/v1/contacts`); Office is documents-only.
- **Org-bucket wiring** (`OfficeBackendConfig`) is fully wired (`FIX-OFFICE-STORE-WIRE-01`):
  file CRUD and sealed PDFs read/write to the S3-compatible bucket (Tigris or MinIO)
  when `VULOS_ORG_ID` is set; falls back to local storage otherwise.
- **Import (MS + ODF)**: `.docx` (mammoth), `.xlsx`/`.ods` (SheetJS), and `.pptx`/`.odp`
  (OOXML/ODF via JSZip) all import through one hardened trust boundary
  (`lib/importBounds.js` — size, zip-bomb incl. lying-central-directory, zip-slip,
  and XXE caps, then per-app sanitisers). Slide decks import as **positioned objects**
  (text + geometry + embedded raster images), for both drag-and-drop and
  backend-served files.
  - **Honest fidelity ceiling**: imports target readable, editable content, not
    pixel-perfect legacy layout. Known drops include non-raster/vector media, some
    complex nested-table + merged-cell edge cases, slide transitions/SmartArt, and
    character/paragraph styling beyond the supported subset. Macros/VBA are never
    executed — a macro-laden file imports as inert data only.
- **Deep-link routing**: per-document deep links + the `web+vulosoffice://` protocol
  handler registered on mount; `?goto=` param parsed and navigated.
- **Security**: per-file ACLs, append-only signing audit trail.
- **CRDT**: client-side CRDT modules (`src/lib/crdt/`) are live. Live P2P document sync
  over the peer fabric is **dormant** — the Go CRDT engine was removed; the live path is
  REST + persistence.

> Chat/Spaces and calling/meetings (and their presence, recording, and relay/TURN
> machinery) were extracted to **vulos-talk** and **vulos-meet**; their "what's live"
> status lives in those repos.

### Near-term items

- **Live P2P document collab over the relay** (`COLLAB-FABRIC-01`): re-introduce the
  CRDT doc-sync channel over the Vulos relay fabric (WebRTC data channels + relay
  fallback). This is the **real** Section 2 of the roadmap — currently dormant.
- **Multi-target builds** (`vite.config.*`): build each app as both a standalone web
  bundle (subdomain serving) and an embeddable `lib.jsx` export (OS shell). Currently
  owned by the subdomain agent — do not edit these files in parallel.
