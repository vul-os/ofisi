/**
 * importBounds.js — the untrusted-input trust boundary for file IMPORT.
 * ----------------------------------------------------------------------------
 * Every imported document (.docx/.xlsx/.pptx/.odt/.ods/.odp) is UNTRUSTED: a
 * hostile file must not be able to exhaust memory (zip-bomb / oversize), smuggle
 * a path-traversal asset (zip-slip), or drive an XML parser into external-entity
 * fetch / billion-laughs expansion (XXE). This module centralises those controls
 * so every importer shares ONE audited set of caps + safe-unzip + safe-XML.
 *
 * The *content* trust boundary (script/CSS/formula neutralisation) lives in the
 * per-app sanitisers (lib/sanitize.js sanitizeDocHtml, slideObjects
 * sanitizeObjects, sheetsExport csvField). This module is the *structural*
 * boundary that runs FIRST, before a single byte is decompressed or parsed.
 */

import JSZip from 'jszip'

// ── Caps ─────────────────────────────────────────────────────────────────────
// Chosen generously enough for real office documents, tight enough that a bomb
// is refused long before it can hurt. All are enforced fail-closed (over cap ⇒
// throw ImportError, never a partial/truncated silent import).
export const MAX_FILE_BYTES = 60 * 1024 * 1024        // 60 MB compressed input
export const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024 // 300 MB decompressed (zip-bomb)
export const MAX_ZIP_ENTRIES = 5000                    // entry-count bound
export const MAX_SINGLE_ENTRY = 100 * 1024 * 1024      // 100 MB any one entry

// Sheets-specific caps (a .xlsx/.ods can declare an enormous sparse range).
export const MAX_SHEETS = 200
export const MAX_CELLS_PER_SHEET = 500_000             // ~ 500 cols × 1000 rows dense
export const MAX_ROWS = 200_000
export const MAX_COLS = 16_384

// Docs/slides content caps.
export const MAX_SLIDES = 1000
export const MAX_HTML_BYTES = 20 * 1024 * 1024         // parsed doc/odt HTML size

export class ImportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ImportError'
  }
}

/** Reject an oversize input before we even read it into memory. */
export function assertFileSize(byteLength, filename = 'file') {
  if (typeof byteLength === 'number' && byteLength > MAX_FILE_BYTES) {
    throw new ImportError(
      `${filename} is too large (${Math.round(byteLength / 1048576)} MB). ` +
      `The import limit is ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`
    )
  }
}

// A zip entry name is hostile if it escapes the archive root (zip-slip). We
// never write extracted bytes to the filesystem — everything stays in memory —
// but a `..`/absolute/backslash path is still a red flag and could be misused by
// any downstream that keys on the name, so we refuse the whole archive.
function isUnsafeEntryName(name) {
  if (typeof name !== 'string' || !name) return true
  if (name.startsWith('/') || name.startsWith('\\')) return true
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(name)) return true   // any `..` path segment
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true              // windows drive-absolute
  if (name.includes('\0')) return true                        // NUL injection
  return false
}

/**
 * safeLoadZip — JSZip.loadAsync wrapped in the structural bounds.
 * Enforces: input size, entry count, per-entry + total DECLARED uncompressed
 * size (the zip-bomb guard — checked from the central-directory metadata BEFORE
 * any entry is inflated), and zip-slip entry names. Returns the JSZip instance.
 *
 * The uncompressed-size check reads JSZip's per-file metadata
 * (`file._data.uncompressedSize`) which comes straight from the zip central
 * directory — so a 42 KB "42.zip"-style bomb is refused without decompressing a
 * single byte. Callers should still prefer `entryText()` below to read entries
 * (it re-checks the actual inflated length as belt-and-braces).
 */
export async function safeLoadZip(arrayBuffer, filename = 'file') {
  assertFileSize(arrayBuffer.byteLength, filename)
  let zip
  try {
    zip = await JSZip.loadAsync(arrayBuffer, { createFolders: false })
  } catch (e) {
    throw new ImportError(`${filename} is not a readable archive: ${e.message}`)
  }
  const names = Object.keys(zip.files)
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new ImportError(`${filename} has too many entries (${names.length} > ${MAX_ZIP_ENTRIES}).`)
  }
  let total = 0
  for (const name of names) {
    const f = zip.files[name]
    if (isUnsafeEntryName(name)) {
      throw new ImportError(`${filename} contains an unsafe entry path: ${name}`)
    }
    // Declared uncompressed size from the central directory (present for real
    // zips; JSZip exposes it on the internal _data). Guard both the single-entry
    // and the running total to catch a bomb whichever shape it takes.
    const declared = f?._data?.uncompressedSize
    if (typeof declared === 'number') {
      if (declared > MAX_SINGLE_ENTRY) {
        throw new ImportError(`${filename} entry "${name}" is too large when decompressed.`)
      }
      total += declared
      if (total > MAX_TOTAL_UNCOMPRESSED) {
        throw new ImportError(`${filename} decompresses to more than the ${Math.round(MAX_TOTAL_UNCOMPRESSED / 1048576)} MB limit (possible zip-bomb).`)
      }
    }
  }
  return zip
}

/**
 * entryText — read one zip entry as a string, re-checking the ACTUAL inflated
 * length against the single-entry cap (defence-in-depth if the declared size in
 * the central directory lied). Returns '' for a missing entry.
 */
export async function entryText(zip, name) {
  const f = zip.files[name]
  if (!f) return ''
  const buf = await f.async('uint8array')
  if (buf.length > MAX_SINGLE_ENTRY) {
    throw new ImportError(`entry "${name}" exceeds the decompressed-size limit.`)
  }
  return new TextDecoder('utf-8').decode(buf)
}

/** Read one zip entry as a base64 data: URI with the given MIME — bounded. */
export async function entryDataUri(zip, name, mime) {
  const f = zip.files[name]
  if (!f) return ''
  const buf = await f.async('uint8array')
  if (buf.length > MAX_SINGLE_ENTRY) {
    throw new ImportError(`entry "${name}" exceeds the decompressed-size limit.`)
  }
  // Chunked base64 to avoid a call-stack blow-up on large arrays.
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

// ── XXE-safe XML parsing ─────────────────────────────────────────────────────
// We parse OpenDocument / OOXML part XML with the browser DOMParser. A DOMParser
// never resolves *external* entities (no network / no file access in the browser
// sandbox), but an INTERNAL entity block can still drive a billion-laughs memory
// blow-up, and a DOCTYPE has no legitimate place in an office part. So we STRIP
// any DOCTYPE / ENTITY declaration before parsing — fail-closed: the parse sees
// only element markup, never an entity-expansion or external-DTD reference.
export function stripDoctype(xml) {
  if (typeof xml !== 'string') return ''
  // Remove the whole <!DOCTYPE ...> production (with or without an internal
  // subset) and any stray <!ENTITY ...> declarations. Also drop external-entity
  // reference syntax markers so a malformed doc can't smuggle one past the strip.
  return xml
    .replace(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\]\s*)?>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
}

/**
 * parseXmlSafe — DOMParser over XML with DOCTYPE/ENTITY stripped first. Returns
 * a Document. Throws ImportError on a parse error (a hostile/corrupt part).
 */
export function parseXmlSafe(xml, label = 'xml') {
  if (typeof DOMParser === 'undefined') {
    throw new ImportError('XML parsing is unavailable in this environment.')
  }
  const cleaned = stripDoctype(xml)
  const doc = new DOMParser().parseFromString(cleaned, 'application/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new ImportError(`Could not parse ${label}.`)
  return doc
}

export { isUnsafeEntryName }
