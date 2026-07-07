/**
 * src/apps/sheets/charts.js  (WAVE-54)
 *
 * Pure, dependency-free chart model + data extraction for Sheets.
 *
 * A chart is PLAIN STRUCTURED DATA stored on the first sheet as `sheet.charts`
 * (an array). It is NOT a screenshot and NOT HTML — it is a small descriptor:
 *
 *   {
 *     id:      string,                       // stable, unique
 *     type:    'bar'|'column'|'line'|'area'|'pie',
 *     range:   'A1:D10',                     // A1 source range (untrusted text)
 *     title:   string,                       // untrusted (may come from a cell)
 *     options: { xAxisLabel, yAxisLabel, legend, headerRow, headerCol },
 *     x: number, y: number, w: number, h: number   // float position over grid
 *   }
 *
 * Because the descriptor is plain data it round-trips cleanly through the CRDT
 * transport and the file-content save path, and it RE-RENDERS LIVE: the renderer
 * reads the current cell values for `range` every time the underlying cells
 * change (see chartValuesSignature for the memo key).
 *
 * SECURITY (WAVE-14 posture): every string that ends up on screen (title, axis
 * labels, category names, series names) originates from CELL DATA and is treated
 * as untrusted. Nothing here builds HTML. The React renderer emits SVG <text>
 * nodes whose children are escaped text — never innerHTML — so a cell containing
 * `<script>…` or `=HYPERLINK(...)` becomes literal glyphs, never markup or a
 * formula. `escapeChartText` below is a belt-and-braces normaliser used before a
 * value is ever placed into an export string (which then also passes the
 * WAVE-14 sanitizer). No value in a chart descriptor is ever eval'd.
 */

import { parseRange } from './ConditionalFormatPanel.jsx'

export const CHART_TYPES = [
  { value: 'column',  label: 'Column',  icon: '▮' },
  { value: 'bar',     label: 'Bar',     icon: '▬' },
  { value: 'line',    label: 'Line',    icon: '╱' },
  { value: 'area',    label: 'Area',    icon: '△' },
  { value: 'pie',     label: 'Pie',     icon: '◔' },
  // WAVE-63 additional types:
  { value: 'scatter', label: 'Scatter', icon: '⣿' },  // X/Y points (2 numeric series)
  { value: 'combo',   label: 'Combo',   icon: '▮╱' }, // 1st series bars, rest lines
  { value: 'bubble',  label: 'Bubble',  icon: '◍' },  // X/Y + size (3 numeric series)
]

const CHART_TYPE_SET = new Set(CHART_TYPES.map((t) => t.value))

// A palette of fixed, non-user colours for series/slices. Never derived from
// cell data, so it cannot be an injection vector.
export const CHART_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]

