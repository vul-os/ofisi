/**
 * docxImport.test.js — a HOSTILE .docx must be neutralised on import.
 * ----------------------------------------------------------------------------
 * The Docs import path is: mammoth (docx→html) → `_html` → sanitizeDocHtml (the
 * DocsEditor.resolveContent trust boundary) → TipTap. This test hand-builds a
 * malicious WordprocessingML package (a javascript: hyperlink) and drives it
 * through the SAME two steps, asserting the exec scheme is gone and the benign
 * content survives.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { sanitizeDocHtml } from '../../../lib/sanitize.js'

async function hostileDocx() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>` +
    `<w:p><w:hyperlink r:id="rIdEvil"><w:r><w:t>clickme</w:t></w:r></w:hyperlink></w:p>` +
    `<w:p><w:r><w:t>Hello Doc Body</w:t></w:r></w:p>` +
    `</w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdEvil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ` +
    `Target="javascript:alert(document.cookie)" TargetMode="External"/></Relationships>`)
  // nodebuffer so mammoth's node build (used by vitest) can open it; the app
  // uses mammoth's browser build with { arrayBuffer } — same converter, same HTML.
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('docx import — hostile input neutralised at the sanitizer boundary', () => {
  it('strips a javascript: hyperlink but keeps the document text', async () => {
    const buf = await hostileDocx()
    const { value: rawHtml } = await mammoth.convertToHtml({ buffer: buf })
    // Mammoth faithfully carries the exec-scheme href through (it is a converter,
    // not a sanitiser) — proving the sanitiser, not the converter, is the guard.
    const clean = sanitizeDocHtml(rawHtml)
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).not.toMatch(/<script/i)
    expect(clean).toContain('Hello Doc Body')   // benign content survives
    expect(clean).toContain('clickme')          // link text kept, href neutralised
  })
})
