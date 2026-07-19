/**
 * transportSelection.js — the three-way collaboration transport decision.
 *
 * Every FabricClient construction site in Ofisi (useCollabFabric.js for
 * presence/Sheets/Slides doc-sync, useP2PCollab.js for Docs/Whiteboard invite
 * links) needs the same answer to "how do we reach a peer?", in the same
 * priority order:
 *
 *   1. HOST_PEERING  — this server itself mounts `/api/peering/*` (a Vulos OS
 *      or Vulos Relay host is in front of Ofisi). Preferred when present:
 *      unchanged from Ofisi's original behaviour, and it is the one transport
 *      that can carry an authToken tied to an account session.
 *   2. RENDEZVOUS    — no host-box peering, but this deployment has a
 *      configured rendezvous URL (config.yaml `collab.rendezvous_url` /
 *      VULOS_RENDEZVOUS_URL, see backend/config/config.go): any self-hosted
 *      `vulos-relayd`'s open announce/resolve/signal/mailbox + ICE surface —
 *      no Vulos OS, no account. THE PAYOFF: this is what makes standalone
 *      Ofisi capable of real P2P.
 *
 *      The browser reaches that surface through Ofisi's OWN origin at
 *      `/api/rendezvous/*` (reported as `rendezvous_proxy_path`), not by
 *      calling the relayd's origin directly. That is forced by the relay, not
 *      chosen: relayd's rendezvous service sends no CORS headers and 405s the
 *      preflight, so a direct cross-origin fetch fails in the browser (proven
 *      in e2e-p2p/). The proxy is discovery-only and content-blind — see
 *      backend/handlers/rendezvous_proxy.go and docs/COLLABORATION.md §3.
 *   3. LOCAL_ONLY    — neither is available. The editor keeps working; it
 *      just never opens a transport. Honest "Offline" / disabled affordances,
 *      never a false "Live".
 *
 * Centralising the decision here (rather than duplicating the probe-then-branch
 * logic in every hook) is what keeps the three call sites in agreement and
 * keeps the logic unit-testable without a DOM or a real network.
 *
 * See docs/COLLABORATION.md §3 for the user-facing explanation of all three.
 */

import { probePeeringAvailable } from './peeringAvailability.js'
import { resolveRendezvous } from './reachableBase.js'

export const TRANSPORT_HOST_PEERING = 'host-peering'
export const TRANSPORT_RENDEZVOUS = 'rendezvous'
export const TRANSPORT_LOCAL_ONLY = 'local-only'

/**
 * The same-origin mount the backend proxies to the configured relayd. Must match
 * RendezvousProxyPrefix in backend/handlers/rendezvous_proxy.go. Used only as the
 * fallback when the server does not report `rendezvous_proxy_path` (an older
 * backend); a server that reports one wins.
 */
export const RENDEZVOUS_PROXY_PREFIX = '/api/rendezvous'

/**
 * @typedef {object} TransportChoice
 * @property {'host-peering'|'rendezvous'|'local-only'} transport
 * @property {string} rendezvousBaseUrl  origin the browser actually calls (our
 *   own, because of the relay's CORS posture); '' unless transport is 'rendezvous'
 * @property {string} rendezvousPrefix  path prefix under that origin ('' unless
 *   transport is 'rendezvous')
 * @property {string} rendezvousUpstreamUrl  the operator-configured relayd this
 *   deployment discovers peers through — reporting/honesty only, never fetched
 *   by the browser ('' unless transport is 'rendezvous')
 */

/**
 * Decide which collaboration transport this session should use. Never throws:
 * every probe it depends on already fails safe to "unavailable" and this
 * function itself always resolves to one of the three transports.
 *
 * @param {object} [opts]
 * @param {() => Promise<boolean>} [opts.probeHostPeering] override for tests
 * @param {() => Promise<{url: string, proxyPath: string}>} [opts.resolveRendezvousFacts] override for tests
 * @returns {Promise<TransportChoice>}
 */
export async function selectCollabTransport({
  probeHostPeering = probePeeringAvailable,
  resolveRendezvousFacts = resolveRendezvous,
} = {}) {
  const none = { transport: TRANSPORT_LOCAL_ONLY, rendezvousBaseUrl: '', rendezvousPrefix: '', rendezvousUpstreamUrl: '' }

  let hostAvailable = false
  try {
    hostAvailable = !!(await probeHostPeering())
  } catch {
    hostAvailable = false // fail safe — never let a probe throw escape here
  }
  if (hostAvailable) {
    return { ...none, transport: TRANSPORT_HOST_PEERING }
  }

  let facts = null
  try {
    facts = await resolveRendezvousFacts()
  } catch {
    facts = null
  }
  const upstream = facts && typeof facts.url === 'string' ? facts.url : ''
  if (!upstream) return none

  // The rendezvous protocol is served to the browser on OUR origin (the backend
  // forwards it); a server that predates the proxy reports no proxyPath, and we
  // fall back to the constant rather than calling the relayd cross-origin —
  // which the browser would block anyway.
  const prefix = (facts.proxyPath || RENDEZVOUS_PROXY_PREFIX).replace(/\/+$/, '')
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : ''
  if (!origin) return none

  return {
    transport: TRANSPORT_RENDEZVOUS,
    rendezvousBaseUrl: origin,
    rendezvousPrefix: prefix,
    rendezvousUpstreamUrl: upstream,
  }
}
