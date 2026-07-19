# Vendored `dmtap-sync-wasm`

This directory is a **vendored copy** of the DMTAP Sync substrate's WASM binding
(`crates/dmtap-sync-wasm` in the `envoir` repo). It is committed here so a fresh
`git clone && npm install && npm run build` succeeds **with no sibling checkout
of `envoir` and no Rust toolchain** — exactly the reasoning behind
`third_party/relay-client`.

Ofisi consumes it via `"dmtap-sync-wasm": "file:third_party/dmtap-sync-wasm"` in
the root `package.json`.

## Why this exists

The Vulos suite grew several independent sync engines. `dmtap-sync` is the one
shared implementation of [`substrate/SYNC.md`](../../../dmtap/substrate/SYNC.md),
and this binding is the *same compiled core* a Rust server runs — not a second
implementation of the spec that happens to agree most of the time. Upstream
proves that with 22/22 frozen conformance vectors driven byte-identically
through both the native Rust and the WASM/JS surfaces.

Ofisi's Sheets grid is the first Vulos surface to retire its hand-rolled CRDT in
favour of it. See `src/lib/crdt/substrateGrid.js`.

## What is vendored

* `vendor/dmtap_sync_bg.wasm` — the compiled core, **byte-for-byte** upstream.
* `vendor/dmtap_sync_bg.js` — the wasm-bindgen JS wrappers, byte-for-byte.
* `vendor/dmtap_sync.d.ts` — the generated types (from the Rust doc comments).
* `src/index.js` — **the only file written here.** See below.
* `LICENSE` (MIT, from `envoir/LICENSE-MIT`).

Upstream's `dmtap_sync.js` entry point is **not** vendored. It is the eight
lines of wasm-pack `--target bundler` wiring that do
`import * as wasm from './dmtap_sync_bg.wasm'` — an ESM-imports-WASM statement
that needs a Vite plugin in the browser and does not work at all under
Vitest/node. `src/index.js` replaces exactly those eight lines with an
environment-agnostic `WebAssembly.instantiate` (the module declares one import
module, `'./dmtap_sync_bg.js'`), so the browser build and the test run load the
identical `.wasm`. No algebra is reimplemented; if it were, the whole point of
adopting a shared engine would be lost.

Upstream's `pkg/` is git-ignored build output, so there is no upstream commit to
pin — the sizes below are the identity of this copy:

| Artifact | Raw | Gzipped |
|---|---:|---:|
| `vendor/dmtap_sync_bg.wasm` | 395,912 B | 154,657 B |

## Sync from upstream

```sh
# Adjust the path if your envoir checkout lives elsewhere.
UPSTREAM=../envoir/crates/dmtap-sync-wasm

"$UPSTREAM/build.sh" bundler                 # needs rust + wasm-pack
cp "$UPSTREAM"/pkg/dmtap_sync_bg.js   third_party/dmtap-sync-wasm/vendor/
cp "$UPSTREAM"/pkg/dmtap_sync_bg.wasm third_party/dmtap-sync-wasm/vendor/
cp "$UPSTREAM"/pkg/dmtap_sync.d.ts    third_party/dmtap-sync-wasm/vendor/
cp ../envoir/LICENSE-MIT              third_party/dmtap-sync-wasm/LICENSE
```

Then re-run `npm test`. `src/lib/crdt/__tests__/substrateEngine.test.js` asserts
the loader instantiates the module and that the engine's LWW algebra behaves as
`SYNC.md` §4.4 specifies — if a refreshed `.wasm` breaks either, that suite
fails rather than the breakage reaching a document.

**If upstream adds an export**, nothing needs changing here: `src/index.js`
re-exports the namespace wholesale rather than enumerating names.

**If upstream changes its import-module name** (i.e. renames `dmtap_sync_bg.js`),
`src/index.js`'s `WebAssembly.instantiate` import object must be updated to
match. The smoke test fails loudly in that case; it cannot fail silently.
