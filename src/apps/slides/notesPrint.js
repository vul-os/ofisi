/**
 * notesPrint.js — build the "Print speaker notes" HTML document.
 *
 * SECURITY: slide titles + notes + the deck title are PLAIN-TEXT fields that are
 * NOT trusted — a slide note can come straight from an imported .pptx
 * (slidesImport readNotes). This document is written into a new window at the
 * app origin, so an un-escaped `<script>` in a note/title would execute there.
 * Every text field is HTML-escaped here; slide.content (rich HTML) is passed
 * through the caller's HTML sanitiser instead.
 */

export function escapeNotesHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/**
 * Build the print-notes HTML string.
 * @param {object} slidesData  the deck ({ slides: [...] })
 * @param {string} title       the deck title (escaped)
 * @param {(html:string)=>string} sanitize  HTML sanitiser for slide.content
 */
export function buildNotesPrintHtml(slidesData, title, sanitize) {
  const esc = escapeNotesHtml
  const slides = Array.isArray(slidesData?.slides) ? slidesData.slides : []
  const body = slides.map((slide, i) => `
      <div style="page-break-after:always;padding:20px;border-bottom:2px solid #eee">
        <h2 style="font-size:18px">${i + 1}. ${esc(slide.title || 'Untitled')}</h2>
        <div style="background:#f5f5f5;padding:12px;border-radius:4px;margin:8px 0;font-size:12px">
          ${sanitize(slide.content || '')}
        </div>
        <div style="margin-top:12px">
          <strong style="font-size:11px;text-transform:uppercase;color:#666">Notes</strong>
          <p style="font-size:13px;white-space:pre-wrap">${esc(slide.notes || '(no notes)')}</p>
        </div>
      </div>
    `).join('')
  return `<!DOCTYPE html><html><head><title>${esc(title)} — Notes</title>
      <style>body{font-family:Georgia,serif;margin:0;padding:0}</style>
    </head><body>${body}</body></html>`
}
