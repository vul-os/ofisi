/**
 * regionPop.js — @vulos/relay-client region-aware PoP/endpoint selection.
 *
 * Phase-0 hook for multi-region relay infrastructure.  The live cell is `eu`;
 * Johannesburg (`jhb`) is the finalized second PoP per the relay infra topology
 * (relay is the one bandwidth-bound cloud job, run close to the user). Each
 * additional region is wired in as a config-only change to REGION_POP_MAP — no
 * code changes required — once its PoP hostname is provisioned.
 *
 * Design contract:
 *   • Additive only — callers that do not pass a region get the exact same
 *     behaviour as before this module existed (selectPop returns undefined or
 *     the supplied defaultPop).
 *   • Zero behaviour change to existing connection paths — this module is a
 *     pure lookup; it does not open connections or mutate state.
 *   • Config-seam: REGION_POP_MAP is a plain object so operators can replace
 *     it at build time or via environment injection without touching this file.
 *
 * Usage:
 *   import { selectPop } from '@vulos/relay-client/regionPop'
 *
 *   // Prefer the session region's PoP; fall back to the configured default.
 *   const pop = selectPop(sessionRegion, currentDefaultPop)
 *   // → 'eu.relay.vulos.app' when sessionRegion === 'eu'
 *   // → currentDefaultPop   when sessionRegion is unknown/undefined
 */

/**
 * Region → PoP hostname map.
 *
 * Each key is a lowercase region code (e.g. 'eu', 'us', 'ap').
 * Each value is the canonical hostname of that region's PoP (no scheme, no
 * trailing slash) — callers prepend 'https://' and append any path they need.
 *
 * @type {Record<string, string>}
 */
export const REGION_POP_MAP = {
  eu: 'eu.relay.vulos.app',
}

/**
 * Select the best PoP hostname for a given session region.
 *
 * When `region` is a known key in REGION_POP_MAP the corresponding PoP is
 * returned.  Otherwise `defaultPop` is returned — which may be undefined when
 * the caller has no configured default, preserving the pre-hook behaviour.
 *
 * @param {string|undefined} [region]     - region code for the peer/session
 *        (e.g. 'eu').  Case-insensitive.  Undefined / falsy → default path.
 * @param {string|undefined} [defaultPop] - PoP to use when no region match is
 *        found.  Defaults to undefined (same-origin / no PoP hint).
 * @returns {string|undefined} PoP hostname, or defaultPop when no match.
 *
 * @example
 * selectPop('eu')                          // → 'eu.relay.vulos.app'
 * selectPop('eu', 'relay.vulos.app')       // → 'eu.relay.vulos.app'
 * selectPop('us', 'relay.vulos.app')       // → 'relay.vulos.app'  (unknown region)
 * selectPop(undefined, 'relay.vulos.app')  // → 'relay.vulos.app'  (no region)
 * selectPop()                              // → undefined           (pure default)
 */
export function selectPop(region, defaultPop) {
  if (region && typeof region === 'string') {
    const pop = REGION_POP_MAP[region.toLowerCase()]
    if (pop) return pop
  }
  return defaultPop
}
