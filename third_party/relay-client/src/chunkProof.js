// chunkProof.js — the BROWSER half of the DMTAP-PUB § 5.3 chunk-tree range proof.
//
// This is the module that makes verified partial fetch mean anything on the web.
// The Go side (tunnel/pubcache/proof.go) can already serve an audit path and
// verify one server-to-server; without a counterpart here, a browser reading a
// large object has no choice but to TRUST THE GATEWAY that handed it the bytes —
// which is precisely the property the content-addressed design exists to remove.
//
// What it buys, concretely: a video player seeking into the middle of a
// multi-gigabyte blob, or any client resuming a large download, fetches chunk i
// plus an O(log n) path and proves the chunk belongs to the manifest root it
// ALREADY TRUSTS from the signed PubAnnounce — without ever downloading the
// manifest's chunk list (thousands of hashes for a large blob), and without
// trusting whoever served the chunk. A lying holder cannot forge a path to a
// root it does not control absent a BLAKE3 collision; the worst it can do is
// fail to serve, and the caller rotates to another holder.
//
// EXACT PARITY WITH THE GO IMPLEMENTATION is the whole point, so the § 3.2
// construction is reproduced here term by term:
//
//   • leaves are DS-tagged:  BLAKE3-256( DS ‖ 0x00 ‖ h_i )  where DS is
//     "DMTAP-PUB-v0/manifest" ‖ 0x00, and h_i is the chunk's 33-byte ADDRESS
//     (0x1e ‖ BLAKE3-256(bytes)), NOT the chunk bytes;
//   • interior nodes are     BLAKE3-256( DS ‖ 0x01 ‖ left ‖ right ), bare
//     32-byte values with no multihash prefix (the prefix belongs to the root
//     when it becomes PubManifest.id, and to the leaves' inputs — never to an
//     interior node);
//   • the path is BOTTOM-UP, and a level at which the node is the promoted
//     unpaired last one contributes NO element. That promotion rule is why the
//     verifier needs nChunks: whether a node has a sibling at a given level is
//     a fact about the tree's WIDTH, not about the node.
//
// A fixed 5-chunk interop vector (root + every path, byte for byte) is asserted
// in BOTH suites — client/src/__tests__/chunkProof.test.js and
// tunnel/pubcache/interop_test.go — so a one-byte divergence between the two
// implementations fails one side. If you intentionally change the construction,
// regenerate both constants together.
//
// BLAKE3 comes from @noble/hashes (audited, already a dependency of the
// rendezvous client). Its output is asserted equal to the Go zeebo/blake3 output
// on known-answer tests in both suites.

import { blake3 } from '@noble/hashes/blake3.js'

// ── constants, mirroring tunnel/pubcache ─────────────────────────────────────

/** The § 18.1.5 multihash-style prefix for the v0 suite; the only one accepted. */
export const HASH_PREFIX_BLAKE3_256 = 0x1e

const DIGEST_LEN = 32
const ADDR_LEN = 1 + DIGEST_LEN

/**
 * maxProofPath bounds a decoded path. A 32-level tree is 2^32 chunks — at the
 * § 16.4 reference 1 MiB chunk that is 4 PiB — so this cannot bind a real blob
 * while still refusing an attacker-chosen unbounded array.
 */
const MAX_PROOF_PATH = 40

/** The § 22.2.2 domain-separation tag: "DMTAP-PUB-v0/manifest" ‖ 0x00. */
const DS_MANIFEST = Uint8Array.from([
  ...new TextEncoder().encode('DMTAP-PUB-v0/manifest'), 0x00,
])

const CBOR_MAJOR_UINT = 0
const CBOR_MAJOR_BYTESTR = 2
const CBOR_MAJOR_ARRAY = 4

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a chunk is NOT proven, for any reason: a malformed proof body, an
 * out-of-range index, tampered bytes, a tampered or mis-sized path, or a fold
 * that does not reproduce the trusted root.
 *
 * There is deliberately ONE error type for all of these. A caller must treat
 * every one of them identically — discard the chunk and rotate to another
 * holder — so distinguishing them in control flow would only invite a caller to
 * decide some failures are tolerable.
 *
 * `code` is for diagnostics: MALFORMED_PROOF | PROOF_RANGE | PROOF_INVALID.
 */
