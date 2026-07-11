# Self-hosting Vulos Office (standalone, no cloud)

Vulos Office runs **completely standalone** as an open-source project with **no
dependency on vulos-cloud** (the "cp" control plane). The standalone path is the
default and works with **zero cloud configuration**. Cloud integration is
**optional** and lives entirely behind a clean seam.

## Quick start (zero cloud config)

```sh
# Build (frontend is embedded in the binary under dist/)
go build -o vulos-office .

# Run — single-user / local mode, no auth, no cloud
./vulos-office
# → http://localhost:8080
```

That's it. With no environment variables set:

- **Identity** is local: in single-user mode every request is the `self`
  account. Enable multi-user auth by setting `auth.enabled: true` in
  `config.yaml` and a JWT secret (below).
- **Entitlements** are unlimited (`tier: self-hosted`) — no metering, no quotas,
  all features enabled.
- **Usage metering** is a no-op. Operational metrics are still exported at
  `/metrics` (Prometheus) and traces via `OTEL_EXPORTER_OTLP_ENDPOINT` if set.
- **Storage** is local/SQLite under `./data` + `./uploads`. No object store and
  no `VULOS_ORG_ID` are required (single-tenant mode).

## Enabling authentication (still standalone)

Multi-user auth uses office's built-in per-user credential store and locally
signed HS256 session JWTs — no control plane involved.

```sh
# config.yaml → auth.enabled: true
export VULOS_OFFICE_JWT_SECRET="$(openssl rand -hex 32)"   # required when auth is on
./vulos-office
```

For local development only you may instead set `VULOS_OFFICE_DEV=1`, which uses
a clearly-labelled insecure dev secret. **Never set that in production.**

Bootstrap the first user via `POST /api/auth/register`, then mint invite tokens
from an admin account. See `README.md` for the full auth flow.

## The integration seam

The boundary between office's core and any external control plane is a small set
of Go interfaces in `backend/seam`:

| Interface           | Standalone default (`backend/seam`)                         |
| ------------------- | ----------------------------------------------------------- |
| `seam.Identity`     | `LocalIdentity` — verifies office's own HS256 session JWT    |
| `seam.Entitlements` | `LocalEntitlements` — unlimited / `self-hosted`, all features |
| `seam.Usage`        | `NoopUsage` — discards metering (Prometheus still exported)  |

The composition root (`main.go`) wires the standalone defaults with
`seam.NewStandaloneProvider(...)`. **The core never imports any cloud code**, so
the standalone build cannot break if the cloud adapter is removed.

## Optional: vulos-cloud control plane

The cloud adapter is a **separate package** (`backend/integration/cloud`) that
implements the same `seam` interfaces against the control plane. It is selected
**only** when `VULOS_CP_BASE_URL` is set:

```sh
export VULOS_CP_BASE_URL="https://cp.vulos.org"   # enables the cloud adapter
export VULOS_CP_TOKEN="<service token>"           # optional outbound auth
export VULOS_ORG_ID="<org id>"                    # tenant scoping (also used by storage)
```

When enabled:

- Identity is still verified locally (office tokens are HS256-signed with a
  shared secret) but stamped with the configured `OrgID`.
- Entitlements are fetched from `GET {CP}/api/entitlements` (fails **open** on a
  transient cp outage).
- Usage events are posted fire-and-forget to `POST {CP}/api/usage`.

With `VULOS_CP_BASE_URL` unset (the default), none of this runs and office is
fully standalone.
