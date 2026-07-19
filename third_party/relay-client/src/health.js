/**
 * health.js — @vulos/relay-client health-check export.
 *
 * vulos-relay is a pure JavaScript client SDK — there is no bundled Go
 * signaling/PoP server in this repo.  The health interface is therefore
 * provided as a set of composable helpers that the host backend (Node.js
 * HTTP server, Express, Fastify, Hono, etc.) can wire up as it sees fit.
 *
 * Quick-start (Node.js http module):
 *
 *   import http from 'node:http'
 *   import { createHealthHandler } from '@vulos/relay-client/health'
 *   import { FabricClient } from '@vulos/relay-client/fabric'
 *
 *   const fc = new FabricClient({ ... })
 *   const server = http.createServer(createHealthHandler({
 *     getRelayByteCount: () => fc.relayByteCount,
 *   }))
 *
 * Quick-start (Express):
 *
 *   import { createHealthHandler } from '@vulos/relay-client/health'
 *   app.get('/healthz', createHealthHandler({ getRelayByteCount: () => fc.relayByteCount }))
 *
 * The handler responds with HTTP 200 and a JSON body conforming to the
 * HealthReport shape described below.
 *
 * ── GET /healthz contract ────────────────────────────────────────────────────
 *   Response: 200 OK
 *   Content-Type: application/json
 *   Body: HealthReport (see createHealthReport JSDoc)
 *
 * ── Relay byte meter contract (billing G-1) ──────────────────────────────────
 *   The relay byte meter lives on FabricClient (fabric.js).  The host backend
 *   reads it at the end of each session (or on a periodic flush interval) and
 *   reports usage to CP via the usage-report endpoint.
 *
 *   Fields reported:
 *     relay.out   — bytes deposited (sent) via the relay fallback path
 *     relay.in    — bytes picked up (received) via the relay fallback path
 *     relay.total — out + in (the value CP debits against the relay allowance)
 *
 *   "Bytes" here means application-payload bytes (the data argument to send /
 *   sendTo), NOT HTTP framing or base64 expansion.  See FabricClient.relayByteCount
 *   and FabricClient.resetRelayByteCount() for the full API.
 *
 *   Recommended flush pattern:
 *     const count = fc.relayByteCount          // snapshot
 *     fc.resetRelayByteCount()                  // reset before reporting so
 *     await reportUsageToCP(count)              // the next window starts clean
 */

/** Package version — must match package.json "version" field. */
export const RELAY_CLIENT_VERSION = '1.0.0'

/**
 * Build a health report object.
 *
 * @param {object} [opts]
 * @param {(() => { out: number, in: number, total: number }) | null} [opts.getRelayByteCount]
 *   Optional callback returning the current FabricClient.relayByteCount snapshot.
 *   When omitted the `relay` field is `null` in the report.
 * @returns {HealthReport}
 *
 * @typedef {object} HealthReport
 * @property {'ok'} status         - always 'ok' (unhealthy deployments should not serve 200)
 * @property {string} version      - semver version of @vulos/relay-client
 * @property {string} component    - fixed string '@vulos/relay-client'
 * @property {string} ts           - ISO-8601 timestamp of report generation
 * @property {{ out: number, in: number, total: number } | null} relay
 *   Current relay byte meter snapshot, or null when not wired up.
 */
export function createHealthReport(opts = {}) {
  const relay = typeof opts.getRelayByteCount === 'function'
    ? opts.getRelayByteCount()
    : null
  return {
    status: 'ok',
    version: RELAY_CLIENT_VERSION,
    component: '@vulos/relay-client',
    ts: new Date().toISOString(),
    relay,
  }
}

/**
 * Create a Node.js `(req, res) => void` handler for `GET /healthz`.
 *
 * Compatible with the Node.js built-in `http` module, Express, Fastify
 * (via .nodejs adapter), Hono (Node adapter), and any framework that accepts
 * the Node.js `IncomingMessage` / `ServerResponse` interface.
 *
 * @param {object} [opts]  — same options as createHealthReport
 * @returns {(req: object, res: object) => void}
 */
export function createHealthHandler(opts = {}) {
  return (_req, res) => {
    const report = createHealthReport(opts)
    const body = JSON.stringify(report)
    // Support both Node.js http.ServerResponse and Express-style res objects.
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength
          ? String(Buffer.byteLength(body, 'utf8'))
          : String(body.length),
        'Cache-Control': 'no-store',
      })
      res.end(body)
    } else if (typeof res.status === 'function') {
      // Express-style (res.status().json())
      res.status(200).set('Content-Type', 'application/json').send(body)
    }
  }
}