export class ChunkProofError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string }} [detail]
   */
  constructor(message, detail = {}) {
    super(message)
    this.name = 'ChunkProofError'
    /** @type {string} */
    this.code = detail.code || 'PROOF_INVALID'
  }
}

const malformed = (m) => new ChunkProofError(`chunkProof: ${m}`, { code: 'MALFORMED_PROOF' })
const rangeErr = (m) => new ChunkProofError(`chunkProof: ${m}`, { code: 'PROOF_RANGE' })
const invalid = (m) => new ChunkProofError(`chunkProof: ${m}`, { code: 'PROOF_INVALID' })

// ── addressing ───────────────────────────────────────────────────────────────

/** Encode bytes to unpadded base64url — the § 22.5.1 path form for an address. */
export function encodeAddr(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Parse the `{id}` / `{h}` path component of a § 22.5.1 read into a 33-byte
 * address.
 *
 * Strict on purpose, matching ParseAddr in Go: unpadded base64url only, exactly
 * 33 bytes, prefix 0x1e only, and re-encoding must reproduce the input — a
 * lenient parser would let two spellings of one address both verify.
 *
 * @param {string} s
 * @returns {Uint8Array} the 33-byte address
 */
export function parseAddr(s) {
  if (typeof s !== 'string' || s === '' || s.length > 64) throw malformed('malformed content address')
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw malformed('malformed content address: not base64url')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  let bin
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  } catch {
    throw malformed('malformed content address: not base64url')
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  if (out.length !== ADDR_LEN) throw malformed(`malformed content address: got ${out.length} bytes, want ${ADDR_LEN}`)
  if (out[0] !== HASH_PREFIX_BLAKE3_256) {
    throw malformed(`malformed content address: unsupported hash prefix 0x${out[0].toString(16)}`)
  }
  if (encodeAddr(out) !== s) throw malformed('malformed content address: non-canonical encoding')
  return out
}

/** Coerce an address given as base64url or raw 33 bytes into raw 33 bytes. */
function toAddr(a) {
  if (typeof a === 'string') return parseAddr(a)
  const b = a instanceof Uint8Array ? a : new Uint8Array(a || [])
  if (b.length !== ADDR_LEN) throw malformed(`address must be ${ADDR_LEN} bytes, got ${b.length}`)
  if (b[0] !== HASH_PREFIX_BLAKE3_256) {
    throw malformed(`address has unsupported hash prefix 0x${b[0].toString(16)}`)
  }
  return b
}

/**
 * The v0 content address of a byte string: `0x1e ‖ BLAKE3-256(b)` (§ 18.9.4
 * generic anchor rule — what addresses a plaintext chunk, § 22.2.2 step 1).
 *
 * @param {Uint8Array} b
 * @returns {Uint8Array} 33-byte address
 */
export function hashBytes(b) {
  const out = new Uint8Array(ADDR_LEN)
  out[0] = HASH_PREFIX_BLAKE3_256
  out.set(blake3(b instanceof Uint8Array ? b : new Uint8Array(b)), 1)
  return out
}

// ── the tree (§ 3.2 / § 22.2.2) ──────────────────────────────────────────────

/** merkleLeaf = BLAKE3-256( DS ‖ 0x00 ‖ h_i ), over the FULL 33-byte address. */
function merkleLeaf(addr) {
  const buf = new Uint8Array(DS_MANIFEST.length + 1 + ADDR_LEN)
  buf.set(DS_MANIFEST, 0)
  buf[DS_MANIFEST.length] = 0x00
  buf.set(addr, DS_MANIFEST.length + 1)
  return blake3(buf)
}

/** merkleNode = BLAKE3-256( DS ‖ 0x01 ‖ left ‖ right ). */
function merkleNode(left, right) {
  const buf = new Uint8Array(DS_MANIFEST.length + 1 + DIGEST_LEN * 2)
  buf.set(DS_MANIFEST, 0)
  buf[DS_MANIFEST.length] = 0x01
  buf.set(left, DS_MANIFEST.length + 1)
  buf.set(right, DS_MANIFEST.length + 1 + DIGEST_LEN)
  return blake3(buf)
}

/**
 * Combine one level of the chunk tree into the next: pair nodes left to right,
 * and promote a level's unpaired final node UNCHANGED (not re-hashed).
 */
function reduceLevel(level) {
  const next = []
  let i = 0
  for (; i + 1 < level.length; i += 2) next.push(merkleNode(level[i], level[i + 1]))
  if (i < level.length) next.push(level[i]) // promoted, not re-hashed
  return next
}

/**
 * The public content address of a manifest with the given ordered plaintext
 * chunk addresses: `0x1e ‖ MTH(h_0 … h_{n-1})` (§ 22.2.2). Mirrors ManifestRoot
 * in Go.
 *
 * A browser generally does NOT need this — it takes the root from the signed
 * announce — but it is what lets a caller (or a test) confirm a chunk list it
 * already holds roots where it claims to.
 *
 * @param {Array<Uint8Array|string>} chunks ordered 33-byte chunk addresses
 * @returns {Uint8Array} the 33-byte manifest root address
 */
export function manifestRoot(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw malformed('empty chunk list')
  let level = chunks.map((c) => merkleLeaf(toAddr(c)))
  while (level.length > 1) level = reduceLevel(level)
  const out = new Uint8Array(ADDR_LEN)
  out[0] = HASH_PREFIX_BLAKE3_256
  out.set(level[0], 1)
  return out
}

/**
 * The RFC 6962 audit path for leaf `index`: the sibling hashes from that leaf to
 * the root, ordered BOTTOM-UP, as bare 32-byte tree nodes. Mirrors ChunkProof in
 * Go.
 *
 * Serving proofs is a node's job, not a browser's, so this exists mainly for
 * symmetry and for tests — but it is also what lets a client that DOES hold a
 * chunk list hand a compact proof to a peer over the fabric.
 *
 * @param {Array<Uint8Array|string>} chunks
 * @param {number} index
 * @returns {Uint8Array[]} sibling hashes, bottom-up
 */
export function chunkProof(chunks, index) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw rangeErr('empty chunk list')
  if (!Number.isInteger(index) || index < 0 || index >= chunks.length) {
    throw rangeErr(`chunk ${index} of ${chunks.length}`)
  }
  let level = chunks.map((c) => merkleLeaf(toAddr(c)))
  const path = []
  let cur = index
  while (level.length > 1) {
    const sib = cur ^ 1
    if (sib < level.length) path.push(level[sib])
    cur = Math.floor(cur / 2)
    level = reduceLevel(level)
  }
  return path
}

