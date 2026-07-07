/**
 * src/apps/sheets/pivot.js  (WAVE-63 — reactive pivot tables)
 *
 * Pure pivot model + aggregation, mirroring the WAVE-54 chart model discipline.
 *
 * A pivot is PLAIN STRUCTURED DATA (a descriptor), NOT a static snapshot. It is
 * stored on the first sheet as `sheet.pivots` (an array). Each descriptor names
 * a SOURCE RANGE and the row/column/value/aggregation config. The pivot result
 * is RE-AGGREGATED from the current source cells every time those cells change
 * (reactive, like charts), and re-rendered — so a pivot lives instead of going
 * stale.
 *
 *   {
 *     id:        string,
 *     range:     'A1:D100',           // A1 source range (untrusted text)
 *     title:     string,              // untrusted
 *     rowField:  string,              // header name to group rows by
 *     colField:  string,              // header name to group cols by ('' = none)
 *     valueField:string,              // header name to aggregate
 *     agg:       'SUM'|'AVG'|'COUNT'|'COUNTA'|'MAX'|'MIN',
 *   }
 *
 * SECURITY (WAVE-55 posture, reused): the descriptor rides the CRDT fabric as a
 * `pivot_op`, so it arrives from UNTRUSTED peers. `makePivot` is the fail-closed
 * clamp run at ingress: type/agg are allow-listed, strings are coerced + length
 * -capped, range is normalised. A pivot with no usable string id is dropped by
 * the caller. Aggregation is bounded (source rows/cols capped) so a hostile
 * config can't drive an unbounded loop (DoS). Every header/label that reaches
 * the DOM is React-escaped text — nothing here builds HTML or evals.
 */

export const PIVOT_AGGS = ['SUM', 'AVG', 'COUNT', 'COUNTA', 'MAX', 'MIN']
const PIVOT_AGG_SET = new Set(PIVOT_AGGS)

// Only-numeric view of a group's values (blank/text rows are ignored, matching
// spreadsheet SUM/AVERAGE/MAX/MIN semantics — a blank cell is NOT counted as 0).
function numeric(vals) {
  const out = []
  for (const v of vals) {
    if (v === '' || v === null || v === undefined) continue
    const n = Number(v)
    if (!Number.isNaN(n)) out.push(n)
  }
  return out
}
const AGG_FN = {
  SUM:    (vals) => numeric(vals).reduce((a, b) => a + b, 0),
  // AVG divides by the count of NUMERIC values, not total group rows — a blank
  // or text row must not drag the average toward zero.
  AVG:    (vals) => { const n = numeric(vals); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0 },
  COUNT:  (vals) => numeric(vals).length,
  COUNTA: (vals) => vals.filter((v) => v !== '' && v !== null && v !== undefined).length,
  MAX:    (vals) => { const n = numeric(vals); return n.length ? Math.max(...n) : 0 },
  MIN:    (vals) => { const n = numeric(vals); return n.length ? Math.min(...n) : 0 },
}

// Bounds so a hostile/corrupt config can never drive an unbounded aggregation.
const MAX_SOURCE_ROWS = 50000
const MAX_SOURCE_COLS = 200
const MAX_GROUPS = 2000

