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

## Local patches

This vendored copy carries fixes that have NOT yet landed upstream. **A re-sync
per the section above will drop them** — re-apply each one and delete its entry
here once upstream carries it.

| File | Patch | Why |
|------|-------|-----|
| `src/fabric.js` | Persistent peer reconnect (`_scheduleReinitiate`, replacing the single 2s retry after a data-channel close) | The one retry is usually spent while the network is still down, and the rendezvous presence board dispatches a peer's `join` only once — so nothing ever tried again and the session stayed dead until a page reload. Now backs off 2s→16s, stops on connect / explicit `leave` / teardown. |
| `src/fabric.js` | Relay-circuit symmetry: start mailbox polling when a negotiation is armed (`_setRelayTimer`), keep polling while a peer is `connecting`, and adopt `relay` state for a peer whose blob we just decrypted (`_processRelayBlob`) | Only the side that gave up on the direct path started polling, so its peer never read the deposits and never answered over the circuit. The documented content-blind fallback was effectively one-directional — the peers stayed silent instead of degrading gracefully. |
| `src/fabric.js` | Perfect-negotiation glare guard in `_onSignal`'s `offer` branch (search "GLARE GUARD") | Over the rendezvous transport both peers see each other's `join` on the shared presence board, so both send an offer and — with no tie-break — each reset its own connection to answer the other's. Both negotiations were abandoned and the connection deadlocked until the 8s relay timer, failing roughly one run in three of `npm run test:e2e:p2p`. The guard makes exactly one side ignore a colliding offer. No effect on the host-box WebSocket path, where only one side ever initiates. |
