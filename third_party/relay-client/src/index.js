/**
 * src/index.js — @vulos/relay-client root barrel.
 *
 * Re-exports every subpath so consumers can choose between:
 *
 *   import { selectEndpoint } from '@vulos/relay-client'
 *   import { selectEndpoint } from '@vulos/relay-client/endpoints'   // tree-shake
 *
 * Subpaths are also published individually via the `exports` map in
 * package.json so a consumer that only needs one module (e.g. mail just wants
 * `./endpoints` + `./offlineBootstrap`) doesn't pay the cost of the rest.
 *
 * NOTE: `roundTripCheck` (which imports `xlsx`) is intentionally NOT re-exported
 * here. It is available as a dedicated subpath:
 *
 *   import { runRoundTripChecks } from '@vulos/relay-client/roundTripCheck'
 *
 * This prevents xlsx from being pulled into the bundle of consumers that only
 * import from the root barrel.
 */

export * from './errors.js'
export * from './endpoints.js'
export * from './health.js'
export * from './offlineBootstrap.js'
export * from './signaling.js'
export * from './fabric.js'
export * from './rendezvous.js'
export * from './rendezvousSignaling.js'
export * from './prekeys.js'
export * from './presence.js'
export * from './call/index.js'
export * from './useLiveCursors.js'
export * from './regionPop.js'