let _seq = 0
export function newPivotId() {
  _seq = (_seq + 1) % 1e6
  return 'pvt_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/** Coerce an untrusted cell/label value to a safe, length-capped string. */
export function pivotText(v, max = 200) {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  s = s.replace(/[\t\n\r]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  if (/^[=+\-@]/.test(s)) s = "'" + s
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

/**
 * makePivot — construct a well-formed pivot descriptor with defaults, clamping
 * every field. Unknown aggregation → 'SUM'. Always a fresh plain object (CRDT-
 * safe). This is the ingress clamp: run it on any peer-supplied descriptor.
 */
export function makePivot(partial = {}) {
  const agg = PIVOT_AGG_SET.has(partial.agg) ? partial.agg : 'SUM'
  const s = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '')
  // Card position over the grid — finite + bounded (same clamp discipline as
  // makeChart geometry), so a corrupt/hostile descriptor can't drive NaN layout.
  const num = (v, d, lo, hi) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
  return {
    id:         typeof partial.id === 'string' && partial.id ? partial.id : newPivotId(),
    range:      typeof partial.range === 'string' ? partial.range.trim().toUpperCase().slice(0, 40) : '',
    title:      typeof partial.title === 'string' ? partial.title.slice(0, 200) : '',
    rowField:   s(partial.rowField),
    colField:   s(partial.colField),
    valueField: s(partial.valueField),
    agg,
    x:          num(partial.x, 40, 0, 100000),
    y:          num(partial.y, 40, 0, 100000),
  }
}

/** Read the pivots array off the first sheet (always an array). */
export function getPivots(data) {
  const arr = data?.[0]?.pivots
  return Array.isArray(arr) ? arr : []
}

/** Immutably replace the pivots array on the first sheet. */
export function setPivots(data, pivots) {
  return (data || []).map((sheet, idx) =>
    idx === 0 ? { ...sheet, pivots: Array.isArray(pivots) ? pivots : [] } : sheet
  )
}

/** Insert a pivot (immutably). */
export function insertPivot(data, pivot) {
  return setPivots(data, [...getPivots(data), makePivot(pivot)])
}

/** Update a pivot by id with a partial patch (immutably). */
export function updatePivot(data, id, patch) {
  const next = getPivots(data).map((p) =>
    p.id === id ? makePivot({ ...p, ...patch }) : p
  )
  return setPivots(data, next)
}

/** Delete a pivot by id (immutably). */
export function deletePivot(data, id) {
  return setPivots(data, getPivots(data).filter((p) => p.id !== id))
}

/**
 * clampPivots — defensively re-clamp the pivots on the first sheet through
 * makePivot so a corrupt/legacy local descriptor can never reach aggregation
 * with an unsafe field. Idempotent. Used when loading content.
 */
export function clampPivots(data) {
  const pivots = getPivots(data)
  if (!pivots.length) return data
  return setPivots(data, pivots.map((p) => makePivot(p)))
}

/**
 * pivotsBySheetId / mergePivots — mirror the WAVE-61 chart preservation. Pivots
 * are an app-owned overlay field FortuneSheet knows nothing about, so its
 * `onChange` re-emits normalised sheet objects that DROP `sheet.pivots`. We
 * snapshot pivots keyed stably, then re-attach them onto the normalised sheets
 * so a plain cell edit never clobbers a live pivot.
 */
export function pivotsBySheetId(data) {
  const map = new Map()
  ;(data || []).forEach((sheet, idx) => {
    if (Array.isArray(sheet?.pivots) && sheet.pivots.length) {
      map.set(sheet?.id ?? `#${idx}`, sheet.pivots)
    }
  })
  return map
}

export function mergePivots(nextData, pivotsMap) {
  if (!pivotsMap || pivotsMap.size === 0) return nextData
  return (nextData || []).map((sheet, idx) => {
    const key = sheet?.id ?? `#${idx}`
    const preserved = pivotsMap.get(key) ?? (idx === 0 ? pivotsMap.values().next().value : undefined)
    if (Array.isArray(sheet?.pivots) && sheet.pivots.length) return sheet
    if (preserved && preserved.length) return { ...sheet, pivots: preserved }
    return sheet
  })
}

// ── Cell reads ───────────────────────────────────────────────────────────────

function cellDisplay(cell) {
  const v = cell?.v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return v.v !== undefined && v.v !== null ? v.v : (v.m ?? '')
  return v
}

// Parse "A1:D100" → {r0,c0,r1,c1} (0-indexed inclusive). Local, tiny, bounded.
function colToIndex(letters) {
  const s = String(letters).toUpperCase()
  let idx = 0
  for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.charCodeAt(i) - 64)
  return idx - 1
}
function parseA1(ref) {
  const m = String(ref).match(/^([A-Za-z]+)(\d+)$/)
  if (!m) return null
  return { c: colToIndex(m[1]), r: parseInt(m[2], 10) - 1 }
}
function parseRangeBounds(range) {
  const parts = String(range || '').trim().toUpperCase().split(':')
  if (parts.length === 1) {
    const a = parseA1(parts[0]); if (!a) return null
    return { r0: a.r, r1: a.r, c0: a.c, c1: a.c }
  }
  const a = parseA1(parts[0]), b = parseA1(parts[1])
  if (!a || !b) return null
  return {
    r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c),
  }
}

