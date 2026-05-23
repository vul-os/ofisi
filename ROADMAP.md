# Vulos Office — Roadmap

Vulos Office is the productivity surface of the Vulos project — a self-hosted,
open-source (MIT) suite for Documents, Sheets, Slides, and PDF that runs as a
single Go binary with a React frontend. Today it is a fast, private, local-first
editor. This roadmap charts its growth into a **networked** office: the same
documents, edited together in real time by people on different Vulos instances;
PDFs signed with cryptographic audit trails; and a Slack-and-Meet–equivalent
team workspace — all riding the **Vulos peer fabric** that already connects and
routes instances across the network, with relay/TURN fallback.

The throughline: Vulos Office never invents its own network. Collaboration,
chat, and calling reuse the **same fabric the Vulos OS uses for device routing**
— P2P first (cr-sqlite/CRDT sync to buckets, WebRTC for media), relay/TURN when
direct connectivity fails. *Vula — open.*

> **Stack invariants (FROZEN):** Go backend; React 18 / Vite / Tailwind frontend,
> **JSX only — never `.tsx`**; MIT license. Collaboration transport is the Vulos
> fabric (CRDT + relay), not a bespoke server. No telemetry, no required cloud
> account for the local single-binary mode.

The sections below are **priority-ordered**.

---

## 1. Office Core — Documents, Sheets, Slides, PDF

The foundation, and what ships today: a clean, single-binary suite that opens in
the browser with no account required. Documents are edited with TipTap (rich
text, tables, task lists, images, links), Sheets with Fortune Sheet (formulas,
multi-sheet, formatting), Slides with Reveal.js, and PDFs with an annotate-and-
sign canvas. Files autosave to local JSON by default (PostgreSQL for multi-user),
and everything exports to `.docx`, `.xlsx`, `.pptx`, `.pdf`, and Markdown. Before
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
  text styling, highlight, alignment, typography, live word/character count.
- **Sheets (Fortune Sheet):** formula grid, multi-sheet workbooks, cell
  formatting, `.xlsx`/`.csv` export.
- **Slides (Reveal.js):** slide authoring, speaker view, present-from-browser.
- **PDF:** render, page thumbnails, zoom; place text, freehand draw, and
  signature/initial annotations; flatten and download via pdf-lib.
- **Import / Export:** open from URL or local file; export `.docx`, `.xlsx`,
  `.pptx`, `.pdf`, Markdown.
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

## 4. Vulos Spaces — Team Chat, Calling, and Meetings

The largest new pillar: a **Slack + Google-Meet equivalent** built directly on
the peer fabric. Team channels, DMs, and threads for async work; presence and
status; and real-time **voice + video calling, screen-share, and scheduled
meetings / meeting rooms** for synchronous work. Messaging syncs as CRDTs over
the same bucket transport as the rest of Vulos; calling uses **WebRTC P2P with
the Vulos relay/TURN as fallback** — the same fabric the OS uses for device
routing. Vulos Spaces is how a team that already runs Vulos OS + Office stops
paying for Slack and Zoom.

### Goals

- A complete team-communication surface — channels, DMs, threads, presence — that
  is self-hosted and federates over the Vulos fabric between instances.
- First-class real-time media: 1:1 and group voice/video, screen-share, and
  scheduled meeting rooms, all P2P-first with relay/TURN fallback.
- One identity and one fabric across Office + Spaces: the people you edit docs
  with are the people you call, keyed to Vulos account.
- No new central server: messages converge via CRDT/bucket sync, media via
  WebRTC + Vulos relay — reusing Sections 2 and the OS RELAY layer.

### Concrete features

- **Channels:** public/private team channels; membership; per-channel history;
  CRDT-synced messages so channels converge across instances offline-tolerant.
- **Direct messages & group DMs:** 1:1 and small-group conversations.
- **Threads:** threaded replies on any message; unread/mention tracking.
- **Presence & status:** online/away/in-a-call indicators and custom status,
  reusing the presence primitive from Section 2.
- **Voice & video calling:** 1:1 and group calls over **WebRTC P2P**, with the
  **Vulos relay/TURN** as fallback for NAT-blocked peers (TURN creds minted by
  the cloud signaling layer — see RELAY).
- **Screen-share:** share a window/screen into a call.
- **Scheduled meetings / meeting rooms:** named, persistent or scheduled rooms
  (the Google-Meet equivalent); join link; lobby; per-room presence; calendar-
  style scheduling.
- **In-call essentials:** mute/camera controls, active-speaker, participant
  roster, basic in-call chat tied to the channel/thread.
- **Fabric/relay integration:** signaling (offer/answer/ICE) and TURN credential
  minting reuse the OS [RELAY](../vulos-cloud/roadmap/RELAY.md) signaling service;
  P2P preferred, relay fallback, never a third-party media SFU in the OSS core.

### Explicit non-goals

- **No third-party media stack (Zoom/Twilio/Agora).** WebRTC + Vulos relay/TURN
  only; an optional self-hostable SFU for large rooms is a later consideration,
  not v1.
- **No giant-webinar scale** (thousands of viewers) in v1 — target team-sized
  calls and rooms; mesh/relay first, SFU later if needed.
- **No separate identity system.** Spaces identity is the Vulos account,
  shared with Office collaboration.
- **No bespoke signaling server.** Reuse the OS fabric's signaling + relay; do
  not build a parallel one for Office/Spaces.
- **No telephony/PSTN dial-in** in the OSS core.
```

---

## Bundling decision

**Office is bundled from Starter and up.** There is no standalone Office tier. The Vulos Mail
tier (R19/user) is mail-only; from Starter (R39/user) and up, Office, Spaces, and Calendar are
included in the tier price with no separate line item.

This is a deliberate product decision: Google Workspace refugees should not have to choose
between mail and office — they are bundled together from the first paid tier above Vulos Mail.
The messaging on the pricing page reflects this: "Office, Spaces, Calendar are included from
Starter and up."

Cross-repo: see `vulos-cloud/ROADMAP.md` billing model section and `src/pages/Pricing.jsx` for
the pricing copy that reflects this bundling.

---

## BYO Mail support (in progress — parallel implementation)

Vulos Office is not directly involved in the BYO Mail delivery flow (that is `vulos-mail` and
`vulos-cloud`). However, Office and Spaces are bundled features available to all BYO and hosted
Mail customers at Starter and above. The Vulos OS install wizard installs vulos-office alongside
vulos-mail when the user selects a Starter+ tier.

Cross-repo: see `vulos-cloud/ROADMAP.md §BYO Mail support`.

---

## Future work

### Multi-target builds: web subdomain + OS-embed library for all apps
Build each app surface (docs, sheets, slides, spaces, calendar, meet) as two targets:
(1) a standalone web build served from a subdomain (`office.vulos.org`, `calendar.vulos.org`,
`meet.vulos.org`), and (2) an embeddable library (`lib.jsx` export) consumed by the Vulos OS
shell as a native app wrapper. Vite multi-entry config wires both outputs from the same source
tree. The subdomain builds integrate with the `vulos-cloud` multi-target routing pipeline.
Do not touch `src/apps/*/lib.jsx`, `vite.config.*`, or `package.json` — those are owned by
the subdomain agent while it is active.

### Deep-link routing per app
Each app surface exposes a canonical deep-link scheme (`vulos-office://docs/{id}`,
`vulos-office://meet/{roomId}`, etc.) so the OS launcher, notification taps, and inter-app
links can navigate directly to a document, sheet, meeting room, or calendar event. Routing
table in `src/App.jsx` handles both the web-subdomain URL pattern and the OS deep-link
scheme. Coordinate with the multi-target build work above.
