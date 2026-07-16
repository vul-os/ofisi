# Ofisi — Documentation Index

| Document | Description |
|----------|-------------|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Full setup walkthrough (dev + prod + Docker + bundle) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Component map, collaboration transports, key design decisions |
| [API.md](API.md) | REST API reference (files, versions, collab, signing) |
| [CONFIGURATION.md](CONFIGURATION.md) | All env vars, config.yaml reference, OTEL/SMTP/storage |
| [TESTING.md](TESTING.md) | Test layers (Vitest unit + RTL/MSW integration, Playwright E2E) |
| [SCREENSHOTS.md](SCREENSHOTS.md) | Screenshot gallery + how to regenerate |
| [DEPLOY.md](DEPLOY.md) | Self-hosting guide, Docker, static CDN (Tigris) |
| [INSTALL.md](INSTALL.md) | Single-box install with Vulos OS + shared storage |
| [../src/design/DESIGN.md](../src/design/DESIGN.md) | Design system (near-black token model, primitives) |
| [RELEASING.md](RELEASING.md) | Release policy and CI pipeline |
| [../ROADMAP.md](../ROADMAP.md) | Planned features and milestones |
| [../CHANGELOG.md](../CHANGELOG.md) | Version history |
| [../TASKS.md](../TASKS.md) | Implementation task tracker |
| [../SECURITY.md](../SECURITY.md) | Security policy |
| [../SLOs.md](../SLOs.md) | Service level objectives |

## Quick links

- Backend entry point: `main.go` (Gin HTTP server)
- File/version API: `backend/handlers/`
- PDF signing: `backend/signing/`
- Observability: `backend/obs/` + `GET /metrics`
- Library exports: `src/lib/index.js`, `src/apps/*/lib.jsx`
