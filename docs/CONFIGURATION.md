# Ofisi — Configuration Reference

All runtime configuration for Ofisi is driven by `config.yaml` and environment variables. Environment variables take precedence over the config file.

By default the server looks for `config.yaml` in the process's current working directory. Override the path with `-config` (also accepted as `--config`; Go's flag parser treats both the same), e.g.:

```sh
vulos-office -config /etc/vulos-office/config.yaml
```

Ofisi never refuses to start over a config problem — this is deliberate for a zero-config first run, but means a typo'd `-config` path fails silently:

- **Missing file** (wrong path, typo): silently falls back to built-in defaults — no error, no log line. If a setting doesn't seem to be taking effect, double-check the path first (e.g. `ls -la <path>`).
- **File present but invalid YAML**: falls back to defaults AND logs `Config error: … — using defaults` on boot.

The `migrate` subcommand (`vulos-office migrate up|status`) takes its own `-config` flag, defaulting the same way; it is a separate flag set from the server command, so pass it after `migrate`: `vulos-office migrate -config /etc/vulos-office/config.yaml up`.

---

## config.yaml

```yaml
server:
  addr: ":8080"            # Listen address (default :8080)
  data_dir: "./data"       # Root directory for SQLite stores, JSON file store
  uploads_dir: "./uploads" # Uploaded file staging area

auth:
  enabled: false           # true = require password login; false = open access (local dev)
  password: "changeme"     # Shared password (single-user mode / migration source)
  max_attempts: 5          # Failed logins before lockout
  lockout_minutes: 15      # Lockout duration
  session_hours: 24        # JWT session expiry

storage:
  type: "local"            # "local" (JSON files) or "postgres"
  postgres:                # Only used when type: "postgres"
    host: "localhost"
    port: 5432
    user: "postgres"
    password: ""
    database: "vulos_office"
    sslmode: "disable"

persistence:
  updatelog: false         # CRDT-native persistence (see below)

collab:
  rendezvous_url: ""       # Self-hosted relayd for OS-free P2P collab (see below)
```

### `persistence.updatelog` — the CRDT update log

Off by default. When `true`, Ofisi exposes the per-file **append-only CRDT
update log** (`POST`/`GET /api/files/:id/updates`) — the durability
model that supersedes "single blob + 409 compare-and-swap". Every CRDT frame is
kept (opaque, encrypted-or-plain Yjs / sheet / slide updates), so two clients
that edited **offline** both converge with nothing discarded. It is **additive**:
the whole-document PUT keeps working and the frontend dual-writes, so toggling
this flag never loses a document.

**Store backend** follows `storage.type` automatically — no separate setting:

| `storage.type` | Update-log backend | Where frames live |
|----------------|--------------------|-------------------|
| `local` (default) | filesystem `LocalStore` | `<data_dir>/updates/<id>/` |
| `s3` | filesystem `LocalStore` (fallback) | `<data_dir>/updates/<id>/` |
| `postgres` | `PostgresStore` (shares the storage pool) | `office.file_updates` + `office.file_update_snapshots` |

The Postgres backend derives its monotonic per-file seq under a
transaction-scoped **per-file advisory lock** and runs snapshot-upsert + frame
prune in one transaction. (S3 has no atomic append-with-monotonic-seq primitive,
so its durable frame log stays on local disk; the whole-doc PUT still writes the
object copy to the bucket.)

**Quota**: a frame append passes the **same storage-quota gate** as a whole-doc
PUT, so the log cannot be used to bypass a storage cap (standalone/unlimited →
no-op).

**Compaction** is client-driven; the server can only *nudge*. It cannot fold
opaque CRDT frames into a snapshot itself, so when a file's un-compacted tail
grows past `updatelog.CompactAdviseThreshold` (default 600) the append response
returns `compact: true` and the client posts a snapshot. There is no server
setting to tune here.

The frontend only mirrors edits into the log when built with
`VITE_UPDATE_LOG=on` (Docs, Whiteboard, Sheets, and Slides are all wired);
without it the server routes still exist but the client keeps using
whole-document autosave (and self-disables the log path cleanly if the endpoint
is absent). Enable both together.

---

### `collab.rendezvous_url` — P2P collaboration with no Vulos OS / host box

Blank by default. Ofisi's own backend never mediates live collaboration — the
Docs/Whiteboard invite-link path and the Sheets/Slides presence layer both talk
peer-to-peer over `@vulos/relay-client`'s `FabricClient` (see
[COLLABORATION.md](COLLABORATION.md) §3). That transport needs a lightweight,
content-blind peer-discovery surface, and Ofisi picks one of three, in order:

1. **This server's own peering fabric** (`/api/peering/*`) — present only when
   a Vulos OS / Vulos Relay deployment fronts Ofisi. Unchanged default.
2. **A configured rendezvous URL** — the base URL of any **self-hosted
   `vulos-relayd`**'s OPEN rendezvous surface (announce/resolve/signal/mailbox
   + ICE). The browser talks to it **directly** — no Vulos OS, no account, no
   host-box backend required at all. Set it and a bare **standalone** Ofisi
   binary (which mounts no `/api/peering/*` — see `main.go`) gets **real**
   peer-to-peer collaboration.
3. **Local-only** — neither is reachable; the editor keeps working, autosaves,
   and says so honestly (an "Offline" pill) instead of showing a false "Live".