// ── the § 5.3 wire encoding ──────────────────────────────────────────────────

/**
 * Decode one CBOR head, returning [major, arg, bytesConsumed].
 *
 * Strict, matching readHead in Go: non-minimal integer encodings, reserved
 * additional-information values, and indefinite lengths are all REJECTED — a
 * proof that two byte strings could both mean is not a proof.
 */
function readHead(b, off) {
  if (off >= b.length) throw malformed('truncated cbor')
  const major = b[off] >> 5
  const ai = b[off] & 0x1f
  if (ai < 24) return [major, ai, 1]
  if (ai === 24) {
    if (off + 2 > b.length) throw malformed('truncated cbor head')
    if (b[off + 1] < 24) throw malformed('non-minimal cbor integer')
    return [major, b[off + 1], 2]
  }
  if (ai === 25) {
    if (off + 3 > b.length) throw malformed('truncated cbor head')
    const v = (b[off + 1] << 8) | b[off + 2]
    if (v <= 0xff) throw malformed('non-minimal cbor integer')
    return [major, v, 3]
  }
  if (ai === 26) {
    if (off + 5 > b.length) throw malformed('truncated cbor head')
    const v = ((b[off + 1] << 24) >>> 0) + (b[off + 2] << 16) + (b[off + 3] << 8) + b[off + 4]
    if (v <= 0xffff) throw malformed('non-minimal cbor integer')
    return [major, v, 5]
  }
  if (ai === 27) {
    if (off + 9 > b.length) throw malformed('truncated cbor head')
    let v = 0n
    for (let i = 1; i <= 8; i++) v = (v << 8n) | BigInt(b[off + i])
    if (v <= 0xffffffffn) throw malformed('non-minimal cbor integer')
    // Anything needing 64 bits is far beyond every bound this module enforces;
    // return it as a Number so the callers' range checks reject it uniformly.
    return [major, Number(v), 9]
  }
  throw malformed('reserved or indefinite-length cbor item')
}

/**
 * Parse a § 5.3 response body — the canonical CBOR array
 * `[chunk_index, [sibling_hashes…]]` — into its index and path.
 *
 * The strict counterpart of the Go encoder: non-minimal integers, indefinite
 * lengths, wrong-width hashes, over-long paths, and trailing bytes are all
 * rejected. Mirrors DecodeChunkProof in Go.
 *
 * @param {Uint8Array|ArrayBuffer} body
 * @returns {{ index: number, path: Uint8Array[] }}
 */
