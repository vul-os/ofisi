# Vulos Office — Configuration Reference

All runtime configuration for Vulos Office is driven by `config.yaml` (file path configurable via `--config`) and environment variables. Environment variables take precedence over the config file.

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
```

---

## Environment variables

### Auth / JWT

| Variable | Description | Default |
|----------|-------------|---------|
| `VULOS_OFFICE_JWT_SECRET` | HS256 signing secret — **required** when `auth.enabled: true` | — |
| `VULOS_OFFICE_REGISTRATION_TOKEN` | Static fallback registration token (prefer invite tokens) | — |

### SSO session introspection (multi-user)

Office holds **no session-signing power**. When an identity provider is configured it validates the browser's `vc_session` cookie by introspection instead of verifying a signature Office minted.

| Variable | Description | Default |
|----------|-------------|---------|
| `IDENTITY_URL` | Identity-provider base URL (sovereign box in self-host, CP in cloud). **SET** → Office introspects `vc_session` at `POST {IDENTITY_URL}/api/session/introspect` and fails **closed** (401) on invalid/expired/unreachable. **UNSET** → SSO disabled; existing local single-identity behavior unchanged. | — (unset) |
| `VULOS_CP_TOKEN` | Shared service-auth secret presented as `X-Relay-Auth` on the introspection call (== the provider's `CP_SHARED_SECRET`). Reused from the existing API-key / entitlements path — **not a signing key**. | — |

Precedence (first match wins): `vk_` API key → per-product session JWT → SSO `vc_session` introspection → 401. On a valid session the request is scoped to the resolved **user + tenant** (`tenantId` = account id); results are cached in-process for ~45s (bounded by the session's `expiresAt`) so it is not a round-trip per request.

**Operator quick-reference**

- Self-host single-user box: leave `IDENTITY_URL` unset. Nothing else to do.
- Cloud / multi-user: set `IDENTITY_URL=https://cp.vulos.to` and `VULOS_CP_TOKEN=<CP shared secret>` (plus `auth.enabled: true` / `VULOS_OFFICE_JWT_SECRET` if you also keep native JWT logins).

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

Office itself does not send mail — outbound notifications are handled by the vulos-mail service when co-located. In standalone mode you may point at an external relay:

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
