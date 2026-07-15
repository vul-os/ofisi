/**
 * src/lib/index.js — @vulos/office-client main library barrel
 *
 * Re-exports the embeddable app components. Build target: dist-lib/
 * (Spaces/chat moved to the standalone @vulos/talk-client product; Calendar +
 * Contacts come via the mail connector — CalDAV/CardDAV through lilmail / @vulos/mail-ui.)
 */

export { DocsApp }     from '../apps/docs/lib.jsx'
export { SheetsApp }   from '../apps/sheets/lib.jsx'
export { SlidesApp }   from '../apps/slides/lib.jsx'
export { PDFApp }      from '../apps/pdf/lib.jsx'
