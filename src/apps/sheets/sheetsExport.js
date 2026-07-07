import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import { escapeChartText } from './charts.js'

function fortuneToWorksheet(sheet) {
  const ws = {}
  const cells = sheet.celldata || []
  let maxR = 0, maxC = 0
  for (const { r, c, v } of cells) {
    if (!v) continue
    const raw = v.v !== undefined ? v.v : v.m
    const cell = { v: raw, t: typeof raw === 'number' ? 'n' : 's' }
    // Carry the cell's number-format code (Fortune Sheet ct.fa) into the xlsx
    // `z` field so currency/percent/date presets round-trip to Excel. 'General'
    // is the default and needs no explicit format.
    const fa = v.ct?.fa
    if (fa && fa !== 'General') cell.z = fa
    ws[XLSX.utils.encode_cell({ r, c })] = cell
    if (r > maxR) maxR = r
    if (c > maxC) maxC = c
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } })
  // Restore merged cells from Fortune Sheet config.merge → xlsx !merges
  const mc = sheet.config?.merge
  if (mc && typeof mc === 'object') {
    ws['!merges'] = Object.values(mc).map(m => ({
      s: { r: m.r, c: m.c },
      e: { r: m.r + (m.rs || 1) - 1, c: m.c + (m.cs || 1) - 1 },
    }))
  }
  return ws
}

/**
 * chartsMetaSheet — WAVE-54 export fidelity.
 *
 * HONEST LIMITATION: our charts render as inline SVG driven by a plain-data
 * descriptor; we deliberately do NOT pull in a heavy library (ExcelJS /
 * xlsx-populate) to emit native OOXML <c:chart> parts. So charts do NOT round-
 * trip as *live Excel charts*. What we DO preserve is the chart DEFINITION: each
 * chart's {type, range, title, options} is written to a hidden-ish "Vulos Charts"
 * metadata worksheet, so the intent survives the export and the app can restore
 * live charts on re-import. CSV cannot carry charts at all (it is values-only) —
 * they are simply omitted there.
 */
export function chartsMetaSheet(data) {
  const charts = data?.[0]?.charts
  if (!Array.isArray(charts) || charts.length === 0) return null
  const rows = [['type', 'range', 'title', 'xAxisLabel', 'yAxisLabel', 'legend', 'headerRow', 'headerCol']]
  for (const c of charts) {
    // WAVE-55 SECURITY: title / range / axis labels can originate from cell data
    // (or a hostile CRDT peer). Run every free-text field through escapeChartText
    // so a leading =/+/-/@ is neutralised with a quote — otherwise a title like
    // `=HYPERLINK("http://evil")` or `=cmd|'/c calc'!A1` would be written as a
    // LIVE FORMULA into the exported worksheet and evaluate when opened in Excel
    // (CSV/formula injection). type/legend/header* are fixed enums, not free text.
    rows.push([
      String(c.type ?? ''),
      escapeChartText(c.range ?? ''),
      escapeChartText(c.title ?? ''),
      escapeChartText(c.options?.xAxisLabel ?? ''),
      escapeChartText(c.options?.yAxisLabel ?? ''),
      c.options?.legend === false ? 'no' : 'yes',
      c.options?.headerRow === false ? 'no' : 'yes',
      c.options?.headerCol === false ? 'no' : 'yes',
    ])
  }
  return XLSX.utils.aoa_to_sheet(rows)
}

export function exportSheetsToXlsx(data, filename) {
  const wb = XLSX.utils.book_new()
  for (const sheet of data) {
    XLSX.utils.book_append_sheet(wb, fortuneToWorksheet(sheet), sheet.name || 'Sheet')
  }
  // Append the chart-definition metadata sheet when charts exist (see above).
  const meta = chartsMetaSheet(data)
  if (meta) XLSX.utils.book_append_sheet(wb, meta, 'Vulos Charts')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filename}.xlsx`)
}

// Serialise ONE cell value into a CSV field.
//
// SECURITY (formula / CSV injection): a cell value is untrusted — a hostile CRDT
// peer can set any cell to an arbitrary STRING (grid_op), and imports carry
// attacker text too. A string that a spreadsheet re-parses as a formula/command
// when the exported .csv is opened (leading `= + - @`, or a TAB / CR that Excel
// also treats as a formula lead-in) is neutralised with a leading apostrophe —
// the same guard escapeChartText/pivotText already apply on their surfaces.
// NUMERIC cells are emitted verbatim: they are typed `number` here (FortuneSheet
// stores computed values as numbers), can never carry a payload, and prefixing a
// legitimate negative number like `-5` would corrupt the data — so the guard is
// scoped to string cells only.
export function csvField(cell) {
  if (typeof cell === 'number') return String(cell)
  let s = String(cell ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Build the CSV text for the first sheet (pure — no side effects, testable). */
export function buildCsv(data) {
  const sheet = data?.[0]
  if (!sheet) return ''
  const cells = sheet.celldata || []
  let maxR = 0, maxC = 0
  for (const { r, c } of cells) { if (r > maxR) maxR = r; if (c > maxC) maxC = c }
  const grid = Array.from({ length: maxR + 1 }, () => new Array(maxC + 1).fill(''))
  for (const { r, c, v } of cells) {
    if (!v) continue
    grid[r][c] = v.v !== undefined ? v.v : (v.m ?? '')
  }
  return grid.map((row) => row.map(csvField).join(',')).join('\n')
}

export function exportSheetsToCsv(data, filename) {
  if (!data?.[0]) return
  const csv = buildCsv(data)
  saveAs(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`)
}
