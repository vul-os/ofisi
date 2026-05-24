/**
 * endpoints.test.js — smoke test that the office-configured @vulos/relay-client
 * endpoints subpath still honours the office localStorage key + health path.
 *
 * The full failover contract (cloud-down → LAN, LAN-down → cloud, prefer LAN,
 * 401-counts-as-reachable, etc.) is owned by the package itself — see
 * vulos-relay/client/src/__tests__/endpoints.test.js. We just verify here that
 * configure({ lsKeyPrefix: 'vulos.office.endpoints.v1' }) is respected so
 * existing user state survives the migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const CLOUD = 'https://box.vulos.org'
const LAN = 'https://box.abc.lan.vulos.org'
const OFFICE_LS_KEY = 'vulos.office.endpoints.v1'

async function freshModule() {
  vi.resetModules()
  const mod = await import('@vulos/relay-client/endpoints')
  mod.configure({ lsKeyPrefix: OFFICE_LS_KEY, healthPath: '/api/auth/status' })
  return mod
}

function setEndpoints({ cloud = CLOUD, lan = LAN } = {}) {
  globalThis.window = globalThis.window || {}
  window.__VULOS_ENDPOINTS__ = { cloud, lan }
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* ignore */ }
  globalThis.window = globalThis.window || {}
  if (!window.addEventListener) window.addEventListener = () => {}
  globalThis.navigator = globalThis.navigator || {}
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__VULOS_ENDPOINTS__
})

describe('relay-client endpoints — office wiring', () => {
  it('persists the cached pair under the office localStorage key', async () => {
    setEndpoints()
    const ep = await freshModule()
    ep.resolveEndpoints()
    const cached = JSON.parse(localStorage.getItem(OFFICE_LS_KEY))
    expect(cached.cloud).toBe(CLOUD)
    expect(cached.lan).toBe(LAN)
  })

  it('prefers LAN-direct when both endpoints are reachable', async () => {
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
})
