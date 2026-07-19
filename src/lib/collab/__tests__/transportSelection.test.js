/**
 * transportSelection.test.js — the three-way collab transport decision.
 *
 * Pure logic test: probeHostPeering/resolveRendezvous are injected fakes, so
 * this never touches fetch, the DOM, or the real relay-client SDK. Covers the
 * priority order (host-box peering wins over rendezvous, which wins over
 * local-only) and that a throwing probe degrades to "unavailable" rather than
 * escaping the selector.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  selectCollabTransport,
  TRANSPORT_HOST_PEERING,
  TRANSPORT_RENDEZVOUS,
  TRANSPORT_LOCAL_ONLY,
} from '../transportSelection.js'

describe('selectCollabTransport', () => {
  it('prefers host-box peering when it is reachable, regardless of rendezvous config', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(true)
    const resolveRendezvous = vi.fn().mockResolvedValue('https://relay.example.org')

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual({ transport: TRANSPORT_HOST_PEERING, rendezvousBaseUrl: '' })
    // Short-circuits: never even asks about rendezvous when the host wins.
    expect(resolveRendezvous).not.toHaveBeenCalled()
  })

  it('falls back to rendezvous when host-box peering is unreachable but a rendezvous URL is configured', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockResolvedValue('https://relay.example.org/')

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual({
      transport: TRANSPORT_RENDEZVOUS,
      rendezvousBaseUrl: 'https://relay.example.org/',
    })
  })

  it('falls back to local-only when neither host-box peering nor a rendezvous URL is available', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockResolvedValue('')

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual({ transport: TRANSPORT_LOCAL_ONLY, rendezvousBaseUrl: '' })
  })

  it('treats a throwing host-peering probe as unavailable rather than rejecting', async () => {
    const probeHostPeering = vi.fn().mockRejectedValue(new Error('network error'))
    const resolveRendezvous = vi.fn().mockResolvedValue('https://relay.example.org')

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice.transport).toBe(TRANSPORT_RENDEZVOUS)
  })

  it('treats a throwing rendezvous resolver as unconfigured rather than rejecting', async () => {
    const probeHostPeering = vi.fn().mockResolvedValue(false)
    const resolveRendezvous = vi.fn().mockRejectedValue(new Error('network error'))

    const choice = await selectCollabTransport({ probeHostPeering, resolveRendezvous })

    expect(choice).toEqual({ transport: TRANSPORT_LOCAL_ONLY, rendezvousBaseUrl: '' })
  })

  it('uses the real probePeeringAvailable/resolveRendezvousUrl by default', async () => {
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
