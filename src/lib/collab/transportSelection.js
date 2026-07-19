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
 *      VULOS_RENDEZVOUS_URL, see backend/config/config.go). The browser talks
 *      DIRECTLY to that relayd's open announce/resolve/signal/mailbox + ICE
 *      surface — no Vulos OS, no host box, just a self-hosted relayd. THE
 *      PAYOFF: this is what makes standalone Ofisi capable of real P2P.
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
import { resolveRendezvousUrl } from './reachableBase.js'

export const TRANSPORT_HOST_PEERING = 'host-peering'
export const TRANSPORT_RENDEZVOUS = 'rendezvous'
export const TRANSPORT_LOCAL_ONLY = 'local-only'

/**
 * @typedef {object} TransportChoice
 * @property {'host-peering'|'rendezvous'|'local-only'} transport
 * @property {string} rendezvousBaseUrl  non-empty only when transport is 'rendezvous'
 */

/**
 * Decide which collaboration transport this session should use. Never throws:
 * every probe it depends on already fails safe to "unavailable" and this
 * function itself always resolves to one of the three transports.
 *
 * @param {object} [opts]
 * @param {() => Promise<boolean>} [opts.probeHostPeering] override for tests
 * @param {() => Promise<string>}  [opts.resolveRendezvous] override for tests
 * @returns {Promise<TransportChoice>}
 */
export async function selectCollabTransport({
  probeHostPeering = probePeeringAvailable,
  resolveRendezvous = resolveRendezvousUrl,
} = {}) {
  let hostAvailable = false
  try {
    hostAvailable = !!(await probeHostPeering())
  } catch {
    hostAvailable = false // fail safe — never let a probe throw escape here
  }
  if (hostAvailable) {
    return { transport: TRANSPORT_HOST_PEERING, rendezvousBaseUrl: '' }
  }

  let rendezvousBaseUrl = ''
  try {
    rendezvousBaseUrl = (await resolveRendezvous()) || ''
  } catch {
    rendezvousBaseUrl = ''
  }
  if (rendezvousBaseUrl) {
    return { transport: TRANSPORT_RENDEZVOUS, rendezvousBaseUrl }
  }

  return { transport: TRANSPORT_LOCAL_ONLY, rendezvousBaseUrl: '' }
}
