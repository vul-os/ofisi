/**
 * src/apps/sheets/colorScales.js  (WAVE-63 — CF color scales + data bars)
 *
 * Conditional-formatting COLOR SCALES and DATA BARS as a reactive, plain-data
 * overlay — the same discipline as the WAVE-54 charts and WAVE-63 pivots.
 *
 * Fortune-Sheet ships a native `dataBar`/`colorGradation` code path, but it is
 * buggy (its min/max scan requires the cell value to be nil; its gradient reads
 * `format` as both an object and an array) and hard to drive safely. So we
 * compute these ourselves from the current cell values and render them as an
 * overlay we control — giving us correct output AND full ownership of the CRDT
 * ingress validation.
 *
 * A rule is PLAIN STRUCTURED DATA stored on the first sheet as
 * `sheet.colorScales` (an array):
 *
 *   {
 *     id:    string,
 *     kind:  'colorScale2' | 'colorScale3' | 'dataBar',
 *     range: 'A1:A10',                 // A1 source range (untrusted text)
 *     min:   '#f8696b',                // hex colours (validated)
 *     mid:   '#ffeb84',                // colorScale3 only
 *     max:   '#63be7b',
 *     barColor: '#638ec6',             // dataBar only
 *   }
 *
 * computeColorScale reads the range's numeric values every time they change and
 * returns a plain `{ "r_c": { bg } | { bar: { pct, color, negative } } }` map
 * the overlay paints. Reactive: the overlay memoises on a values signature so a
 * rule only recomputes when ITS cells change.
 *
 * SECURITY: every colour is validated to a strict `#rgb`/`#rrggbb` hex (an
 * unknown/hostile value is dropped to a safe default) so a rule can never inject
 * a `url(...)`/`expression(...)`/`javascript:` value into a style. Ranges are
 * bounded. Nothing here evals, builds HTML, or fetches. The overlay paints
 * background colours / bar widths only — never cell text — so untrusted cell
 * content is never rendered by this path at all.
 */

export const CS_KINDS = ['colorScale2', 'colorScale3', 'dataBar']
const CS_KIND_SET = new Set(CS_KINDS)

// Safe defaults (Excel-ish).
const DEF = {
  min: '#f8696b',   // red
  mid: '#ffeb84',   // yellow
  max: '#63be7b',   // green
  barColor: '#638ec6',
}

const MAX_CELLS = 100000 // hard ceiling on a rule's scanned area

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** Validate a hex colour; return the fallback (default safe colour) if invalid. */
export function safeColor(v, fallback = '#000000') {
  if (typeof v === 'string' && HEX_RE.test(v.trim())) return v.trim().toLowerCase()
  return fallback
}

