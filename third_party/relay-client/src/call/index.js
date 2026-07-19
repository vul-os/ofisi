/**
 * call/index.js — @vulos/relay-client `./call` subpath barrel.
 *
 * Re-exports the call modules for the P2P/WebRTC mesh path. Consumers
 * import `createCall` (mesh) from this barrel; `joinSignalingSession` is
 * exposed for callers that need a lower-level handle on the fabric-signaling
 * adapter.
 *
 * LiveKit (SFU / large-room) support has been removed. The product uses
 * the P2P mesh path exclusively.
 */

export * from './rtc.js'
export * from './fabricSignaling.js'
