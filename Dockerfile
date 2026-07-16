# Dockerfile — Vulos Office deploy image (Go server + embedded Vite SPA).
#
# Produces the image the README advertises as
#   ghcr.io/vul-os/vulos-office:latest
# a single static Go binary that EMBEDS the built SPA (//go:embed all:dist in
# main.go) and serves everything on :8080. Runs completely standalone — no
# config file, no cloud, no account.
#
# ── BUILD CONTEXT (read before building) ──────────────────────────────────────
# Vulos Office's SPA has one SIBLING npm package:
#   - npm: package.json has `@vulos/relay-client: file:../vulos-relay/client`
# That `../` path escapes the repo, so the Docker build context MUST be the
# PARENT directory that holds vulos-office/ alongside vulos-relay/. Build from
# the parent (the dir that checks out both repos — the CI runner already has
# this layout):
#
#   # from the directory that CONTAINS vulos-office/ vulos-relay/
#   docker build -f vulos-office/Dockerfile -t ghcr.io/vul-os/vulos-office:latest .
#
# A plain `docker build .` from inside vulos-office/ will FAIL — the sibling
# repo is not reachable from that context.
#
# Run:
#   docker run -d --name vulos-office -p 8080:8080 \
#     -v office-data:/srv/data -v office-uploads:/srv/uploads \
#     ghcr.io/vul-os/vulos-office:latest
#   # open http://localhost:8080

# ── Stage 1: build the SPA (needs the sibling npm package) ────────────────────
FROM node:20-bookworm AS web
WORKDIR /build
# Copy the sibling npm package first so the file: dep resolves, then the app.
COPY vulos-relay/client   /build/vulos-relay/client
COPY vulos-office         /build/vulos-office
# Drop any node_modules dragged in from the host (the build context has no
# .dockerignore since it is the parent dir). Host node_modules hold platform-
# native binaries (e.g. macOS rollup) that break under Linux — force clean
# Linux installs everywhere.
RUN rm -rf /build/vulos-office/node_modules \
           /build/vulos-relay/client/node_modules
# Pre-build the file: sibling package FIRST. It ships uncommitted build outputs
# and its own devDeps (vite) — so it must be installed+built with its OWN
# toolchain before the app can consume it.
RUN cd /build/vulos-relay/client && npm install --no-audit --no-fund && npm run build
WORKDIR /build/vulos-office
# `npm ci` needs a lockfile in sync; the repo ships package-lock.json. Fall back
# to `npm install` only if ci fails (e.g. sibling versions drifted locally).
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
# Produces dist/ (the embedded SPA). vite.config.js recreates dist/.gitkeep.
RUN npm run build:frontend

# ── Stage 2: build the static Go binary ───────────────────────────────────────
FROM golang:1.25-bookworm AS build
ARG VERSION=docker
WORKDIR /build
COPY vulos-office /build/vulos-office
WORKDIR /build/vulos-office
# Overlay the freshly-built SPA so //go:embed all:dist bakes in real assets
# instead of the committed dist/.gitkeep placeholder.
COPY --from=web /build/vulos-office/dist /build/vulos-office/dist
RUN go mod download
# Pure-Go (Postgres via pgx, local storage without cgo) — CGO off yields a
# static binary that runs on a tiny alpine runtime.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.Version=${VERSION}" \
    -o /out/vulos-office .

# ── Stage 3: minimal non-root runtime ─────────────────────────────────────────
FROM alpine:3.20
# ca-certificates for outbound TLS (optional identity/entitlements seam, OTLP);
# wget for the healthcheck.
RUN apk add --no-cache ca-certificates wget \
 && adduser -D -u 10001 vulos
COPY --from=build /out/vulos-office /usr/local/bin/vulos-office
# The server's data_dir/uploads_dir default to ./data and ./uploads relative to
# CWD. Run from /srv and pre-create both subdirs (owned by vulos) so local
# storage + uploads have a writable home. Declare BOTH as volumes: /srv/data
# holds SQLite stores + the JSON file store (documents), and /srv/uploads holds
# uploaded file staging — without a volume there too, uploads are lost on
# container recreation even though /srv/data is persisted.
WORKDIR /srv
RUN mkdir -p /srv/data /srv/uploads && chown -R vulos:vulos /srv
USER vulos
VOLUME ["/srv/data", "/srv/uploads"]
EXPOSE 8080
# Liveness: main.go serves GET /healthz on :8080.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/vulos-office"]
