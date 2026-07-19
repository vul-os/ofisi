// ice.js — shared ICE-server fetch helper.
//
// Both the OS fabric path (/api/peering/ice → body.ice_servers) and
// the call/TURN path (/api/turn/credentials → body.iceServers) implement
// the same fetch-with-fallback pattern. This helper centralises it so the
// fallback behaviour is defined once.
//
// Privacy / standalone posture (audit LOW — third-party reach-out):
//   By default the helper reaches out to NO third party. When the host's ICE
//   endpoint is unreachable or returns nothing, the fallback is an EMPTY list
//   ([]) — i.e. host-provided ICE only. A standalone / self-hosted build never
//   contacts a public STUN server unless the operator explicitly opts in.
//
//   The well-known Google public STUN server is still available, but it is now
//   opt-in via either:
//     • window.__VULOS_ENDPOINTS__.googleStunFallback === true   (runtime), or
//       window.__VULOS_ENDPOINTS__.iceServersFallback = [...]    (custom list)
//     • VITE_ICE_GOOGLE_STUN_FALLBACK = 'true' | '1'             (build-time)
//   Callers may also pass an explicit `fallbackIceServers` array to fetchIce().
//
// Usage:
//   const servers = await fetchIce('/api/turn/credentials', {
//     responseKey: 'iceServers',        // key inside the JSON response body
//     fetchOptions: { credentials: 'include' },
//     fallbackIceServers: resolveStunFallback(),
//   })

/**
 * The classic Google public STUN server. Exported so callers can opt into it
 * explicitly; it is NOT used as a default fallback any more.
 */
export const GOOGLE_STUN_FALLBACK = [{ urls: ['stun:stun.l.google.com:19302'] }]

function _readEnv(name) {
  try {
    return (import.meta && import.meta.env && import.meta.env[name]) || ''
  } catch {
    return ''
  }
}

/**
 * Resolve the third-party ICE fallback to use when the host endpoint yields
 * nothing. Defaults to an empty list (host-provided ICE only — no third-party
 * reach-out). Operators opt in via host injection or a build-time env var.
 *
 * @returns {Array} ICE server objects to fall back to (may be empty)
 */
export function resolveStunFallback() {
  try {
    const inj = typeof window !== 'undefined' ? window.__VULOS_ENDPOINTS__ : null
    if (inj && Array.isArray(inj.iceServersFallback)) return inj.iceServersFallback
    if (inj && inj.googleStunFallback === true) return GOOGLE_STUN_FALLBACK
  } catch { /* non-browser / no injection */ }

  const env = _readEnv('VITE_ICE_GOOGLE_STUN_FALLBACK')
  if (env === 'true' || env === '1') return GOOGLE_STUN_FALLBACK

  return []
}

/**
 * Fetch ICE servers from a relay/TURN endpoint.
 *
 * @param {string} endpoint      - URL path to GET (e.g. '/api/turn/credentials')
 * @param {object} [opts]
 * @param {string} [opts.responseKey='iceServers']  - key in the JSON body that holds the array
 * @param {object} [opts.fetchOptions={}]           - extra options forwarded to fetch()
 * @param {Array}  [opts.fallbackIceServers=[]]     - servers to return on any
 *        fetch error, non-ok response, or empty array. Defaults to [] so a
 *        standalone build never reaches out to a third party.
 * @returns {Promise<Array>}     - ICE server objects (may be empty)
 */
export async function fetchIce(
  endpoint,
  { responseKey = 'iceServers', fetchOptions = {}, fallbackIceServers = [] } = {},
) {
  try {
    const r = await fetch(endpoint, fetchOptions)
    if (r.ok) {
      const body = await r.json()
      const servers = body[responseKey]
      if (Array.isArray(servers) && servers.length) return servers
    }
  } catch { /* ignore — fall through to the configured fallback */ }
  return Array.isArray(fallbackIceServers) ? fallbackIceServers : []
}