export function decodeChunkProof(body) {
  const b = body instanceof Uint8Array ? body : new Uint8Array(body)
  let [major, arg, n] = readHead(b, 0)
  if (major !== CBOR_MAJOR_ARRAY || arg !== 2) throw malformed('proof is not a 2-element cbor array')
  let off = n

  let idx
  ;[major, idx, n] = readHead(b, off)
  if (major !== CBOR_MAJOR_UINT) throw malformed('proof index is not an unsigned integer')
  if (idx > 1 << 20) throw malformed('proof index out of bounds')
  off += n

  let count
  ;[major, count, n] = readHead(b, off)
  if (major !== CBOR_MAJOR_ARRAY) throw malformed('proof path is not a cbor array')
  if (count > MAX_PROOF_PATH) {
    throw malformed(`proof path of ${count} exceeds the ${MAX_PROOF_PATH}-level bound`)
  }
  off += n

  const path = []
  for (let i = 0; i < count; i++) {
    let eLen
    ;[major, eLen, n] = readHead(b, off)
    if (major !== CBOR_MAJOR_BYTESTR || eLen !== DIGEST_LEN) {
      throw malformed(`proof element is not a ${DIGEST_LEN}-byte hash`)
    }
    off += n
    if (b.length - off < eLen) throw malformed('truncated proof path')
    path.push(b.slice(off, off + eLen))
    off += eLen
  }
  if (off !== b.length) throw malformed(`${b.length - off} trailing bytes after proof`)
  return { index: idx, path }
}

/**
 * Render a § 5.3 response body: the canonically-encoded CBOR array
 * `[chunk_index, [sibling hashes…]]`. Mirrors EncodeChunkProof in Go.
 *
 * Deterministic per § 18.1.2 — minimal-length heads, definite lengths, no tags —
 * so the body is a pure function of (id, i).
 *
 * @param {number} index
 * @param {Uint8Array[]} path
 * @returns {Uint8Array}
 */
export function encodeChunkProof(index, path) {
  const out = []
  out.push(0x82) // array(2)
  pushHead(out, CBOR_MAJOR_UINT, index)
  pushHead(out, CBOR_MAJOR_ARRAY, path.length)
  for (const h of path) {
    pushHead(out, CBOR_MAJOR_BYTESTR, h.length)
    for (let i = 0; i < h.length; i++) out.push(h[i])
  }
  return Uint8Array.from(out)
}