let _seq = 0
export function newColorScaleId() {
  _seq = (_seq + 1) % 1e6
  return 'cs_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * makeColorScale — construct a well-formed rule with defaults, clamping every
 * field. Unknown kind → 'colorScale2'. Colours forced to valid hex. This is the
 * fail-closed ingress clamp: run it on any peer-supplied rule.
 */
export function makeColorScale(partial = {}) {
  const kind = CS_KIND_SET.has(partial.kind) ? partial.kind : 'colorScale2'
  return {
    id:       typeof partial.id === 'string' && partial.id ? partial.id : newColorScaleId(),
    kind,
    range:    typeof partial.range === 'string' ? partial.range.trim().toUpperCase().slice(0, 40) : '',
    min:      safeColor(partial.min, DEF.min),
    mid:      safeColor(partial.mid, DEF.mid),
    max:      safeColor(partial.max, DEF.max),
    barColor: safeColor(partial.barColor, DEF.barColor),
  }
}

export function getColorScales(data) {
  const arr = data?.[0]?.colorScales
  return Array.isArray(arr) ? arr : []
}

export function setColorScales(data, rules) {
  return (data || []).map((sheet, idx) =>
    idx === 0 ? { ...sheet, colorScales: Array.isArray(rules) ? rules : [] } : sheet
  )
}

export function insertColorScale(data, rule) {
  return setColorScales(data, [...getColorScales(data), makeColorScale(rule)])
}

export function updateColorScale(data, id, patch) {
  const next = getColorScales(data).map((r) => (r.id === id ? makeColorScale({ ...r, ...patch }) : r))
  return setColorScales(data, next)
}

export function deleteColorScale(data, id) {
  return setColorScales(data, getColorScales(data).filter((r) => r.id !== id))
}

export function clampColorScales(data) {
  const rules = getColorScales(data)
  if (!rules.length) return data
  return setColorScales(data, rules.map((r) => makeColorScale(r)))
}

// Preserve across FortuneSheet onChange (app-owned overlay, dropped by onChange).
export function colorScalesBySheetId(data) {
  const map = new Map()
  ;(data || []).forEach((sheet, idx) => {
    if (Array.isArray(sheet?.colorScales) && sheet.colorScales.length) {
      map.set(sheet?.id ?? `#${idx}`, sheet.colorScales)
    }
  })
  return map
}
export function mergeColorScales(nextData, map) {
  if (!map || map.size === 0) return nextData
  return (nextData || []).map((sheet, idx) => {
    const key = sheet?.id ?? `#${idx}`
    const preserved = map.get(key) ?? (idx === 0 ? map.values().next().value : undefined)
    if (Array.isArray(sheet?.colorScales) && sheet.colorScales.length) return sheet
    if (preserved && preserved.length) return { ...sheet, colorScales: preserved }
    return sheet
  })
}

// ── range parsing (local, bounded) ───────────────────────────────────────────
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
export function parseBounds(range) {
  const parts = String(range || '').trim().toUpperCase().split(':')
  if (parts.length === 1) {
    const a = parseA1(parts[0]); if (!a) return null
    return { r0: a.r, r1: a.r, c0: a.c, c1: a.c }
  }
  const a = parseA1(parts[0]), b = parseA1(parts[1])
  if (!a || !b) return null
  return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) }
}

function cellNumber(cell) {
  const v = cell?.v
  let d
  if (v === null || v === undefined) return NaN
  if (typeof v === 'object') d = v.v !== undefined && v.v !== null ? v.v : v.m
  else d = v
  if (typeof d === 'number') return d
  if (typeof d === 'string' && d.trim() !== '') {
    const s = d.trim()
    const isPct = /%\s*$/.test(s)
    // Strip currency/grouping/whitespace (and the trailing %), then SCALE a
    // percentage string by 1/100 so "50%" reads as 0.5 — otherwise a percent
    // cell would be read 100× too large and distort the whole gradient/bar scale.
    const n = Number(s.replace(/[$,%\s]/g, ''))
    if (!isFinite(n)) return NaN
    return isPct ? n / 100 : n
  }
  return NaN
}

// Linear interpolate two hex colours; t in [0,1].
function lerpHex(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b)
  const r = Math.round(pa.r + (pb.r - pa.r) * t)
  const g = Math.round(pa.g + (pb.g - pa.g) * t)
  const bl = Math.round(pa.b + (pb.b - pa.b) * t)
  return `rgb(${r}, ${g}, ${bl})`
}
function hexToRgb(hex) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((x) => x + x).join('')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

/**
 * computeColorScale — turn a rule + the current sheet cells into a plain map
 * keyed `"r_c"` describing what to paint for each cell in the range:
 *   colorScale → { bg: 'rgb(...)' }
 *   dataBar    → { bar: { pct: 0..1, color, negative: bool } }
 * Reactive core: recompute whenever the range's values change. Bounded by
 * MAX_CELLS. Returns {} when the range is invalid or has no numeric values.
 */
