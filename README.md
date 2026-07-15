<div align="center">

<img src="public/vulos-office.png" alt="Vulos Office" width="120" />

# Vulos Office

**A sovereign, self-hostable office suite — your documents, your server, your rules.**

Docs · Sheets · Slides · PDF Signing

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.1-informational)](CHANGELOG.md)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](https://golang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<sub><img src="docs/assets/vulos-logo.png" height="14" alt="VulOS"> Part of <strong><a href="https://vulos.org">VulOS</a></strong> — the open, self-hostable web OS &amp; app suite. Runs standalone, or as an app hosted by the Vulos OS.</sub>

</div>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Vulos Office" width="900" />
</p>

---

## What is this?

Vulos Office is the **documents** product of VulOS, shipped as a **single Go binary** with the entire frontend embedded — no cloud account, no telemetry, no lock-in. It brings document editing, spreadsheets, presentations, and cryptographic document signing together in one clean, modern web interface. (Calendar and Contacts come through the **mail connector** — CalDAV/CardDAV via lilmail — see [Part of VulOS](#part-of-vulos).)

It is **independently self-hostable by default**: with zero configuration it runs as a single-user, local-storage app on your own machine. Everything that *could* tie it to an external service lives behind a small, clean **seam** — so you can run it fully standalone, or opt into the [vulos-cloud](#self-hosting) control plane for multi-tenant identity, entitlements, and usage. The core never imports cloud code; remove the adapter and the standalone build still compiles.

It stands as a tribute to **LibreOffice** and **OpenOffice** — the pioneers who proved productivity software could be free, open, and community-driven — and carries that torch into the browser with a fast React frontend and a lightweight Go backend.

> *"Vula" — open the door. Vulos Office is that door.*

---

## Part of VulOS

**VulOS** is an open, self-hostable web OS + app suite. The **Vulos OS** is the shell (launcher, windows, dock, assistant) that hosts the apps; each product is also independently self-hostable on its own:

- **Vulos Talk** — team chat + channels/Spaces + huddles
- **Vulos Meet** — video meetings (LiveKit SFU)
- **Vulos Office** — documents: docs, sheets, slides, PDF *(this repo)*
- **Vulos Board** — collaborative whiteboard (`@vulos/board-ui`)
- **Vulos Relay** — sovereign connectivity fabric (`@vulos/relay-client`)
- **Vulos Workspace** — an OS-hosted productivity hub that consolidates Office, Talk, Meet & Board
- **Vulos OS** — the web-native desktop (the shell that hosts the suite apps)

**Mail is a connector, not a product:** bring your own mailbox (Gmail / Microsoft 365 / IMAP) into Workspace and the OS via **lilmail** (the IMAP/SMTP connector client) and the shared **`@vulos/mail-ui`** inbox surface — plus calendar/contacts over CalDAV/CardDAV.

Products never import each other — they are linked/embedded across clean seams.

**Vulos Office's role:** the documents surface — Docs, Sheets, Slides, and PDF/Signing. It **runs standalone** as a single Go binary **and** as an app hosted by the Vulos OS, where the Workspace hub app can surface it. Its sidebar links out to Vulos Talk and Vulos Meet, but never embeds them — chat lives in **vulos-talk** and video in **vulos-meet**. Calendar and Contacts are **not** part of Office; they come through the **mail connector** (CalDAV/CardDAV via lilmail `/v1/calendar` + `/v1/contacts`).

---

## Features

| Surface | Description |
|---------|-------------|
| **Docs** | Rich-text editing via TipTap — headings, tables, inline images (resize/align/alt), footnotes, task lists, links; anchored **comments**, **suggestions** (track-changes with accept/reject), **version history** with restore, find/replace, live document outline + word count |
| **Sheets** | Full spreadsheet grid via Fortune Sheet — formulas, number formats, conditional formatting, **data validation**, **charts** (column/bar/line/area/pie), **filters**, **pivot tables**, **named ranges**, freeze panes |
| **Slides** | Presentation editor on a **from-scratch positioned-object canvas** — free drag/resize/rotate of text, shapes, and images in normalized slide space, per-element **animations**, **themes**, editable **master slides**, per-slide **transitions**, **presenter view** (notes + timer in a second window), template gallery, `.pptx`/`.odp` import. The full-screen *present* overlay uses Reveal.js only as the slide-transition host for those positioned objects |
| **Signing** | View, **annotate** (text/draw/shapes), **fill interactive form fields** (AcroForm detection + one-click fill), and **sign** PDFs (draw/type/upload); multi-party signing envelopes (sequential or parallel) with a public signer page and a cryptographic audit trail; page reorder/rotate/insert/extract |
| **Real-time collab** | Docs gets three CRDT transports: always-on **server-mediated (SSE, ACL-gated)**, low-latency **cloud P2P fabric**, and **E2E-encrypted P2P** via invite link. Sheets/Slides get live presence + cursors and CRDT content sync over the **cloud P2P fabric** when a peering host provides it (a standalone binary does not — content still saves normally, it just isn't live-synced between browsers); the server-mediated SSE path is Docs-only today |
| **Import / Export** | Docs `.docx` / Markdown / HTML / PDF · Sheets `.xlsx` / `.csv` · Slides `.pptx` / PDF · PDF signing; browse-and-import from the server's own `~/Documents`, `~/Downloads`, `~/Desktop` (single-user self-host only — disabled in multi-user mode, since it would expose the operator's local files to every account) |
| **Storage** | Local files + SQLite by default; optional PostgreSQL (schema `office`) for multi-user; optional S3-compatible object store |
| **Auth** | Optional password / JWT login — off by default for local use; per-file ACLs when multi-user |
| **Single binary** | The Go server embeds the whole frontend — one file to deploy |
| **PWA-ready** | Installable as a desktop / mobile app via web manifest |
| **Observability** | Prometheus metrics at `/metrics` and optional OpenTelemetry traces |

Every surface is also published as an npm library (`@vulos/office-client`) so the Vulos Workspace hub app — or your own app — can embed any editor as a native panel:

```js
import { DocsApp }     from '@vulos/office-client/docs'
import { SheetsApp }   from '@vulos/office-client/sheets'
import { SlidesApp }   from '@vulos/office-client/slides'
import { PDFApp }      from '@vulos/office-client/pdf'
```

---

## Screenshots

|  |  |
| :---: | :---: |
| **Docs** — rich text, tables, comments | **Sheets** — formulas, charts, pivots |
| <img src="docs/screenshots/docs-editor.png" alt="Docs" /> | <img src="docs/screenshots/sheets-editor.png" alt="Sheets" /> |
| **Slides** — themes, transitions, present | **Signing** — annotate & sign PDFs |
| <img src="docs/screenshots/slides-editor.png" alt="Slides" /> | <img src="docs/screenshots/pdf-editor.png" alt="Signing" /> |
| **Home** — workspace & recent files | **Settings** — account, storage & admin |
| <img src="docs/screenshots/home.png" alt="Home" /> | <img src="docs/screenshots/settings.png" alt="Settings" /> |

> Regenerate anytime with `npm run screenshots` — it boots the app with seeded demo data (no real backend or credentials needed) and captures every screen. See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md).

---

## Quick start (standalone)

Vulos Office runs **by itself** — no account, no cloud, no other Vulos product required.

### Docker (one-liner)

```bash
docker run -d \
  --name vulos-office \
  -p 8080:8080 \
  -v office-data:/srv/data \
  ghcr.io/vul-os/vulos-office:latest
```

Open <http://localhost:8080>.

> Building the image yourself: the `Dockerfile` needs a **parent build context**
> that also contains the sibling `vulos-apps/` and `vulos-relay/` repos (for the
> Go `replace` and the SPA `file:` deps). From the directory that holds all three:
> `docker build -f vulos-office/Dockerfile -t ghcr.io/vul-os/vulos-office:latest .`
> See the `Dockerfile` header and `fly.toml` for the full deploy flow.

### From source (single binary)

Prerequisites: [Go 1.25+](https://golang.org/dl/) and [Node.js 18+](https://nodejs.org/) with npm.

```bash
git clone https://github.com/vul-os/vulos-office.git
cd vulos-office

# Install deps and build the frontend + single binary
npm install
npm run build

# Run — single-user, local storage, no auth, no cloud
./vulos-office
```

Open <http://localhost:8080>. Data lives in `./data` and `./uploads`. That's the whole app, in one file.

### Develop

```bash
# Vite dev server (:5173) + Go API (:8080), live reload
npm run dev:web
```

Open <http://localhost:5173>.

### Minimal config

No configuration is required to run standalone. To require login (still fully standalone — no control plane):

```bash
# config.yaml → auth.enabled: true
export VULOS_OFFICE_JWT_SECRET="$(openssl rand -hex 32)"
./vulos-office
```

---

## Architecture

```mermaid
flowchart TD
    FE["React + Vite + Tailwind frontend (JSX only)<br/>Docs · Sheets · Slides · PDF Signing"]
    BE["Go backend (Gin)<br/>handlers · userauth · signing · storage · obs"]
    Seam["backend/seam — Identity · Entitlements · Usage<br/>standalone defaults (local, unlimited, no-op)"]
    Cloud["backend/integration/cloud<br/>(vulos-cloud adapter, opt-in)"]
    FE -->|"embedded into the binary"| BE
    BE --> Seam
    Seam -->|optional| Cloud
```

The boundary between Office's core and any external control plane is a small set of Go interfaces in `backend/seam`. The composition root (`main.go`) wires the standalone defaults via `seam.NewStandaloneProvider(...)`:

| Interface | Standalone default |
|-----------|--------------------|
| `seam.Identity` | `LocalIdentity` — verifies Office's own HS256 session JWT |
| `seam.Entitlements` | `LocalEntitlements` — unlimited, `self-hosted` tier, all features |
| `seam.Usage` | `NoopUsage` — discards metering (Prometheus still exported) |

The cloud adapter lives in a **separate package** and is selected *only* when `VULOS_CP_BASE_URL` is set. With it unset (the default), none of it runs. See [SELFHOST.md](SELFHOST.md) for the full seam contract.

---

## Real-time collaboration

Co-editing is **CRDT-based**. Every surface diffs local edits into commutative
CRDT ops (a RGA text CRDT for Docs — mirroring the Go `backend/crdt/text.go` —
plus LWW grid, fractional-index tree, and comment/suggestion CRDTs). Ops fan out
over **three complementary transports**, and because the CRDT apply is
idempotent, ops arriving from more than one transport converge with no
double-apply:

| Transport | When | Notes |
|-----------|------|-------|
| **Server-mediated (SSE)** | Always-on account path | Ops **and live presence** stream over SSE, are ACL-gated, and (ops) persisted authoritatively — a doc converges and stays saved even with **zero peers**, and a late joiner catches up from the server. |
| **Cloud P2P fabric** | When peers can connect | Low-latency WebRTC + relay-fallback over the Vulos peer fabric (plaintext). |
| **E2E-encrypted P2P** | "Collaborate via link" | Ops sealed with AES-256-GCM; the room key is HKDF-derived and carried in the URL **fragment** (never sent to the server). While active, the server path is **suppressed** so encrypted ops never traverse a readable relay. |

Live **presence** — avatar stack, roster, and **remote cursors/selections** —
renders on top of whichever transport is active. Presence is **not p2p-only**:
it also rides the server SSE path (`POST /collab/presence`, `VIEWER+`,
identity-stamped server-side, **ephemeral / never persisted**), so "who is here"
and live carets work on the account/cloud path even when **no relay or WebRTC
peer is reachable**. The two transports are merged; a peer is never
double-counted. A read-only **viewer** legitimately shows a caret and appears in
the roster, but a viewer's content **ops** are still refused (`403`).

---

## Security model

- **HTML sanitisation is centralised** in `src/lib/sanitize.js` — one audited
  DOMPurify policy for every surface that renders user- or peer-supplied markup
  (Docs import/export, Slides, search highlights). Scripts, `<iframe>`, `<object>`,
  form controls, and all inline `on*` handlers are stripped.
- **Inline `style` is allow-listed**, not blocklisted: only benign Docs
  properties survive (colour, font, spacing, borders, table sizing). Positioning
  overlays, `content:`, `behavior:`, and any fetch/exec function (`url()`,
  `image()`, `expression()`, `@import`, …) are dropped fail-closed.
- **Inline images are raster-only**: `<img src>` accepts http(s)/relative URLs or
  base64 raster data: URIs; every non-raster data: URI (`data:image/svg+xml`,
  `data:text/html`, …), `srcset`, and script-bearing MIME-lie is rejected. The
  same `isSafeImageSrc` predicate also gates the **collab/JSON-reload ingress
  path** so a hostile peer op can't smuggle an unsafe `src`.
- **CRDT ingress is fail-closed**: remote text ops are validated (codepoint
  bounds, no UTF-16 surrogates) before apply and dropped on failure — never
  throw — so a malformed/oversized op can't crash or DoS the editor on bootstrap.
- **Export is injection-safe**: Sheets/chart export neutralises spreadsheet
  formula-injection (`=`/`+`/`-`/`@` cell prefixes) and escapes cell data before
  it reaches SVG.
- **Per-file ACLs** (`backend/fileacl/`) gate read/write/admin on the server
  collab + persistence paths when multi-user auth is enabled.

See [SECURITY.md](SECURITY.md), [THREAT-MODEL.md](THREAT-MODEL.md), and
[SECURITY-TESTING.md](SECURITY-TESTING.md) for the full model.

---

## Configuration

Config is read from `config.yaml` (see the checked-in [`config.yaml`](config.yaml)) and selected environment variables. Sensible defaults mean **no configuration is required** to run standalone.

### `config.yaml`

```yaml
server:
  addr: ":8080"
  data_dir: "./data"
  uploads_dir: "./uploads"
auth:
  enabled: false          # set true to require login
  password: "changeme"
  session_hours: 24
storage:
  type: "local"           # "local" or "postgres"
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `DEPLOY_MODE` | Typed deployment class: `standalone` (default when unset — fully sovereign self-host and the client-side demo/showcase) or `os` (Office behind a Vulos OS box gateway; storage via scoped `X-Vulos-Storage-*` headers). Read once at boot and validated for coherent config. Apps run on the user's OS box or standalone — never multi-tenant cloud-hosted. In `os` mode the process **refuses to start** unless an authenticated identity posture is configured (auth enabled or SSO introspection), closing the silent hosted fail-open. |
| `VULOS_STORAGE_BROKER_SECRET` | Shared secret gating the OS-mode scoped-storage header seam (`DEPLOY_MODE=os`), so Office never holds full-bucket credentials. |
| `DATABASE_URL` | **Postgres backend** — full `postgres://…` connection URL. When set, selects Postgres as the document storage backend (schema `office`) and overrides `config.yaml storage.type`. Alias: `VULOS_DATABASE_URL` (checked second). Unset = embedded JSON-file default. |
| `VULOS_DATABASE_URL` | Alias for `DATABASE_URL` (checked if `DATABASE_URL` is unset). |
| `VULOS_OFFICE_JWT_SECRET` | HS256 secret for session JWTs — **required when auth is enabled** |
| `VULOS_OFFICE_DEV` | `1` uses a labelled insecure dev secret — local development only |
| `VULOS_OFFICE_CORS_ORIGINS` | Comma-separated allowed CORS origins |
| `VULOS_USERAUTH_DB` | Override the credential SQLite store path |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enable OpenTelemetry trace export |
| `VULOS_CP_BASE_URL` | **Opt-in** vulos-cloud control plane URL (enables the cloud seam) |
| `VULOS_CP_TOKEN` | Outbound service token for the control plane. Also the shared secret Office presents to the identity provider for SSO session introspection (== the provider's `CP_SHARED_SECRET`). **Not a signing key** — Office never signs sessions. |
| `IDENTITY_URL` | **Opt-in** identity provider base URL for **SSO session introspection** (the sovereign box in self-host, the CP in cloud). When SET, Office validates the browser's `vc_session` cookie by calling `POST {IDENTITY_URL}/api/session/introspect` (fail-closed). When **UNSET** (self-host single-user appliance), the SSO path is disabled and the existing local single-identity behavior is unchanged. |
| `VULOS_ORG_ID` | Tenant / org scoping (used by the cloud adapter and storage) |

#### Postgres shared-database setup (cloud / Neon)

Vulos Office uses the dedicated schema `office` inside the shared database, so it co-exists with other VulOS products (`mail`, `talk`, etc.) in a single Neon project without table-name collisions:

```bash
# Neon / shared Postgres (DATABASE_URL takes precedence over config.yaml)
export DATABASE_URL="postgres://user:pass@ep-cool-term.us-east-2.aws.neon.tech/neondb?sslmode=require"
./vulos-office

# Run migrations first (idempotent, safe to re-run after upgrades)
./vulos-office migrate up
```

The binary creates the `office` schema and all tables automatically on first boot. `migrate up` makes this explicit and can be run out-of-band before a rolling restart.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the complete reference.

---

## Self-hosting

Vulos Office is **built to be self-hosted by you**, not rented from anyone. The standalone path is the default and requires no cloud, no account, and no external service:

- **Identity** is local — every request is the `self` account in single-user mode; flip on multi-user auth with a JWT secret.
- **Entitlements** are unlimited (`tier: self-hosted`) — no metering, no quotas, all features on.
- **Storage** is local files + SQLite under `./data` and `./uploads`.

Full standalone instructions, the seam contract, and the optional cloud integration are in **[SELFHOST.md](SELFHOST.md)**. Deployment notes (Docker, single-box co-location) live in [docs/DEPLOY.md](docs/DEPLOY.md) and [DEPLOY.md](DEPLOY.md).

### Optional: the vulos-cloud seam

Setting `VULOS_CP_BASE_URL` selects the `backend/integration/cloud` adapter, which implements the same `seam` interfaces against the [vulos-cloud](https://vulos.org) control plane for multi-tenant identity, entitlements, and usage. Entitlement fetches **fail open** on a transient outage. Leave it unset and Office is 100% standalone.

### Optional: SSO session introspection (`IDENTITY_URL`)

Office holds **no session-signing power**. In a multi-user deployment, a user's browser carries a `vc_session` cookie minted by a configurable **identity provider** — the sovereign box in self-host, or the vulos-cloud control plane in cloud. Office only ever **verifies** that session by introspecting it:

```
POST {IDENTITY_URL}/api/session/introspect
  X-Relay-Auth: <shared service secret == VULOS_CP_TOKEN>
  { "session": "<vc_session cookie value>" }
  → { "valid": true, "userId": "...", "tenantId": "<account id>", "expiresAt": 1720000000 }
```

- **`IDENTITY_URL` UNSET** (self-host single-user / appliance): the SSO path is **disabled**; behavior is byte-for-byte the existing local single-identity mode. This is the correct posture for a sovereign single-user box.
- **`IDENTITY_URL` SET** (cloud / multi-user): a request bearing `vc_session` (and not already authed by the product-JWT or `vk_` paths) is introspected. On `{valid:true}` the request is scoped to the resolved **user + tenant** (`tenantId` = the account id everything is keyed by); on `{valid:false}` or any transport error → **401, fail-closed**. Office never falls open to a shared identity when `IDENTITY_URL` is configured.

The shared secret is the **existing service-auth secret** (`VULOS_CP_TOKEN`, equal to the provider's `CP_SHARED_SECRET`) — **not a signing key**. Introspection results are cached in-process for a short TTL (~45s, further bounded by the session's own `expiresAt`) so this is not a round-trip per request. This SSO path is **additive**: the per-product JWT (`VULOS_OFFICE_JWT_SECRET`), the `vk_` API-key path, and the CP `X-Relay-Auth` introspection paths all still work.

---

## Documentation

| Document | Description |
|----------|-------------|
| [SELFHOST.md](SELFHOST.md) | Run fully standalone; the optional cloud seam |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Full setup walkthrough |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component map and design decisions |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Env vars, `config.yaml`, OTEL / SMTP reference |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Self-hosting, Docker, single-box co-location |
| [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) | Regenerating the screenshot gallery |
| [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md) | Plans and version history |

---

## Development

```bash
npm run dev:web        # Vite (:5173) + Go API (:8080)
npm test               # frontend unit + RTL/MSW integration tests (Vitest)
npm run test:e2e       # browser E2E (Playwright, builds + serves vite preview)
npm run build          # frontend dist/ + Go binary
npm run build:all      # all sub-targets (office) + library
npm run build:lib      # @vulos/office-client library only
npm run screenshots    # regenerate the docs/screenshots gallery (seeded demo data)

# Backend
go build ./...
go test ./...
go vet ./...
```

**Frontend test layers** (see [docs/TESTING.md](docs/TESTING.md)):

- **Vitest** (`npm test`) — unit tests plus RTL + MSW *integration* tests that
  mount real editor component trees (real TipTap, real panels, real API client)
  against a mocked `/api`. Runs headless in jsdom; no browser needed.
- **Playwright** (`npm run test:e2e`) — browser-level E2E against a production
  `vite preview` build with the whole backend mocked in-browser via
  `page.route`. First run: `npx playwright install --with-deps chromium`.

> **Frozen invariants:** pure Go (no CGO), JSX only (never `.tsx`), no Google SSO, no Stripe. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Security

Found a vulnerability? Please report it responsibly — see **[SECURITY.md](SECURITY.md)** for scope, the disclosure process, and our response SLA. Do not open public issues for security reports.

---

## Contributing

Pull requests are welcome — bug fixes, signing robustness, accessibility, tests, and docs especially. For major changes, open an issue first. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup, code style, and the frozen invariants. No CLA required.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Made with care · Powered by open source · *Vula — open*

</div>