```yaml
collab:
  rendezvous_url: "https://relay.example.org"   # any self-hosted vulos-relayd
```

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_RENDEZVOUS_URL` / `OFISI_RENDEZVOUS_URL` | Overrides `collab.rendezvous_url`. Any URL a `vulos-relayd` serves its rendezvous surface on. | — (unset) |

Exposed **read-only** to the browser at the unauthenticated `GET /api/reachability`
(as `rendezvous_url`), so setting the env var takes effect without a frontend
rebuild — the same endpoint also carries `public_base_url`, this server's own
externally-reachable origin:

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_OFFICE_PUBLIC_URL` | This Office instance's externally-reachable origin (a public domain, or a vulos-relay tunnel URL when behind NAT/CGNAT). Used to build P2P invite links / signaling targets an external peer can actually reach, instead of blindly trusting `window.location.origin` (which may be a LAN-only address). | — (falls back to the visitor's own origin) |

See `backend/config/config.go` and `src/lib/collab/transportSelection.js` for
the selection logic, and `src/lib/collab/reachableBase.js` for the client-side
fetch/cache.

---

## Environment variables

### Auth / JWT

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_OFFICE_JWT_SECRET` | HS256 signing secret — **required** when `auth.enabled: true` | — |
| `VULOS_OFFICE_REGISTRATION_TOKEN` | Static fallback registration token (prefer invite tokens) | — |

### SSO session introspection (multi-user)

Ofisi holds **no session-signing power**. When an identity provider is configured it validates the browser's `vc_session` cookie by introspection instead of verifying a signature Ofisi minted.

| Variable | Description | Default |
|----------|-------------|---------|
| `IDENTITY_URL` | Identity-provider base URL (sovereign box in self-host, CP in cloud). **SET** → Ofisi introspects `vc_session` at `POST {IDENTITY_URL}/api/session/introspect` and fails **closed** (401) on invalid/expired/unreachable. **UNSET** → SSO disabled; existing local single-identity behavior unchanged. | — (unset) |
| `VULOS_CP_TOKEN` | Shared service-auth secret presented as `X-Relay-Auth` on the introspection call (== the provider's `CP_SHARED_SECRET`). Reused from the existing API-key / entitlements path — **not a signing key**. | — |

Precedence (first match wins): `vk_` API key → per-product session JWT → SSO `vc_session` introspection → 401. On a valid session the request is scoped to the resolved **user + tenant** (`tenantId` = account id); results are cached in-process for ~45s (bounded by the session's `expiresAt`) so it is not a round-trip per request.

**Operator quick-reference**

- Self-host single-user box: leave `IDENTITY_URL` unset. Nothing else to do.
- Cloud / multi-user: set `IDENTITY_URL=https://api.vulos.org` and `VULOS_CP_TOKEN=<CP shared secret>` (plus `auth.enabled: true` / `VULOS_OFFICE_JWT_SECRET` if you also keep native JWT logins).

### Persistence

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_PERSISTENCE_UPDATELOG` / `OFISI_UPDATE_LOG` | Enable the CRDT update log (overrides `persistence.updatelog`). Accepts `1/true/on/yes`. | `false` |

### Database paths (SQLite)

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_USERAUTH_DB` | Per-user credential store DSN | `./data/userauth.db` |
| `VULOS_INVITES_DB` | Invite-token store DSN | `./data/invites.db` |
| `VULOS_AUDIT_DB` | Append-only audit-log DSN | `./data/audit.db` |
| `VULOS_FILEACL_DB` | File-ACL store DSN (SQLite backend only) | `./data/fileacl.db` |

### S3-compatible storage (Tigris default)

These are consumed by `OfficeTigrisDefaults()` in `backend/storage/backendconfig.go`:

| Variable | Description | Default |
|----------|-------------|---------|
| `TIGRIS_ENDPOINT` | S3-compatible endpoint URL | `https://fly.storage.tigris.dev` |
| `TIGRIS_REGION` | Storage region | `auto` |
| `TIGRIS_ACCESS_KEY_ID` | Access key | — |
| `TIGRIS_SECRET_ACCESS_KEY` | Secret key | — |

For BYO/MinIO deployments inject `OfficeBackendConfig` directly (see [INSTALL.md](INSTALL.md)).

### Bundle (shared with Vulos OS)

Written by the OS storage-mode selector; consumed by all three bundle services:

| Variable | Description |
|----------|-------------|
| `VULOS_STORAGE_MODE` | `central-tigris` (default) or `local-minio-sync` |
| `VULOS_MINIO_ENDPOINT` | MinIO endpoint (only in `local-minio-sync` mode) |
| `VULOS_MINIO_REGION` | Region (default `auto`) |
| `VULOS_MINIO_BUCKET` | Shared bucket name |
| `VULOS_MINIO_CREDS_REF` | Path to credentials file |

### SMTP (optional)

Ofisi itself does not send mail. If you want outbound notifications, point Ofisi at an external SMTP relay:

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP relay host |
| `SMTP_PORT` | SMTP port (default `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASSWORD` | SMTP password |
| `SMTP_FROM` | From address |

### Observability (OpenTelemetry)

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for traces (optional) |
| `OTEL_SERVICE_NAME` | Service name tag (default `vulos-office`) |

Prometheus metrics are always available at `GET /metrics` (no env var needed).

---

## Org-bucket wiring

`backend/storage/backendconfig.go` exposes `OfficeBackendConfig` for per-org S3 bucket + CRDT snapshot configuration injected by the Vulos control plane. This is the canonical configuration path for multi-tenant Hosted deployments — do not duplicate it in environment variables.

---

## See also

- [GETTING-STARTED.md](GETTING-STARTED.md) — first-run walkthrough
- [DEPLOY.md](DEPLOY.md) — production deployment
- [INSTALL.md](INSTALL.md) — single-box bundle install
- [ARCHITECTURE.md](ARCHITECTURE.md) — component map
