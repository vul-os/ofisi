# Vendored `@vulos/relay-client`

This directory is a **vendored copy** of the Vulos Relay JS client SDK
(`@vulos/relay-client`). It is committed into this repo so that a fresh
`git clone && npm install && npm run build` succeeds **with no sibling
checkout** of `vulos-relay` — the build no longer depends on a
`file:../vulos-relay/client` path outside this repository.

Ofisi consumes it via `"@vulos/relay-client": "file:third_party/relay-client"` in the
root `package.json`.

## What is vendored

Only the SDK **source** (`src/`, plain ESM JavaScript — no build step, no JSX),
plus `LICENSE` and `README.md`. The exports in this copy's `package.json` point
directly at `src/*.js`, so Vite and Vitest resolve the SDK from source with no
compiled `dist-lib/` artifact to keep in sync.

## Sync from upstream

The canonical source is `vulos-relay/client` in the `vulos-relay` repo. To refresh
this vendored copy after an upstream change, from the ofisi repo root:

```sh
# Adjust the path if your vulos-relay checkout lives elsewhere.
UPSTREAM=../vulos-relay/client

rm -rf third_party/relay-client/src
cp -R "$UPSTREAM/src" third_party/relay-client/src
rm -rf third_party/relay-client/src/__tests__      # tests are not vendored
cp "$UPSTREAM/LICENSE" third_party/relay-client/LICENSE
cp "$UPSTREAM/README.md" third_party/relay-client/README.md
```

Then reconcile `third_party/relay-client/package.json` if upstream changed its
dependency/peerDependency set or added/removed a subpath export (this file's
`exports` map lists each subpath and must cover any new one), and run
`npm install` to refresh the lockfile. Keep the `version` field in step with the
upstream SDK version for traceability.

Do **not** hand-edit files under `src/` — edit upstream and re-vendor, so the
copies never diverge.
