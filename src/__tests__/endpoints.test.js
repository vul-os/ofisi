/**
 * endpoints.test.js — cloud↔LAN failover (OFFICE-OFFLINE-01 / OS OFFLINE-02 contract).
 *
 * Covers the frozen contract:
 *   • both endpoints cached
 *   • reachable chosen automatically
 *   • cloud-down → LAN
 *   • LAN-down → cloud
 *   • prefer LAN-direct when both are reachable (latency)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const CLOUD = 'https://box.vulos.org'
const LAN = 'https://box.abc.lan.vulos.org'

// Each test gets a fresh module instance so internal selection state is reset.
async function freshModule() {
  vi.resetModules()
  return import('../lib/endpoints.js')
}

function setEndpoints({ cloud = CLOUD, lan = LAN } = {}) {
  globalThis.window = globalThis.window || {}
  window.__VULOS_ENDPOINTS__ = { cloud, lan }
}

beforeEach(() => {
  // jsdom provides localStorage; clear it so cached pairs don't leak across tests.
  try { localStorage.clear() } catch { /* ignore */ }
  globalThis.window = globalThis.window || {}
  if (!window.addEventListener) window.addEventListener = () => {}
  globalThis.navigator = globalThis.navigator || {}
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__VULOS_ENDPOINTS__
})

describe('endpoint failover', () => {
  it('caches BOTH cloud + LAN endpoints', async () => {
    setEndpoints()
    const ep = await freshModule()
    const pair = ep.resolveEndpoints()
    expect(pair.cloud).toBe(CLOUD)
    expect(pair.lan).toBe(LAN)
    // Persisted so a later offline load still has both to fail over between.
    const cached = JSON.parse(localStorage.getItem('vulos.office.endpoints.v1'))
    expect(cached.cloud).toBe(CLOUD)
    expect(cached.lan).toBe(LAN)
  })

  it('prefers LAN-direct when both are reachable', async () => {
    setEndpoints()
    const ep = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe(LAN)
  })

  it('falls back to cloud when LAN is down', async () => {
    setEndpoints()
    const ep = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith(LAN)) throw new Error('LAN unreachable')
      return { ok: true, status: 200 }
    }))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe(CLOUD)
  })

  it('falls back to LAN when cloud is down', async () => {
    setEndpoints()
    const ep = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith(CLOUD)) throw new Error('cloud route down')
      return { ok: true, status: 200 }
    }))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe(LAN)
  })

  it('falls back to same-origin when both remote endpoints are down', async () => {
    setEndpoints()
    const ep = await freshModule()
    // navigator.onLine is a read-only getter in jsdom; override it for the probe.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network') }))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe('')
  })

  it('counts a 401/403 as reachable (the box is up)', async () => {
    setEndpoints({ cloud: '', lan: LAN })
    const ep = await freshModule()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })))
    const selected = await ep.selectEndpoint({ force: true })
    expect(selected).toBe(LAN)
  })
})