export function computeColorScale(rule, sheet) {
  const b = parseBounds(rule?.range)
  if (!b) return {}
  const idx = new Map()
  let usedR = -1, usedC = -1
  for (const cell of sheet?.celldata || []) {
    idx.set(cell.r + ',' + cell.c, cell)
    if (cell.r > usedR) usedR = cell.r
    if (cell.c > usedC) usedC = cell.c
  }
  const r1 = Math.min(b.r1, Math.max(usedR, b.r0))
  const c1 = Math.min(b.c1, Math.max(usedC, b.c0))
  if ((r1 - b.r0 + 1) * (c1 - b.c0 + 1) > MAX_CELLS) return {}

  // First pass: collect numeric values + min/max.
  const nums = []
  let min = Infinity, max = -Infinity
  for (let r = b.r0; r <= r1; r++) {
    for (let c = b.c0; c <= c1; c++) {
      const n = cellNumber(idx.get(r + ',' + c))
      if (!Number.isNaN(n)) { nums.push({ r, c, n }); if (n < min) min = n; if (n > max) max = n }
    }
  }
  if (nums.length === 0 || !isFinite(min) || !isFinite(max)) return {}

  const out = {}
  if (rule.kind === 'dataBar') {
    const color = safeColor(rule.barColor, DEF.barColor)
    // Bars are proportional to |value| against the larger magnitude of min/max,
    // so a mix of +/- values scales sensibly. Negative values paint left.
    const scale = Math.max(Math.abs(min), Math.abs(max)) || 1
    for (const { r, c, n } of nums) {
      out[r + '_' + c] = { bar: { pct: Math.min(1, Math.abs(n) / scale), color, negative: n < 0 } }
    }
    return out
  }

  // Color scales. 2-colour = min→max; 3-colour = min→mid→max around the midpoint.
  const three = rule.kind === 'colorScale3'
  const mid = (min + max) / 2
  const cMin = safeColor(rule.min, DEF.min)
  const cMid = safeColor(rule.mid, DEF.mid)
  const cMax = safeColor(rule.max, DEF.max)
  for (const { r, c, n } of nums) {
    let bg
    if (max === min) {
      bg = three ? lerpHex(cMin, cMax, 0.5) : cMin
    } else if (three) {
      if (n <= mid) {
        const t = mid === min ? 0 : (n - min) / (mid - min)
        bg = lerpHex(cMin, cMid, t)
      } else {
        const t = max === mid ? 1 : (n - mid) / (max - mid)
        bg = lerpHex(cMid, cMax, t)
      }
    } else {
      bg = lerpHex(cMin, cMax, (n - min) / (max - min))
    }
    out[r + '_' + c] = { bg }
  }
  return out
}

/**
 * colorScaleSignature — cheap fingerprint of exactly the cells a rule depends on
 * plus its own config, so the overlay only recomputes when they change.
 */
export function colorScaleSignature(rule, sheet) {
  const b = parseBounds(rule?.range)
  if (!b) return rule.id + '|invalid'
  const parts = []
  for (const cell of sheet?.celldata || []) {
    if (cell.r < b.r0 || cell.r > b.r1 || cell.c < b.c0 || cell.c > b.c1) continue
    const n = cellNumber(cell)
    if (!Number.isNaN(n)) parts.push(cell.r + ':' + cell.c + '=' + n)
  }
  parts.sort()
  return [rule.kind, rule.range, rule.min, rule.mid, rule.max, rule.barColor, parts.join(',')].join('|')
}

/** Merge all rules' compute maps into one paint map (later rules win on overlap). */
export function computeAllColorScales(rules, sheet) {
  const merged = {}
  for (const rule of rules || []) {
    const m = computeColorScale(rule, sheet)
    for (const k in m) merged[k] = m[k]
  }
  return merged
}

