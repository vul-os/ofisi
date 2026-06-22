<div align="center">

<img src="public/vula-office.png" alt="Vulos Office" width="120" />

# Vulos Office

**A sovereign, self-hostable office suite — your documents, your server, your rules.**

Docs · Sheets · Slides · Calendar · Contacts · Spaces · Meet · Signing

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-informational)](CHANGELOG.md)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white)](https://golang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

*Vulos — rooted in **vula**, the Zulu and Xhosa word for **open**.*

<sub>Part of the <strong><a href="https://vulos.org">Vulos</a></strong> suite</sub>

</div>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Vulos Office" width="900" />
</p>

---

## What is this?

Vulos Office is a complete, open-source office suite that ships as a **single Go binary** with the entire frontend embedded — no cloud account, no telemetry, no lock-in. It brings document editing, spreadsheets, presentations, a calendar, contacts, team chat, meetings, and cryptographic document signing together in one clean, modern web interface.

It is **independently self-hostable by default**: with zero configuration it runs as a single-user, local-storage app on your own machine. Everything that *could* tie it to an external service lives behind a small, clean **seam** — so you can run it fully standalone, or opt into the [vulos-cloud](#optional-the-vulos-cloud-seam) control plane for multi-tenant identity, entitlements, and usage. The core never imports cloud code; remove the adapter and the standalone build still compiles.

It stands as a tribute to **LibreOffice** and **OpenOffice** — the pioneers who proved productivity software could be free, open, and community-driven — and carries that torch into the browser with a fast React frontend and a lightweight Go backend.

> *"Vula" — open the door. Vulos Office is that door.*

---

## Screenshots

|  |  |
| :---: | :---: |
| **Docs** — rich text, tables, comments | **Sheets** — formulas, charts, pivots |
| <img src="docs/screenshots/docs-editor.png" alt="Docs" /> | <img src="docs/screenshots/sheets-editor.png" alt="Sheets" /> |
| **Slides** — themes, transitions, present | **Calendar** — events, recurrence, `.ics` |
| <img src="docs/screenshots/slides-editor.png" alt="Slides" /> | <img src="docs/screenshots/calendar.png" alt="Calendar" /> |
| **Contacts** — vCard, duplicate detection | **Spaces** — channels, DMs, threads |
| <img src="docs/screenshots/contacts.png" alt="Contacts" /> | <img src="docs/screenshots/spaces.png" alt="Spaces" /> |
| **Meet** — voice / video from a Space | **Signing** — annotate & sign PDFs |
| <img src="docs/screenshots/meetings.png" alt="Meet" /> | <img src="docs/screenshots/pdf-editor.png" alt="Signing" /> |

> Regenerate anytime with `npm run screenshots` (Playwright; see `scripts/screenshots.mjs`).

---

## Features

| Surface | Description |
|---------|-------------|
| **Docs** | Rich-text editing via TipTap — headings, tables, task lists, links, images, comments |
| **Sheets** | Full spreadsheet grid via Fortune Sheet — formulas, formatting, multi-sheet, charts, pivots |
| **Slides** | Presentation editor powered by Reveal.js — theme, transition, and present from the browser |
| **Calendar** | Events, recurrence (iCalendar / rrule), reminders, `.ics` import / export |
| **Contacts** | Contact management with vCard import / export and duplicate detection |
| **Spaces** | Team channels, DMs, threads, reactions, pins, search, and presence |
| **Meet** | Voice / video meetings launched straight from a Space |
| **Signing** | View, annotate, and sign PDFs; multi-party signing envelopes with a cryptographic audit trail |
| **Import / Export** | `.docx`, `.xlsx`, `.csv`, `.pptx`, `.pdf`, Markdown, and from URL |
| **Storage** | Local files + SQLite by default; optional PostgreSQL for multi-user |
| **Auth** | Optional password / JWT login — off by default for local use |
| **Single binary** | The Go server embeds the whole frontend — one file to deploy |
| **PWA-ready** | Installable as a desktop / mobile app via web manifest |
| **Observability** | Prometheus metrics at `/metrics` and optional OpenTelemetry traces |

Every surface is also published as an npm library (`@vulos/office-client`) so the Vulos shell — or your own app — can embed any editor as a native panel:

```js
import { DocsEditor }   from '@vulos/office-client/docs'
import { SheetsEditor } from '@vulos/office-client/sheets'
import { SlidesEditor } from '@vulos/office-client/slides'
import { CalendarApp }  from '@vulos/office-client/calendar'
import { ContactsApp }  from '@vulos/office-client/contacts'
```

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  React + Vite + Tailwind frontend  (JSX only)          │
│  Docs · Sheets · Slides · Calendar · Contacts ·        │
│  Spaces · Meet · Signing                                │
└────────────────────────────────────────────────────────┘
                 │  embedded into the binary
                 ▼
┌────────────────────────────────────────────────────────┐
│  Go backend (Gin)                                       │
│  handlers · userauth · spaces · signing · storage · obs │
│                                                         │
│  backend/seam  ── Identity · Entitlements · Usage ──┐   │
│   standalone defaults (local, unlimited, no-op)     │   │
└─────────────────────────────────────────────────────┼──┘
                                                       │ optional
                                                       ▼
                                  backend/integration/cloud
                                  (vulos-cloud adapter, opt-in)
```

The boundary between Office's core and any external control plane is a small set of Go interfaces in `backend/seam`. The composition root (`main.go`) wires the standalone defaults via `seam.NewStandaloneProvider(...)`:

| Interface | Standalone default |
|-----------|--------------------|
| `seam.Identity` | `LocalIdentity` — verifies Office's own HS256 session JWT |
| `seam.Entitlements` | `LocalEntitlements` — unlimited, `self-hosted` tier, all features |
| `seam.Usage` | `NoopUsage` — discards metering (Prometheus still exported) |

The cloud adapter lives in a **separate package** and is selected *only* when `VULOS_CP_BASE_URL` is set. With it unset (the default), none of it runs. See [SELFHOST.md](SELFHOST.md) for the full seam contract.

---

## Quick start

### Prerequisites

- [Go 1.25+](https://golang.org/dl/)
- [Node.js 18+](https://nodejs.org/) and npm

### Run it (standalone, zero config)

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

### Docker

```bash
docker run -d \
  --name vulos-office \
  -p 8080:8080 \
  -v office-data:/data \
  ghcr.io/vul-os/vulos-office:latest
```

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
| `VULOS_OFFICE_JWT_SECRET` | HS256 secret for session JWTs — **required when auth is enabled** |
| `VULOS_OFFICE_DEV` | `1` uses a labelled insecure dev secret — local development only |
| `VULOS_OFFICE_CORS_ORIGINS` | Comma-separated allowed CORS origins |
| `VULOS_USERAUTH_DB` / `VULOS_CALSTORE_DB` / `VULOS_CONTACTSTORE_DB` / `VULOS_LOBBY_DB` | Override individual SQLite store paths |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enable OpenTelemetry trace export |
| `VULOS_CP_BASE_URL` | **Opt-in** vulos-cloud control plane URL (enables the cloud seam) |
| `VULOS_CP_TOKEN` | Outbound service token for the control plane |
| `VULOS_ORG_ID` | Tenant / org scoping (used by the cloud adapter and storage) |

To enable multi-user auth (still fully standalone — no control plane):

```bash
# config.yaml → auth.enabled: true
export VULOS_OFFICE_JWT_SECRET="$(openssl rand -hex 32)"
./vulos-office
```

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the complete reference.

---

## Development & testing

```bash
npm run dev:web        # Vite (:5173) + Go API (:8080)
npm test               # frontend tests (Vitest)
npm run build          # frontend dist/ + Go binary
npm run build:all      # all sub-targets (office / talk / calendar / meet) + library
npm run build:lib      # @vulos/office-client library only

# Backend
go test ./...
go vet ./...
```

> **Frozen invariants:** pure Go (no CGO), JSX only (never `.tsx`), no Google SSO, no Stripe. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Self-hosting

Vulos Office is **built to be self-hosted by you**, not rented from anyone. The standalone path is the default and requires no cloud, no account, and no external service:

- **Identity** is local — every request is the `self` account in single-user mode; flip on multi-user auth with a JWT secret.
- **Entitlements** are unlimited (`tier: self-hosted`) — no metering, no quotas, all features on.
- **Storage** is local files + SQLite under `./data` and `./uploads`.

Full standalone instructions, the seam contract, and the optional cloud integration are in **[SELFHOST.md](SELFHOST.md)**. Deployment notes (Docker, single-box co-location) live in [docs/DEPLOY.md](docs/DEPLOY.md) and [DEPLOY.md](DEPLOY.md).

### Optional: the vulos-cloud seam

Setting `VULOS_CP_BASE_URL` selects the `backend/integration/cloud` adapter, which implements the same `seam` interfaces against the [vulos-cloud](https://vulos.org) control plane for multi-tenant identity, entitlements, and usage. Entitlement fetches **fail open** on a transient outage. Leave it unset and Office is 100% standalone.

---

## Documentation

| Document | Description |
|----------|-------------|
| [SELFHOST.md](SELFHOST.md) | Run fully standalone; the optional cloud seam |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Full setup walkthrough |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component map and design decisions |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Env vars, `config.yaml`, OTEL / SMTP reference |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Self-hosting, Docker, single-box co-location |
| [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md) | Plans and version history |

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
