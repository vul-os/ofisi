/**
 * transportSelection.test.js — the three-way collab transport decision.
 *
 * Pure logic test: probeHostPeering/resolveRendezvousFacts are injected fakes,
 * so this never touches fetch, the DOM, or the real relay-client SDK. Covers the
 * priority order (host-box peering wins over rendezvous, which wins over
 * local-only) and that a throwing probe degrades to "unavailable" rather than
 * escaping the selector.
 *
 * The rendezvous case pins the CORS-forced shape: the browser is pointed at OUR
 * origin + the proxy prefix, and the configured relayd is carried separately as
 * `rendezvousUpstreamUrl` (reporting only). A direct cross-origin call to the
 * relayd is not a thing the browser can do — see rendezvous_proxy.go.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  selectCollabTransport,
  TRANSPORT_HOST_PEERING,
  TRANSPORT_RENDEZVOUS,
  TRANSPORT_LOCAL_ONLY,
} from '../transportSelection.js'

const RDV_FACTS = { url: 'https://relay.example.org', proxyPath: '/api/rendezvous' }
/** The shape every non-rendezvous outcome must have: no rendezvous facts at all. */
const NO_RENDEZVOUS = (transport) => ({
  transport, rendezvousBaseUrl: '', rendezvousPrefix: '', rendezvousUpstreamUrl: '',
})

describe('selectCollabTransport', () => {
  it('prefers host-box peering when it is reachable, regardless of rendezvous config', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(true)
    const resolveRendezvousFacts = vi.fn().mockResolvedValue(RDV_FACTS)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvousFacts })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_HOST_PEERING))
    // Short-circuits: never even asks about rendezvous when the host wins.
    expect(resolveRendezvousFacts).not.toHaveBeenCalled()
  })

  it('falls back to rendezvous when host-box peering is unreachable but a rendezvous URL is configured', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvousFacts = vi.fn().mockResolvedValue(RDV_FACTS)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvousFacts })

    expect(choice).toEqual({
      transport: TRANSPORT_RENDEZVOUS,
      // Our own origin — the relayd is reached THROUGH this server, because
      // relayd's rendezvous surface serves no CORS headers.
      rendezvousBaseUrl: window.location.origin,
      rendezvousPrefix: '/api/rendezvous',
      rendezvousUpstreamUrl: 'https://relay.example.org',
    })
  })

  it('falls back to local-only when neither host-box peering nor a rendezvous URL is available', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvousFacts = vi.fn().mockResolvedValue({ url: '', proxyPath: '' })

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvousFacts })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('treats a throwing host-peering probe as unavailable rather than rejecting', async () => {
    const probeHostPeering = vi.fn().mockRejectedValue(new Error('network error'))
    const resolveRendezvousFacts = vi.fn().mockResolvedValue(RDV_FACTS)

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvousFacts })

    expect(choice.transport).toBe(TRANSPORT_RENDEZVOUS)
  })

  it('treats a throwing rendezvous resolver as unconfigured rather than rejecting', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvousFacts = vi.fn().mockRejectedValue(new Error('network error'))

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvousFacts })

    expect(choice).toEqual(NO_RENDEZVOUS(TRANSPORT_LOCAL_ONLY))
  })

  it('falls back to the constant proxy prefix when an older server reports no rendezvous_proxy_path', async () => {
    // Forward-compat: a server that has the rendezvous URL but predates the
    // proxy still gets a same-origin base rather than a cross-origin call the
    // browser would refuse outright.
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvousFacts = vi.fn().mockResolvedValue({ url: 'https://relay.example.org', proxyPath: '' })

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvousFacts })

    expect(choice.transport).toBe(TRANSPORT_RENDEZVOUS)
    expect(choice.rendezvousBaseUrl).toBe(window.location.origin)
    expect(choice.rendezvousPrefix).toBe('/api/rendezvous')
  })

  it('uses the real probePeeringAvailable/resolveRendezvous by default', async () => {
    // No fetch stub at all: probePeeringAvailable requires `fetch` to exist —
    // jsdom provides one, but with nothing stubbed the request rejects/errors,
    // which both real probes already treat as "unavailable". This just pins
    // that the exported defaults are wired (no crash without injected fakes).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const choice = await selectCollabTransport()
    expect(choice.transport).toBe(TRANSPORT_LOCAL_ONLY)
    vi.unstubAllGlobals()
  })
})