/** Append a minimal-length CBOR head for the given major type. */
function pushHead(out, major, v) {
  const m = major << 5
  if (v < 24) out.push(m | v)
  else if (v <= 0xff) out.push(m | 24, v)
  else if (v <= 0xffff) out.push(m | 25, (v >> 8) & 0xff, v & 0xff)
  else out.push(m | 26, (v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
}

// ── the verifier ─────────────────────────────────────────────────────────────

/**
 * Prove that `chunk` really is chunk `index` of the blob whose manifest root is
 * `root`, using only the audit path — never the manifest's chunk list. Mirrors
 * VerifyChunkProof in Go.
 *
 * THE CALLER MUST SUPPLY `root` AND `nChunks` FROM SOMETHING IT ALREADY TRUSTS —
 * the signed PubAnnounce, and the manifest header it commits to. Taking either
 * from the same response that carried the proof is asking the server to grade
 * its own work, and this function cannot detect that for you.
 *
 * Note honestly what nChunks is and is not: it is STRUCTURAL METADATA that tells
 * the verifier the tree's width (and hence at which levels the promotion rule
 * skips a path element). It is NOT a second authenticator. A wrong nChunks
 * produces a different fold and therefore a rejection, so it cannot be used to
 * smuggle a bad chunk past a correct root — but it must still come from a
 * trusted source, because supplying an attacker's nChunks alongside an
 * attacker's root proves nothing about the real object.
 *
 * Returns normally ONLY if the chunk is proven. Every other outcome — wrong
 * index, tampered bytes, tampered / reordered / truncated / over-long path,
 * wrong root — throws ChunkProofError, and the chunk MUST be discarded (rotate
 * to another holder).
 *
 * @param {object} args
 * @param {Uint8Array|string} args.root trusted 33-byte manifest root (or base64url)
 * @param {number} args.nChunks trusted chunk count from the manifest header
 * @param {number} args.index which chunk `chunk` claims to be
 * @param {Uint8Array} args.chunk the chunk's plaintext bytes as served
 * @param {Uint8Array[]} args.path sibling hashes, bottom-up (from decodeChunkProof)
 * @returns {void}
 */
export function verifyChunkProof({ root, nChunks, index, chunk, path }) {
  const rootAddr = toAddr(root)
  if (!Number.isInteger(nChunks) || nChunks <= 0) throw rangeErr('empty tree')
  if (!Number.isInteger(index) || index < 0 || index >= nChunks) {
    throw rangeErr(`chunk ${index} of ${nChunks}`)
  }
  if (!Array.isArray(path)) throw invalid('proof path is not an array')
  if (path.length > MAX_PROOF_PATH) {
    throw invalid(`path of ${path.length} exceeds the ${MAX_PROOF_PATH}-level bound`)
  }
  for (const s of path) {
    if (!(s instanceof Uint8Array) || s.length !== DIGEST_LEN) {
      throw invalid(`path element is not a ${DIGEST_LEN}-byte hash`)
    }
  }

  // The leaf is taken over the chunk's ADDRESS h_i = 0x1e ‖ BLAKE3-256(bytes),
  // not over the bytes directly (§ 3.2), so tampered bytes change h_i and the
  // fold diverges immediately.
  let node = merkleLeaf(hashBytes(chunk))

  let cur = index
  let levelLen = nChunks
  let used = 0
  while (levelLen > 1) {
    const sib = cur ^ 1
    if (sib < levelLen) {
      if (used >= path.length) throw invalid(`path too short at level ${used}`)
      const s = path[used]
      used++
      // Order is fixed by the node's own index parity, never by anything the
      // server says — a swapped pair is a different node.
      node = cur % 2 === 0 ? merkleNode(node, s) : merkleNode(s, node)
    }
    cur = Math.floor(cur / 2)
    levelLen = Math.floor((levelLen + 1) / 2)
  }
  // A path with anything left over is not the path for this tree; accepting it
  // would let a server pad a proof with unverified material.
  if (used !== path.length) throw invalid(`path has ${path.length - used} unused elements`)

  const got = new Uint8Array(ADDR_LEN)
  got[0] = HASH_PREFIX_BLAKE3_256
  got.set(node, 1)
  for (let i = 0; i < ADDR_LEN; i++) {
    if (got[i] !== rootAddr[i]) {
      throw invalid(`folds to ${encodeAddr(got)}, want root ${encodeAddr(rootAddr)}`)
    }
  }
}

/**
 * Boolean convenience over verifyChunkProof, for call sites that branch rather
 * than catch. It swallows the REASON, never the verdict — false always means
 * "discard this chunk".
 *
 * @param {Parameters<typeof verifyChunkProof>[0]} args
 * @returns {boolean}
 */
export function isChunkProofValid(args) {
  try {
    verifyChunkProof(args)
    return true
  } catch {
    return false
  }
}

/**
 * The one-call browser path: take a § 5.3 proof body exactly as served, the
 * chunk bytes exactly as served, and the trusted (root, nChunks), and return the
 * chunk only if it is proven.
 *
 * The index inside the proof body is cross-checked against `index` — the caller
 * asked for a specific chunk, and a server answering with a valid proof for a
 * DIFFERENT chunk (a valid proof, just not the one requested) must not be
 * mistaken for success. That is the mistake a seeking video player would
 * otherwise make silently.
 *
 * @param {object} args
 * @param {Uint8Array|string} args.root trusted manifest root
 * @param {number} args.nChunks trusted chunk count
 * @param {number} args.index the chunk index that was requested
 * @param {Uint8Array} args.chunk chunk bytes as served
 * @param {Uint8Array|ArrayBuffer} args.proof § 5.3 CBOR proof body as served
 * @returns {Uint8Array} the verified chunk bytes
 */
export function verifyChunkResponse({ root, nChunks, index, chunk, proof }) {
  const { index: proofIndex, path } = decodeChunkProof(proof)
  if (proofIndex !== index) {
    throw invalid(`proof is for chunk ${proofIndex}, requested chunk ${index}`)
  }
  verifyChunkProof({ root, nChunks, index, chunk, path })
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
}