// rgb(...) string → #rrggbb hex (for cellColor which FS renders on the canvas).
function rgbToHex(rgb) {
  const m = String(rgb).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return '#000000'
  const h = (n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
  return '#' + h(m[1]) + h(m[2]) + h(m[3])
}

const NATIVE_BANDS = 12 // gradient resolution for the native banded rendering

/**
 * toNativeConditionFormat — convert ONE color-scale/data-bar rule into a set of
 * FortuneSheet-native `between` conditionformat rules (conditionName 'between',
 * format.cellColor) that render on the FS CANVAS. This is how color scales are
 * actually painted in the grid: FS renders on a canvas (no DOM cells to overlay),
 * and its built-in `colorGradation`/`dataBar` compute is buggy — but its
 * `between` cell-colour path is sound. We slice the rule's value domain into
 * NATIVE_BANDS buckets, colour each bucket with the interpolated gradient colour
 * (data bars → an intensity ramp of the bar colour), and emit a `between` rule
 * per bucket over the same range. Returns [] when the range has no numeric data.
 *
 * SECURITY: the emitted cellColor is always a `#rrggbb` derived from our own
 * validated palette (never a cell-derived string), and conditionValue is numeric
 * — so a rule can't inject a hostile colour or value into FS's model.
 */
export function toNativeConditionFormat(rule, sheet, parseRangeFS) {
  const b = parseBounds(rule?.range)
  if (!b) return []
  const idx = new Map()
  for (const cell of sheet?.celldata || []) idx.set(cell.r + ',' + cell.c, cell)
  let min = Infinity, max = -Infinity, any = false
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const n = cellNumber(idx.get(r + ',' + c))
      if (!Number.isNaN(n)) { any = true; if (n < min) min = n; if (n > max) max = n }
    }
  }
  if (!any || !isFinite(min) || !isFinite(max)) return []
  const cellrange = typeof parseRangeFS === 'function'
    ? parseRangeFS(rule.range)
    : [{ row: [b.r0, b.r1], column: [b.c0, b.c1] }]

  const span = max - min || 1
  const isBar = rule.kind === 'dataBar'
  const three = rule.kind === 'colorScale3'
  const cMin = safeColor(rule.min, DEF.min)
  const cMid = safeColor(rule.mid, DEF.mid)
  const cMax = safeColor(rule.max, DEF.max)
  const barCol = safeColor(rule.barColor, DEF.barColor)

  // FortuneSheet's `between` is inclusive on BOTH ends, so adjacent bands that
  // shared a boundary would double-match a value sitting exactly on it (the
  // common case for integer data). We make the bands half-open by nudging every
  // band's lower bound (except the first) up by a tiny epsilon of the span, so a
  // boundary value falls in exactly one band and gets the intended colour.
  const eps = span * 1e-9
  const out = []
  for (let i = 0; i < NATIVE_BANDS; i++) {
    const t0 = i / NATIVE_BANDS
    const t1 = (i + 1) / NATIVE_BANDS
    const lo = i === 0 ? min : min + span * t0 + eps
    const hi = i === NATIVE_BANDS - 1 ? max : min + span * t1
    const mt = (t0 + t1) / 2 // colour sampled at the band centre
    let color
    if (isBar) {
      // Approximate a data bar with an intensity ramp: lighter → the bar colour.
      color = rgbToHex(lerpHex('#ffffff', barCol, mt))
    } else if (three) {
      color = mt <= 0.5 ? rgbToHex(lerpHex(cMin, cMid, mt / 0.5)) : rgbToHex(lerpHex(cMid, cMax, (mt - 0.5) / 0.5))
    } else {
      color = rgbToHex(lerpHex(cMin, cMax, mt))
    }
    out.push({
      type: 'default',
      conditionName: 'between',
      cellrange,
      conditionRange: cellrange,
      conditionValue: [lo, hi],
      format: { cellColor: color, textColor: '' },
    })
  }
  return out
}

/**
 * buildNativeConditionFormat — merge the app's native CF rules
 * (luckysheet_conditionformat_save the user set) with the banded rules derived
 * from every color-scale/data-bar rule, so both render on the canvas together.
 * The color-scale bands go FIRST so an explicit user rule (added later) wins.
 */
export function buildNativeConditionFormat(sheet, parseRangeFS) {
  const userRules = Array.isArray(sheet?.luckysheet_conditionformat_save)
    ? sheet.luckysheet_conditionformat_save.filter((r) => !r?.__fromColorScale)
    : []
  const scales = Array.isArray(sheet?.colorScales) ? sheet.colorScales : []
  const derived = []
  for (const rule of scales) {
    for (const nat of toNativeConditionFormat(rule, sheet, parseRangeFS)) {
      derived.push({ ...nat, __fromColorScale: true })
    }
  }
  return [...derived, ...userRules]
}
