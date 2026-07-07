/**
 * sheetsImport.js — .xlsx / .xls / .ods → Fortune-Sheet workbook model.
 * ----------------------------------------------------------------------------
 * SheetJS (`xlsx`, already a dependency) reads xlsx / xls / ods natively with a
 * hardened, external-entity-free XML parser, so it is the right lightweight
 * engine — no second spreadsheet library needed. This module wraps it in the
 * import trust boundary: a compressed-size gate, a per-sheet cell cap, a
 * sheet-count cap, and a declared-range clamp so a file that declares a bogus
 * `A1:XFD1048576` range can't drive an enormous allocation.
 *
 * FIDELITY: values, formulas (imported as DATA — see the SECURITY note), number
 * formats (currency/percent/date via the `z` code → Fortune-Sheet ct.fa), merged
 * cells, multiple sheets, and column widths + row heights all round-trip.
 *
 * SECURITY — formula injection: a cell may carry a formula (cell.f). We DO import
 * it as the cell's formula so a real spreadsheet stays functional, but the value
 * is stored as structured data — it is NEVER eval()'d by us, and Fortune-Sheet's
 * formula parser is a pure evaluator (no shell/DOM/network). The dangerous
 * direction is EXPORT to CSV, where a leading =/+/-/@ would be re-interpreted by
 * the opening app; that is neutralised in sheetsExport.csvField. Cell *display*
 * text is rendered by Fortune-Sheet as escaped text, never as HTML.
 */

import * as XLSX from 'xlsx'
import {
  assertFileSize, MAX_SHEETS, MAX_CELLS_PER_SHEET, MAX_ROWS, MAX_COLS, ImportError,
} from '../../lib/importBounds.js'

// Map a SheetJS cell type to a Fortune-Sheet ct.t code.
function ctType(t) {
  if (t === 'n') return 'n'
  if (t === 'b') return 'b'
  if (t === 'd') return 'd'
  return 's'
}

function worksheetToSheet(ws, name) {
  if (!ws || !ws['!ref']) return { name, celldata: [], config: {}, row: 84, column: 60 }
  const range = XLSX.utils.decode_range(ws['!ref'])
  // Clamp the declared range so a lying header can't force a huge iteration.
  const endR = Math.min(range.e.r, MAX_ROWS - 1)
  const endC = Math.min(range.e.c, MAX_COLS - 1)

  const celldata = []
  for (let r = range.s.r; r <= endR; r++) {
    for (let c = range.s.c; c <= endC; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (!cell) continue
      if (celldata.length >= MAX_CELLS_PER_SHEET) {
        throw new ImportError(`Sheet "${name}" has more than ${MAX_CELLS_PER_SHEET} cells (import limit).`)
      }
      const v = cell.v ?? ''
      const m = cell.w != null ? String(cell.w) : String(v)
      const ct = { t: ctType(cell.t) }
      // Carry the number-format code (currency / percent / date) into ct.fa so
      // it round-trips back out on export. 'General' is the implicit default.
      if (cell.z && cell.z !== 'General') ct.fa = cell.z
      const cellVal = { v, m, ct }
      // Import the formula as DATA (leading '='). We never evaluate it ourselves;
      // Fortune-Sheet's pure parser recomputes it on load. See the SECURITY note.
      if (cell.f) cellVal.f = `=${cell.f}`
      celldata.push({ r, c, v: cellVal })
    }
  }

  const config = {}

  // Merged cells → Fortune-Sheet config.merge.
  const merges = ws['!merges'] || []
  if (merges.length) {
    const mc = {}
    for (const mg of merges) {
      mc[`${mg.s.r}_${mg.s.c}`] = { r: mg.s.r, c: mg.s.c, rs: mg.e.r - mg.s.r + 1, cs: mg.e.c - mg.s.c + 1 }
    }
    config.merge = mc
  }

  // Column widths → config.columnlen (px). SheetJS gives wpx or wch (chars).
  const cols = ws['!cols'] || []
  if (cols.length) {
    const columnlen = {}
    cols.forEach((col, i) => {
      if (!col) return
      const px = Number.isFinite(col.wpx) ? col.wpx
        : Number.isFinite(col.width) ? Math.round(col.width * 7)
        : Number.isFinite(col.wch) ? Math.round(col.wch * 7)
        : null
      if (px != null && px > 0) columnlen[i] = Math.min(px, 2000)
    })
    if (Object.keys(columnlen).length) config.columnlen = columnlen
  }

  // Row heights → config.rowlen (px). SheetJS gives hpx or hpt (points).
  const rows = ws['!rows'] || []
  if (rows.length) {
    const rowlen = {}
    rows.forEach((row, i) => {
      if (!row) return
      const px = Number.isFinite(row.hpx) ? row.hpx
        : Number.isFinite(row.hpt) ? Math.round(row.hpt * 96 / 72)
        : null
      if (px != null && px > 0) rowlen[i] = Math.min(px, 1000)
    })
    if (Object.keys(rowlen).length) config.rowlen = rowlen
  }

  return { name, celldata, config, row: Math.max(84, endR + 10), column: Math.max(60, endC + 5) }
}

/**
 * workbookToSheets — parse an xlsx/xls/ods ArrayBuffer into the Fortune-Sheet
 * data array. Enforces the file-size gate + sheet/cell caps. `cellStyles:true`
 * pulls in column/row metadata; we deliberately do NOT enable `bookVBA` or any
 * macro extraction — a macro-laden workbook is imported as inert data only.
 */
export function workbookToSheets(arrayBuffer, filename = 'file') {
  assertFileSize(arrayBuffer.byteLength, filename)
  let wb
  try {
    wb = XLSX.read(arrayBuffer, { type: 'array', cellStyles: true, cellNF: true, dense: false })
  } catch (e) {
    throw new ImportError(`Could not read ${filename}: ${e.message}`)
  }
  const names = wb.SheetNames.slice(0, MAX_SHEETS)
  if (wb.SheetNames.length > MAX_SHEETS) {
    throw new ImportError(`${filename} has more than ${MAX_SHEETS} sheets (import limit).`)
  }
  const out = names.map((name) => worksheetToSheet(wb.Sheets[name], name))
  return out.length ? out : [{ name: 'Sheet1', celldata: [], config: {}, row: 84, column: 60 }]
}
