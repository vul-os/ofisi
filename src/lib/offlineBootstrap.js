/**
 * offlineBootstrap.js — wires up the offline-first shell (OFFICE-OFFLINE-01).
 *
 * Two responsibilities, run once at app entry:
 *   1. Register the service worker (public/sw.js) that caches the app shell so
 *      the suite loads with the internet — and even the box's cloud route —
 *      down. Imported from every entry (main.jsx + src/entries/*).
 *   2. Prime the cloud↔LAN endpoint selection (src/lib/endpoints.js) so the
 *      first API call already has a reachable endpoint chosen.
 *
 * Idempotent: safe to import from multiple entry points.
 */

import { selectEndpoint } from './endpoints.js'

let _booted = false

export function bootstrapOffline() {
  if (_booted) return
  _booted = true

  // Register the service worker for app-shell caching.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW registration failure is non-fatal; the app still runs online. */
      })
    }
    if (typeof window !== 'undefined' && document.readyState === 'complete') {
      register()
    } else if (typeof window !== 'undefined') {
      window.addEventListener('load', register, { once: true })
    }
  }

  // Kick off endpoint health-checking so the cloud/LAN failover decision is
  // ready before the first API request. Failures are swallowed — the API
  // client re-selects on demand.
  selectEndpoint().catch(() => {})
}
