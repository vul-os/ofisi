<div align="center">

<img src="public/vula-office.png" alt="Vulos Office Logo" width="120" />

# Vulos Office

**Documents · Sheets · Slides · PDF · Spaces · Calendar**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white)](https://golang.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38BDF8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/vul-os/vulos-office/pulls)

*Vulos — rooted in **vula**, the Zulu and Xhosa word for **open**.*

</div>

---

## What is Vulos Office?

Vulos Office is a self-hosted, open-source office suite that ships as a **single Go binary**. It brings document editing, spreadsheets, presentations, PDF annotation and signing, team chat (Spaces), and calendar together in a clean, modern interface — no cloud account required, no telemetry, no lock-in.

It stands as a tribute to the spirit of **LibreOffice** and **OpenOffice** — the pioneers who proved that powerful productivity software could be free, open, and community-driven. Vulos carries that torch into the browser, with a lightweight Go backend and a fast React frontend, deployable anywhere in seconds.

> *"Vula" — open the door. Vulos Office is that door.*

---

## Features

| | |
|---|---|
| **Documents** | Rich text editing via TipTap — headings, tables, lists, task lists, links, images, track-changes |
| **Spreadsheets** | Full-featured grid via Fortune Sheet — formulas, formatting, multi-sheet, import/export |
| **Presentations** | Slide editor powered by Reveal.js — create, theme, and present from the browser |
| **PDF** | View, annotate, sign; multi-party signing envelopes with cryptographic audit trail |
| **Export** | `.docx`, `.xlsx`, `.pptx`, `.pdf`, Markdown |
| **Import** | DOCX, XLSX, CSV, PPTX, URL, local file |
| **Vulos Spaces** | Team channels, DMs, threads, reactions, pins, search, presence, voice/video meetings |
| **Calendar** | Events, recurrence (iCalendar/rrule), reminders, .ics import/export |
| **Contacts** | Contact management, vCard import/export, duplicate detection |
| **Auth** | Optional password-based auth with JWT — off by default for local use |
| **Storage** | Local JSON files (default); PostgreSQL for multi-user; S3-compatible (Tigris/MinIO) |
| **Single binary** | Go embeds the entire frontend — one file to deploy |
| **PWA-ready** | Installable as a desktop/mobile app via web manifest |

---

## @vulos/office-client — embedding in the Vulos OS

Vulos Office is also published as an npm library (`@vulos/office-client`) so the Vulos OS shell can embed any surface as a native app panel.

```js
import { DocsEditor } from '@vulos/office-client/docs'
import { SheetsEditor } from '@vulos/office-client/sheets'
import { SlidesEditor } from '@vulos/office-client/slides'
import { PDFEditor }    from '@vulos/office-client/pdf'
import { SpacesApp }   from '@vulos/office-client/spaces'
import { CalendarApp } from '@vulos/office-client/calendar'
import { ContactsApp } from '@vulos/office-client/contacts'
```

Consume it from the OS repo via local file reference:

```json
"dependencies": {
  "@vulos/office-client": "file:../vulos-office"
}
```

> **Codebase rule:** this repo uses `.jsx` only — never `.tsx`.

---

## Real-time collaboration

**Today:** Edits are persisted through the REST API. The client-side CRDT modules (`src/lib/crdt/`) run in the browser for local merge ordering and offline-tolerant Spaces messaging. The Go backend Spaces store applies CRDT op convergence for messages.

**Future (planned):** Live P2P document co-editing over the Vulos peer fabric (WebRTC data channels + relay/TURN fallback). This milestone is currently dormant — see [ROADMAP.md](ROADMAP.md) for details.

---

## Getting Started

### Prerequisites

- [Go 1.21+](https://golang.org/dl/)
- [Node.js 18+](https://nodejs.org/) and npm

### Development

```bash
# Clone the repo
git clone https://github.com/vul-os/vulos-office.git
cd vulos-office

# Install dependencies
npm install
go mod tidy

# Start dev server (Vite on :5173 + Go on :8080)
npm run dev:web
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Production Build

```bash
# Build frontend + Go binary in one step
npm run build

# Run the single binary
./vulos-office

# Check the build version
./vulos-office --version
```

Open [http://localhost:8080](http://localhost:8080). The entire app is embedded in the binary.

---

## Configuration

Edit `config.yaml` before starting:

```yaml
server:
  port: ":8080"
  data_dir: ./data      # SQLite stores for calendar, contacts, auth, spaces

auth:
  enabled: false          # Set to true to require a password
  password: "changeme"
  session_timeout: 24h
  max_failed_attempts: 5
  lockout_duration: 15m

storage:
  type: local             # "local" (JSON files) or "postgres"
  local_path: ./data

# Uncomment for PostgreSQL:
# database:
#   host: localhost
#   port: 5432
#   name: vulos
#   user: vulos
#   password: secret
```

For single-box co-location with Vulos OS and vulos-relay, see [docs/INSTALL.md](docs/INSTALL.md).

---

## Project Structure

```
vulos-office/
├── main.go                  # Entry point — embeds dist/, runs Gin server
├── config.yaml              # App configuration
├── backend/
│   ├── config/              # Config loading
│   ├── fileacl/             # Per-file ACL store (SQLite/Postgres)
│   ├── handlers/            # HTTP handlers (files, auth, spaces, meetings,
│   │                        #   calendar, contacts, signing, versions, …)
│   ├── invites/             # Invite token store
│   ├── middleware/          # JWT auth middleware
│   ├── models/              # Shared data models
│   ├── obs/                 # Prometheus metrics + OpenTelemetry
│   ├── services/            # calendar_rrule, contacts_vcf, docs_export,
│   │                        #   meeting, sheets_export, slides_export
│   ├── signing/             # PDF signing cryptography
│   ├── spaces/              # CRDT Spaces message store (SQLite/PG)
│   ├── storage/             # Storage interface (local / PostgreSQL / S3),
│   │                        #   calstore, contactstore
│   └── userauth/            # Per-user credential store (pure-Go SQLite)
├── src/
│   ├── App.jsx              # Router
│   ├── apps/                # Feature editors: docs, sheets, slides, pdf,
│   │                        #   spaces, calendar, contacts
│   ├── components/          # Layout, Home, Auth, CommentsPanel, Presence, …
│   ├── lib/
│   │   ├── api.js           # API client
│   │   └── crdt/            # Client-side CRDT modules (text, grid, tree,
│   │                        #   messages, comments, suggestions)
│   └── shells/              # CalendarShell, MeetShell, OfficeShell
├── public/                  # Static assets, favicons, PWA manifest
└── dist/                    # Built frontend (embedded in Go binary)
```

---

## Releases

Releases are tagged `vX.Y.Z` on `main`. The GitHub Actions release pipeline
(`.github/workflows/release.yml`) builds and attaches:
- `vulos-office-linux-amd64` — Go binary, linux/amd64
- `vulos-office-linux-arm64` — Go binary, linux/arm64
- `checksums.txt` — SHA-256 checksums

See [CHANGELOG.md](CHANGELOG.md) and [docs/RELEASING.md](docs/RELEASING.md).

---

## API (core routes)

| Method | Route | Description |
|--------|-------|-------------|
| `GET`  | `/version` | Build version |
| `POST` | `/api/auth/login` | Authenticate |
| `GET`  | `/api/auth/status` | Check session |
| `GET`  | `/api/files` | List files |
| `POST` | `/api/files` | Create file |
| `GET`  | `/api/files/:id` | Get file |
| `PUT`  | `/api/files/:id` | Update file |
| `DELETE` | `/api/files/:id` | Delete file |
| `POST` | `/api/upload` | Upload file |
| `GET`  | `/api/spaces/channels` | List Spaces channels |
| `GET`  | `/api/spaces/channels/:id/messages` | List messages |
| `GET`  | `/api/calendar/events` | List calendar events |
| `GET`  | `/api/contacts` | List contacts |
| `GET`  | `/api/meetings` | List meetings |
| `GET`  | `/metrics` | Prometheus metrics |

Full API reference: `docs/API.md` (forthcoming).

---

## A Nod to the Giants

Vulos Office would not exist without the open-source ecosystem that came before it.

**LibreOffice** and **OpenOffice** spent decades proving that free, open productivity software was not only possible but excellent. Their work changed how the world thinks about office software and made libre computing a reality for millions of people.

Vulos carries forward that same conviction — that tools people rely on every day should be open, auditable, self-hostable, and free. *Vula.* Open.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Made with care · Powered by open source · *Vula — open*

</div>
