# Vulos Office — Static Deploy Guide

Vulos Office bundles two separate SPAs (office, calendar), each
built with Vite and uploaded to Tigris object storage for CDN delivery.

> Vulos Office is the **documents-only** product (Docs, Sheets, Slides, PDF/Signing,
> Calendar, Contacts). Chat/Spaces ships as the separate **vulos-talk** product
> (`talk.vulos.org`) and video ships as **vulos-meet** (`meet.vulos.org`); both are
> deployed from their own repos and combined by the Vulos Workspace shell.

## Prerequisites

- AWS CLI v2 (used to upload to Tigris via the S3-compatible API)
- Node.js 20+ and npm (for Vite builds)

## Credentials

| Variable | Description |
|---|---|
| `TIGRIS_ACCESS_KEY_ID` | Tigris access key |
| `TIGRIS_SECRET_ACCESS_KEY` | Tigris secret key |
| `TIGRIS_BUCKET` | Bucket name (e.g. `vulos-office-static`) |
| `TIGRIS_ENDPOINT` | Optional; defaults to `https://fly.storage.tigris.dev` |

## Usage

Deploy all targets:
```sh
./scripts/deploy-static.sh
```

Deploy a single target:
```sh
./scripts/deploy-static.sh office
./scripts/deploy-static.sh calendar
```

Deploy and write a `latest` pointer so CDN routing resolves the current SHA:
```sh
./scripts/deploy-static.sh office --latest
./scripts/deploy-static.sh all --latest
```

## CDN URLs

Each deploy uploads to `<target>/<sha>/` in the bucket, served via Tigris static:

| Target | CDN domain | Bucket path |
|---|---|---|
| office | office.vulos.org | `office/<sha>/` |
| calendar | calendar.vulos.org | `calendar/<sha>/` |

Static files are served from `cdn.vulos.org` (Tigris, configured in your
`fly.toml` or DNS CNAME). See [vulos-naming-and-urls](../vulos/docs/) for the
canonical URL scheme.

## SPA Fallback

All targets are single-page applications that rely on the HTML5 History API.
Configure your Fly.io `fly.toml` or static server to serve `index.html` for
any unmatched path:

```toml
[[http_service]]
  # ...

[[http_service.checks]]
  # ...

# Serve SPA index.html for all unmatched paths.
[http_service.static]
  fallback = "index.html"
```

## How the `--latest` flag works

With `--latest`, the script writes the deployed SHA as a plain-text object at
`<target>/latest` in the bucket. Your CDN router or Fly proxy can read this to
resolve the current deployment without a full directory listing.

## Tigris + cdn.vulos.org

Static assets are uploaded to Tigris (`fly.storage.tigris.dev`) and served
through `cdn.vulos.org`. The Tigris bucket must have public static serving
enabled. See the [Tigris docs](https://www.tigrisdata.com/docs/objects/static-website/)
for bucket configuration.