/**
 * sourceTable — extract the pivot's source range from the sheet as a 2-D array
 * (row-major), header row included. Bounded by MAX_SOURCE_* so a pathological
 * range can't blow up memory/CPU. Returns [] when the range is invalid.
 */
export function sourceTable(pivot, sheet) {
  const b = parseRangeBounds(pivot?.range)
  if (!b) return []
  const idx = new Map()
  // Actual populated extent of the sheet — a pivot never needs to materialise
  // cells past the last real cell. This is BOTH the correctness bound (blank
  // trailing rows/cols add nothing) AND the DoS bound: a range like A1:ZZ999999
  // over a 5-row sheet iterates 5 rows, not 10M. We still hard-cap by
  // MAX_SOURCE_* as a belt-and-braces ceiling.
  let usedR = -1, usedC = -1
  for (const cell of sheet?.celldata || []) {
    idx.set(cell.r + ',' + cell.c, cell)
    if (cell.r > usedR) usedR = cell.r
    if (cell.c > usedC) usedC = cell.c
  }
  const rows = Math.min(b.r1, usedR, b.r0 + MAX_SOURCE_ROWS - 1) - b.r0 + 1
  const cols = Math.min(b.c1, usedC, b.c0 + MAX_SOURCE_COLS - 1) - b.c0 + 1
  if (rows <= 0 || cols <= 0) return []
  const table = []
  for (let r = 0; r < rows; r++) {
    const row = []
    for (let c = 0; c < cols; c++) {
      row.push(cellDisplay(idx.get((b.r0 + r) + ',' + (b.c0 + c))))
    }
    table.push(row)
  }
  return table
}

/**
 * computePivot — aggregate the source table per the descriptor into a plain 2-D
 * result array (header row + data rows + grand-total row). This is the reactive
 * core: call it whenever the source cells change to get a fresh result. All
 * label strings are run through pivotText (safe display). Returns null when the
 * config can't produce a table (missing fields / no data).
 */
// Group-key separator: the ASCII unit-separator, which cannot appear in cell
// display text (control chars are not produced by sourceTable's numeric/text
// reads), so 'row<SEP>col' keys never collide with real category values.
const SEP = '\u001f'

export function computePivot(pivot, sheet) {
  const table = sourceTable(pivot, sheet)
  if (!table || table.length < 2) return null
  const headers = table[0].map((h) => String(h ?? ''))
  const rowIdx = headers.indexOf(pivot.rowField)
  const valIdx = headers.indexOf(pivot.valueField)
  const colIdx = pivot.colField ? headers.indexOf(pivot.colField) : -1
  if (rowIdx < 0 || valIdx < 0) return null

  const rows = new Set()
  const cols = new Set()
  const groups = new Map()
  for (let i = 1; i < table.length; i++) {
    if (groups.size > MAX_GROUPS) break // bound group explosion
    const row = table[i]
    const rv = String(row[rowIdx] ?? '')
    const cv = colIdx >= 0 ? String(row[colIdx] ?? '') : '__value__'
    rows.add(rv)
    cols.add(cv)
    const key = rv + SEP + cv
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row[valIdx])
  }

  const aggFn = AGG_FN[pivot.agg] || AGG_FN.SUM
  const rowArr = [...rows].sort()
  const colArr = [...cols].sort()
  const showCols = colIdx >= 0

  // Header row: rowField, then each column value (or a single value col), Total.
  const header = [pivotText(pivot.rowField)]
  if (showCols) for (const cv of colArr) header.push(pivotText(cv))
  else header.push(pivotText(pivot.valueField))
  header.push('Total')

  // Totals RE-AGGREGATE the underlying raw values (not sum the sub-cell
  // aggregates), so the "Total" is correct for EVERY aggregation — an AVG/MAX/MIN
  // total is otherwise a nonsense sum-of-averages / sum-of-maxes.
  const allCvs = showCols ? colArr : ['__value__']
  const rawFor = (rv, cvs) => {
    const vals = []
    for (const cv of cvs) { const g = groups.get(rv + SEP + cv); if (g) vals.push(...g) }
    return vals
  }

  const result = [header]
  for (const rv of rowArr) {
    const dataRow = [pivotText(rv)]
    for (const cv of allCvs) dataRow.push(round(aggFn(groups.get(rv + SEP + cv) || [])))
    dataRow.push(round(aggFn(rawFor(rv, allCvs)))) // row total = agg over the row's raw values
    result.push(dataRow)
  }

  // Grand-total row: per-column total = agg over that column's raw values;
  // grand total = agg over EVERY raw value.
  const totRow = ['Total']
  const allRaw = []
  for (const cv of allCvs) {
    const colVals = []
    for (const rv of rowArr) { const g = groups.get(rv + SEP + cv); if (g) { colVals.push(...g); allRaw.push(...g) } }
    totRow.push(round(aggFn(colVals)))
  }
  totRow.push(round(aggFn(allRaw)))
  result.push(totRow)

  return result
}

