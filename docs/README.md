# Vulos Office — Documentation Index

| Document | Description |
|----------|-------------|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Full setup walkthrough (dev + prod + Docker + bundle) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component map and key design decisions |
| [CONFIGURATION.md](CONFIGURATION.md) | All env vars, config.yaml reference, OTEL/SMTP/storage |
| [SCREENSHOTS.md](SCREENSHOTS.md) | Screenshot gallery + how to regenerate |
| [DEPLOY.md](DEPLOY.md) | Self-hosting guide, Docker, static CDN (Tigris) |
| [INSTALL.md](INSTALL.md) | Single-box install with Vulos OS + shared storage |
| [RELEASING.md](RELEASING.md) | Release policy and CI pipeline |
| [../ROADMAP.md](../ROADMAP.md) | Planned features and milestones |
| [../CHANGELOG.md](../CHANGELOG.md) | Version history |
| [../TASKS.md](../TASKS.md) | Implementation task tracker |
| [../SECURITY.md](../SECURITY.md) | Security policy |
| [../SLOs.md](../SLOs.md) | Service level objectives |

## Quick links

- Backend entry point: `main.go` (Gin HTTP server)
- Spaces CRDT store: `backend/spaces/store.go`
- File/version API: `backend/handlers/`
- PDF signing: `backend/signing/`
- Observability: `backend/obs/` + `GET /metrics`
- Library exports: `src/lib/index.js`, `src/apps/*/lib.jsx`
