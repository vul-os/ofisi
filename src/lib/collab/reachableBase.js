/**
 * reachableBase.js — resolve Office's EXTERNALLY-REACHABLE base URL for P2P
 * collab invite links (two-class app model, NAT-reachability client wiring).
 *
 * P2P collab rendezvous is same-origin: a peer joins by opening an invite link
 * that points back at the host box's Office. When the OWNER loaded Office over a
 * LAN-only / private address (e.g. http://192.168.1.20:8080 or a `.local` host)
 * and then invites an EXTERNAL peer, an invite link built from
 * `window.location.origin` would embed that unreachable private address — the
 * external peer can never connect.
 *
 * The box's operator surfaces the real public origin (a public domain, or a
 * vulos-relay tunnel URL when the box is behind NAT/CGNAT) via the backend env
 * VULOS_OFFICE_PUBLIC_URL, exposed at the unauthenticated `GET /api/reachability`
 * endpoint (see backend/handlers/system.go). This module fetches it ONCE and
 * caches it (reachability is a deploy-time fact, not a per-session one), so
 * invite-link generation targets a base an external peer can actually reach.
 *
 * When VULOS_OFFICE_PUBLIC_URL is unset (a directly-reachable standalone box, or
 * the cloud deployment where the origin IS public) the resolved base is empty
 * and callers fall back to `window.location.origin` — byte-identical to today.
 */

const REACHABILITY_URL = '/api/reachability'
const PROBE_TIMEOUT_MS = 2500

/** @type {Promise<string> | null} cached single-flight resolution */
let cached = null
/** @type {string} last synchronously-available resolved base ('' until first resolve) */
let resolvedSync = ''

function windowOrigin() {
  return typeof window !== 'undefined' && window.location ? window.location.origin : ''
}

/**
 * Synchronous best-effort reachable base for render paths that cannot await:
 * returns the last resolved public base if `resolveReachableBase()` has already
 * completed, otherwise `window.location.origin`. Warm it by calling
 * `resolveReachableBase()` (e.g. in an effect) before relying on this.
 * @returns {string}
 */
export function reachableBaseSync() {
  return resolvedSync || windowOrigin()
}

/**
 * Resolve Office's externally-reachable base origin (no trailing slash).
 *
 * Never throws: on any network error, non-2xx, timeout, or a blank
 * public_base_url it resolves to `window.location.origin` (the current, already
 * reachable-for-this-visitor origin). Cached for the page lifetime.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] bypass the cache and re-resolve
 * @returns {Promise<string>}
 */
export function resolveReachableBase({ force = false } = {}) {
  if (!force && cached) return cached
  if (typeof fetch !== 'function') return Promise.resolve(windowOrigin())

  cached = (async () => {
    const fallback = windowOrigin()
    try {
      const hasAbort = typeof AbortController !== 'undefined'
      const ctrl = hasAbort ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null
      try {
        const res = await fetch(REACHABILITY_URL, { method: 'GET', signal: ctrl?.signal })
        if (!res?.ok) { resolvedSync = fallback; return fallback }
        const body = await res.json()
        const pub = body && typeof body.public_base_url === 'string' ? body.public_base_url.trim() : ''
        const base = pub ? pub.replace(/\/+$/, '') : fallback
        resolvedSync = base
        return base
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch {
      resolvedSync = fallback
      return fallback
    }
  })()
  return cached
}

/**
 * Test-only: clear the cached resolution so a fresh fetch runs.
 */
export function _resetReachableBaseCache() {
  cached = null
  resolvedSync = ''
}