function round(v) {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.round(n * 1e6) / 1e6
}

/**
 * pivotToSheet — materialise a pivot RESULT as a real FortuneSheet sheet object
 * (celldata), so it can be exported to XLSX, referenced by formulas, and charted
 * — the capability the old static-snapshot pivot had. This is the "insert as
 * static values" path: it snapshots the current aggregation into cells (it does
 * NOT stay reactive — that's what the live descriptor is for). Header row/col are
 * bolded. Values are already safe (pivotText for labels; numbers for aggregates).
 */
export function pivotToSheet(pivot, sheet, name) {
  const result = computePivot(pivot, sheet)
  if (!result) return null
  const celldata = []
  for (let r = 0; r < result.length; r++) {
    for (let c = 0; c < result[r].length; c++) {
      const val = result[r][c]
      if (val === '' || val === null || val === undefined) continue
      const isNum = typeof val === 'number'
      celldata.push({
        r, c,
        v: {
          v: val, m: String(val),
          ct: { fa: 'General', t: isNum ? 'n' : 's' },
          ...(r === 0 || c === 0 ? { bl: 1 } : {}),
        },
      })
    }
  }
  const base = (name || `Pivot_${pivot.rowField}_${pivot.valueField}` || 'Pivot').slice(0, 31)
  return { name: base, celldata, config: {} }
}

/** headers available in a pivot source (for the config UI dropdowns). */
export function pivotHeaders(pivot, sheet) {
  const table = sourceTable(pivot, sheet)
  if (!table.length) return []
  return table[0].map((h) => String(h ?? '')).filter(Boolean)
}

/**
 * pivotValuesSignature — a cheap fingerprint of exactly the source cells a pivot
 * depends on, plus its config. Used as a memo key so a pivot only recomputes
 * when ITS source values or config change — not on every unrelated keystroke.
 */
export function pivotValuesSignature(pivot, sheet) {
  const b = parseRangeBounds(pivot?.range)
  if (!b) return pivot.id + '|invalid'
  // Fingerprint only the cells INSIDE the range that are actually populated —
  // iterate the celldata directly (bounded by the number of real cells), not
  // the raw range area, so a huge range doesn't produce a huge signature loop.
  const parts = []
  for (const cell of sheet?.celldata || []) {
    if (cell.r < b.r0 || cell.r > b.r1 || cell.c < b.c0 || cell.c > b.c1) continue
    const d = cellDisplay(cell)
    if (d !== '') parts.push(cell.r + ':' + cell.c + '=' + d)
  }
  parts.sort()
  return [
    pivot.range, pivot.rowField, pivot.colField, pivot.valueField, pivot.agg,
    parts.join(','),
  ].join('|')
}
