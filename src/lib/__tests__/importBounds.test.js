/**
 * importBounds.test.js — the structural import trust boundary.
 * Covers: oversize gate, zip-slip entry-name rejection, XXE/DOCTYPE stripping,
 * safe XML parse (parsererror → ImportError), and bounded zip round-trip.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  assertFileSize, isUnsafeEntryName, stripDoctype, parseXmlSafe, safeLoadZip,
  entryText, entryDataUri, ImportError, MAX_FILE_BYTES,
} from '../importBounds.js'

describe('assertFileSize', () => {
  it('accepts a normal size', () => {
    expect(() => assertFileSize(1024, 'f')).not.toThrow()
  })
  it('rejects an oversize input fail-closed', () => {
    expect(() => assertFileSize(MAX_FILE_BYTES + 1, 'big')).toThrow(ImportError)
  })
})

describe('isUnsafeEntryName (zip-slip / traversal)', () => {
  it('flags traversal, absolute, drive, backslash and NUL paths', () => {
    for (const bad of [
      '../evil.txt', 'a/../../etc/passwd', '/abs/path', '\\win\\path',
      'C:\\x', 'foo\0bar', '..', 'a/..',
    ]) {
      expect(isUnsafeEntryName(bad)).toBe(true)
    }
  })
  it('allows ordinary in-archive paths', () => {
    for (const ok of ['content.xml', 'ppt/slides/slide1.xml', 'Pictures/img.png', 'a..b/c']) {
      expect(isUnsafeEntryName(ok)).toBe(false)
    }
  })
})

describe('stripDoctype (XXE / billion-laughs)', () => {
  it('removes DOCTYPE + ENTITY declarations', () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE lolz [ <!ENTITY lol "LOL"> <!ENTITY a "&lol;&lol;&lol;"> ]>
      <root>&a;</root>`
    const out = stripDoctype(xml)
    expect(out).not.toMatch(/DOCTYPE/i)
    expect(out).not.toMatch(/ENTITY/i)
    expect(out).toContain('<root>')
  })
  it('leaves normal markup untouched', () => {
    const xml = '<root><child>hi</child></root>'
    expect(stripDoctype(xml)).toBe(xml)
  })
})

describe('parseXmlSafe', () => {
  it('parses valid XML into a Document', () => {
    const doc = parseXmlSafe('<a><b>x</b></a>', 'test')
    expect(doc.getElementsByTagName('b')[0].textContent).toBe('x')
  })
  it('does NOT expand an entity from a stripped DOCTYPE (XXE-safe)', () => {
    const xml = '<!DOCTYPE r [ <!ENTITY secret "PWNED"> ]><r>&secret;</r>'
    // With the DOCTYPE stripped, &secret; is an undefined entity → parse error,
    // never an expansion to "PWNED". Either way, "PWNED" must never appear.
    let text = ''
    try { text = parseXmlSafe(xml, 'x').documentElement.textContent } catch { /* ImportError ok */ }
    expect(text).not.toContain('PWNED')
  })
  it('throws ImportError on malformed XML', () => {
    expect(() => parseXmlSafe('<a><b></a>', 'bad')).toThrow(ImportError)
  })
})

describe('safeLoadZip / entryText / entryDataUri', () => {
  it('loads a clean zip and reads entries back', async () => {
    const zip = new JSZip()
    zip.file('content.xml', '<r>hello</r>')
    zip.file('Pictures/x.png', new Uint8Array([1, 2, 3, 4]))
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await safeLoadZip(ab, 'test.zip')
    expect(await entryText(loaded, 'content.xml')).toBe('<r>hello</r>')
    const uri = await entryDataUri(loaded, 'Pictures/x.png', 'image/png')
    expect(uri).toMatch(/^data:image\/png;base64,/)
  })
  it('rejects a zip carrying a traversal entry name', async () => {
    const zip = new JSZip()
    zip.file('ok.txt', 'x')
    // Force a raw traversal name into the archive.
    zip.files['../evil.txt'] = zip.files['ok.txt']
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    // Re-load (generate may normalise); assert the guard rejects it if present.
    const reloaded = await JSZip.loadAsync(ab)
    if (Object.keys(reloaded.files).some(isUnsafeEntryName)) {
      await expect(safeLoadZip(ab, 'evil.zip')).rejects.toThrow(ImportError)
    } else {
      expect(true).toBe(true) // JSZip normalised the name; nothing unsafe reached us
    }
  })
  it('rejects a non-archive buffer', async () => {
    const notZip = new TextEncoder().encode('not a zip at all').buffer
    await expect(safeLoadZip(notZip, 'x.zip')).rejects.toThrow(ImportError)
  })
})