let _seq = 0
/** Stable-ish unique id; monotonic counter guards against Math.random collisions in a burst. */
export function newChartId() {
  _seq = (_seq + 1) % 1e6
  return 'cht_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * escapeChartText — normalise an untrusted cell value to a safe display string.
 *
 * The SVG renderer already escapes via React text children, so this is NOT what
 * stops XSS on screen. Its job is (a) coerce non-strings, (b) strip control
 * chars, and (c) neutralise a leading formula trigger (`= + - @`) the way a
 * spreadsheet import guard does, so a value like `=HYPERLINK(...)` can never be
 * interpreted as a formula if a chart label is later pasted/exported into a
 * context that re-parses it. Returns a plain string, no markup.
 */
export function escapeChartText(v, max = 200) {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  // Collapse tab/newline to a single space, then drop the remaining C0/DEL
  // control chars so a hostile cell can't smuggle terminal/format sequences.
  s = s.replace(/[\t\n\r]+/g, ' ')
       .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  // Neutralise a leading formula/command trigger (CSV-injection style guard).
  if (/^[=+\-@]/.test(s)) s = "'" + s
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

/**
 * makeChart — construct a well-formed chart descriptor with defaults, clamping
 * every field. Unknown chart types fall back to 'column'. Positions/sizes are
 * numbers with sane bounds so a corrupt/hostile descriptor can't produce an
 * absurd SVG. Always returns a fresh plain object (safe to hand to the CRDT).
 */
export function makeChart(partial = {}) {
  const type = CHART_TYPE_SET.has(partial.type) ? partial.type : 'column'
  const num = (v, d, lo, hi) => {
    const n = Number(v)
    if (!isFinite(n)) return d
    return Math.min(hi, Math.max(lo, n))
  }
  return {
    id:    typeof partial.id === 'string' && partial.id ? partial.id : newChartId(),
    type,
    range: typeof partial.range === 'string' ? partial.range.trim().toUpperCase() : '',
    title: typeof partial.title === 'string' ? partial.title.slice(0, 200) : '',
    options: {
      xAxisLabel: typeof partial.options?.xAxisLabel === 'string' ? partial.options.xAxisLabel.slice(0, 120) : '',
      yAxisLabel: typeof partial.options?.yAxisLabel === 'string' ? partial.options.yAxisLabel.slice(0, 120) : '',
      legend:     partial.options?.legend === false ? false : true,
      // headerRow/headerCol: whether the first row/col of the range holds labels.
      headerRow:  partial.options?.headerRow !== false,
      headerCol:  partial.options?.headerCol !== false,
    },
    x: num(partial.x, 40,  0, 100000),
    y: num(partial.y, 40,  0, 100000),
    w: num(partial.w, 480, 160, 4000),
    h: num(partial.h, 300, 120, 4000),
  }
}

/** Read the charts array off the first sheet (always an array). */
export function getCharts(data) {
  const arr = data?.[0]?.charts
  return Array.isArray(arr) ? arr : []
}

/**
 * chartsBySheetId — index the authoritative charts of a workbook by sheet id
 * (falling back to positional index when a sheet has no id). Charts are an
 * app-owned overlay field FortuneSheet knows nothing about, so when its
 * `onChange` re-emits normalised sheet objects it DROPS `sheet.charts`
 * (WAVE-61 data-loss). We snapshot the charts here, keyed stably, so they can be
 * re-attached to the normalised sheets in `mergeCharts`.
 */
export function chartsBySheetId(data) {
  const map = new Map()
  ;(data || []).forEach((sheet, idx) => {
    if (Array.isArray(sheet?.charts) && sheet.charts.length) {
      map.set(sheet?.id ?? `#${idx}`, sheet.charts)
    }
  })
  return map
}

/**
 * mergeCharts — re-attach an authoritative charts map (see chartsBySheetId)
 * onto a fresh (normalised) workbook array, matching by sheet id then position.
 *
 * This is the WAVE-61 fix core: FortuneSheet's `onChange` payload never carries
 * `sheet.charts`, so `setData(payload)` would clobber locally-inserted charts on
 * grid init and on every cell edit. Merging the app's own charts back makes them
 * a first-class, locally-authoritative, persisted part of the sheet model.
 *
 * The charts are the LOCAL USER'S OWN (trusted) — this path deliberately does
 * NOT re-run them through makeChart on every keystroke (that would be pure
 * overhead). Well-formedness is enforced where a chart ENTERS the model
 * (ChartWizard→insertChart/updateChart, and the WAVE-55 chart_op ingress which
 * still funnels every untrusted peer descriptor through makeChart). To keep a
 * corrupt local state from crashing render, `clampCharts` below re-clamps if a
 * chart is ever missing finite geometry.
 */
export function mergeCharts(nextData, chartsMap) {
  if (!chartsMap || chartsMap.size === 0) return nextData
  return (nextData || []).map((sheet, idx) => {
    const key = sheet?.id ?? `#${idx}`
    const preserved = chartsMap.get(key) ?? (idx === 0 ? chartsMap.values().next().value : undefined)
    // If the normalised sheet already carries charts (rare), keep them; else
    // re-attach the authoritative ones we snapshotted before normalisation.
    if (Array.isArray(sheet?.charts) && sheet.charts.length) return sheet
    if (preserved && preserved.length) return { ...sheet, charts: preserved }
    return sheet
  })
}

/**
 * clampCharts — defensively re-clamp the charts on the first sheet through
 * makeChart so a corrupt/legacy local descriptor (e.g. non-finite geometry from
 * a stale draft) can never reach the SVG renderer with NaN layout. Idempotent on
 * already-well-formed charts. Used when loading content into the editor.
 */
export function clampCharts(data) {
  const charts = getCharts(data)
  if (!charts.length) return data
  return setCharts(data, charts.map((c) => makeChart(c)))
}

/** Immutably replace the charts array on the first sheet. */
export function setCharts(data, charts) {
  return (data || []).map((sheet, idx) =>
    idx === 0 ? { ...sheet, charts: Array.isArray(charts) ? charts : [] } : sheet
  )
}

/** Insert a chart (immutably). Returns new workbook data. */
export function insertChart(data, chart) {
  return setCharts(data, [...getCharts(data), makeChart(chart)])
}

/** Update a chart by id with a partial patch (immutably). */
export function updateChart(data, id, patch) {
  const next = getCharts(data).map((c) =>
    c.id === id ? makeChart({ ...c, ...patch, options: { ...c.options, ...(patch.options || {}) } }) : c
  )
  return setCharts(data, next)
}

/** Delete a chart by id (immutably). */
export function deleteChart(data, id) {
  return setCharts(data, getCharts(data).filter((c) => c.id !== id))
}

// ── Cell reads ──────────────────────────────────────────────────────────────

/**
 * Build a fast {r,c} → cell lookup from FortuneSheet celldata. Values are the
 * raw cell records; readers below normalise to display string / number.
 */
function celldataIndex(sheet) {
  const idx = new Map()
  for (const cell of sheet?.celldata || []) {
    idx.set(cell.r + ',' + cell.c, cell)
  }
  return idx
}

/** Display string of a FortuneSheet cell record (mirrors export's v.v ?? v.m). */
function cellDisplay(cell) {
  const v = cell?.v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return v.v !== undefined && v.v !== null ? v.v : (v.m ?? '')
  return v
}

/** Numeric value of a cell (NaN when not a number). Used for plotting. */
function cellNumber(cell) {
  const d = cellDisplay(cell)
  if (typeof d === 'number') return d
  if (typeof d === 'string' && d.trim() !== '') {
    const n = Number(d.replace(/[$,%\s]/g, ''))
    if (isFinite(n)) return n
  }
  return NaN
}

/**
 * extractChartData — turn a chart descriptor + the current sheet cells into a
 * plottable, PLAIN-DATA structure. This is the reactive core: call it whenever
 * cells change to get fresh numbers. All label strings are run through
 * escapeChartText so downstream never sees a raw formula/control string.
 *
 * Returns:
 *   {
 *     categories: string[],                 // x-axis / slice labels (escaped)
 *     series: [{ name: string, values: number[], color: string }],
 *     empty: boolean,                       // true when nothing numeric to plot
 *   }
 *
 * Orientation: columns are series, rows are categories (Sheets default for a
 * tall range). headerRow ⇒ first row = series names; headerCol ⇒ first col =
 * category labels.
 */
export function extractChartData(chart, sheet) {
  const parsed = parseRange(chart?.range || '')?.[0]
  const [r0, r1] = parsed.row
  const [c0, c1] = parsed.column
  // Guard against a pathological range blowing up memory.
  const rows = Math.min(r1 - r0 + 1, 1000)
  const cols = Math.min(c1 - c0 + 1, 100)
  const idx = celldataIndex(sheet)

  const opt = chart.options || {}
  const hasHeaderRow = opt.headerRow !== false && rows > 1
  const hasHeaderCol = opt.headerCol !== false && cols > 1

  const dataR0 = hasHeaderRow ? r0 + 1 : r0
  const dataC0 = hasHeaderCol ? c0 + 1 : c0

  const categories = []
  for (let r = dataR0; r < r0 + rows; r++) {
    if (hasHeaderCol) {
      categories.push(escapeChartText(cellDisplay(idx.get(r + ',' + c0))))
    } else {
      categories.push(String(r - dataR0 + 1))
    }
  }

  const series = []
  let si = 0
  for (let c = dataC0; c < c0 + cols; c++) {
    const name = hasHeaderRow
      ? escapeChartText(cellDisplay(idx.get(r0 + ',' + c))) || `Series ${si + 1}`
      : `Series ${si + 1}`
    const values = []
    for (let r = dataR0; r < r0 + rows; r++) {
      const n = cellNumber(idx.get(r + ',' + c))
      values.push(isFinite(n) ? n : 0)
    }
    series.push({ name, values, color: CHART_PALETTE[si % CHART_PALETTE.length] })
    si++
  }

  const empty = series.length === 0 ||
    series.every((s) => s.values.every((v) => v === 0)) ||
    categories.length === 0

  return { categories, series, empty }
}

/**
 * chartValuesSignature — a cheap string fingerprint of exactly the cells a chart
 * depends on, plus its shape-affecting fields. Used as a memo/dep key so a chart
 * only recomputes when ITS source range values (or its own config) change — not
 * on every keystroke elsewhere in the grid.
 */
export function chartValuesSignature(chart, sheet) {
  const parsed = parseRange(chart?.range || '')?.[0]
  const [r0, r1] = parsed.row
  const [c0, c1] = parsed.column
  const rows = Math.min(r1 - r0 + 1, 1000)
  const cols = Math.min(c1 - c0 + 1, 100)
  const idx = celldataIndex(sheet)
  const parts = []
  for (let r = r0; r < r0 + rows; r++) {
    for (let c = c0; c < c0 + cols; c++) {
      const d = cellDisplay(idx.get(r + ',' + c))
      if (d !== '') parts.push(r + ':' + c + '=' + d)
    }
  }
  // Include the config that changes the plotted shape/labels.
  return chart.type + '|' + chart.range + '|' + chart.title + '|' +
    (chart.options?.headerRow) + '|' + (chart.options?.headerCol) + '|' +
    parts.join(',')
}

/**
 * chartAccessibleSummary — a plain-text, screen-reader summary of a chart. Pure
 * text (escaped), used for the SVG <title>/<desc> and aria-label.
 */
export function chartAccessibleSummary(chart, extracted) {
  const kind = CHART_TYPES.find((t) => t.value === chart.type)?.label || chart.type
  const title = escapeChartText(chart.title) || 'Untitled chart'
  if (!extracted || extracted.empty) {
    return `${kind} chart: ${title}. No data to plot.`
  }
  const seriesNames = extracted.series.map((s) => s.name).join(', ')
  return `${kind} chart: ${title}. ${extracted.series.length} series ` +
    `(${seriesNames}) across ${extracted.categories.length} categories.`
}
