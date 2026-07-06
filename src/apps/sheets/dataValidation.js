/**
 * src/apps/sheets/dataValidation.js
 *
 * Pure helpers for per-cell data validation (dropdown lists + number-range
 * rules), backed by Fortune Sheet's native `sheet.dataVerification` map.
 *
 * Fortune Sheet stores validation per sheet as an object keyed by "row_col"
 * (0-indexed), whose values follow its DataRegulationProps shape. When present
 * the library renders the dropdown affordance and enforces `prohibitInput`
 * automatically — so we only have to produce well-formed rule objects and merge
 * them into the sheet. We deliberately do NOT touch cell values here, so this
 * feature never interferes with the CRDT grid-sync path (which tracks cell
 * strings, not this metadata).
 */

// Human-facing rule kinds → the native `type` / `type2` pair Fortune Sheet uses
// in validateCellData(). We keep the surface small and Sheets-like.
export const VALIDATION_KINDS = [
  { value: 'dropdown', label: 'Dropdown (list of items)' },
  { value: 'number',   label: 'Number' },
]

// number sub-conditions → native type2 tokens.
export const NUMBER_CONDITIONS = [
  { value: 'between',            label: 'between',                 needs: 2 },
  { value: 'notBetween',         label: 'not between',             needs: 2 },
  { value: 'equal',              label: 'is equal to',             needs: 1 },
  { value: 'notEqualTo',         label: 'is not equal to',         needs: 1 },
  { value: 'moreThanThe',        label: 'greater than',            needs: 1 },
  { value: 'lessThan',           label: 'less than',               needs: 1 },
  { value: 'greaterOrEqualTo',   label: 'greater than or equal',   needs: 1 },
  { value: 'lessThanOrEqualTo',  label: 'less than or equal',      needs: 1 },
]

export function numberConditionArity(type2) {
  const c = NUMBER_CONDITIONS.find((x) => x.value === type2)
  return c ? c.needs : 1
}

/**
 * dropdownItems — split a comma-separated option string into a clean list.
 * Mirrors how Fortune Sheet's getDropdownList treats a literal (non-range)
 * value1: trims, drops empties, de-duplicates while preserving order.
 */
export function dropdownItems(value1) {
  if (!value1) return []
  const seen = new Set()
  const out = []
  for (const raw of String(value1).split(',')) {
    const item = raw.trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * buildRegulation — produce a native DataRegulationProps object from our
 * simplified form. Returns null when the form can't yield a usable rule (so the
 * caller can surface a validation error rather than write junk).
 */
export function buildRegulation(form) {
  if (!form) return null
  if (form.kind === 'dropdown') {
    const items = dropdownItems(form.items)
    if (items.length === 0) return null
    return {
      type: 'dropdown',
      type2: form.allowMulti ? 'true' : '',
      rangeTxt: '',
      value1: items.join(','),
      value2: '',
      validity: '',
      remote: false,
      prohibitInput: !!form.rejectInvalid,
      hintShow: !!form.hint,
      hintValue: form.hint || '',
    }
  }
  if (form.kind === 'number') {
    const needs = numberConditionArity(form.condition)
    const v1 = String(form.value1 ?? '').trim()
    const v2 = String(form.value2 ?? '').trim()
    if (v1 === '' || !isFinite(Number(v1))) return null
    if (needs === 2 && (v2 === '' || !isFinite(Number(v2)))) return null
    return {
      type: 'number',
      type2: form.condition,
      rangeTxt: '',
      value1: v1,
      value2: needs === 2 ? v2 : '',
      validity: '',
      remote: false,
      prohibitInput: !!form.rejectInvalid,
      hintShow: !!form.hint,
      hintValue: form.hint || '',
    }
  }
  return null
}

/**
 * validationSummary — one-line human description of a stored regulation, for
 * the rule list. Never throws on partial data.
 */
export function validationSummary(reg) {
  if (!reg) return ''
  if (reg.type === 'dropdown') {
    const n = dropdownItems(reg.value1).length
    return `Dropdown · ${n} item${n === 1 ? '' : 's'}${reg.type2 === 'true' ? ' · multi' : ''}`
  }
  if (reg.type === 'number' || reg.type === 'number_integer' || reg.type === 'number_decimal') {
    const cond = NUMBER_CONDITIONS.find((c) => c.value === reg.type2)
    const label = cond ? cond.label : reg.type2
    const tail = numberConditionArity(reg.type2) === 2
      ? `${reg.value1} and ${reg.value2}`
      : reg.value1
    return `Number ${label} ${tail}`
  }
  return reg.type || 'Rule'
}

/**
 * cellKeysForRange — enumerate "row_col" keys covered by an inclusive 0-indexed
 * rectangle. Guards against absurd sizes so a stray whole-sheet range can't
 * lock the tab up building millions of keys.
 */
export function cellKeysForRange(rowRange, colRange, cap = 20000) {
  const [r0, r1] = rowRange
  const [c0, c1] = colRange
  const keys = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      keys.push(`${r}_${c}`)
      if (keys.length >= cap) return keys
    }
  }
  return keys
}

/**
 * applyValidation — merge a regulation across every cell in `rangeText` on the
 * first sheet, returning a new workbook array (immutable). Removing = pass
 * regulation=null to clear those keys.
 *
 * `parseRangeFn` is injected (the A1-notation parser already lives in
 * ConditionalFormatPanel) to avoid duplicating that logic.
 */
export function applyValidation(data, rangeText, regulation, parseRangeFn) {
  const parsed = parseRangeFn(rangeText)?.[0]
  if (!parsed) return data
  const keys = cellKeysForRange(parsed.row, parsed.column)
  return data.map((sheet, idx) => {
    if (idx !== 0) return sheet
    const dv = { ...(sheet.dataVerification || {}) }
    for (const k of keys) {
      if (regulation) dv[k] = { ...regulation }
      else delete dv[k]
    }
    return { ...sheet, dataVerification: dv }
  })
}

/**
 * listValidationRules — collapse the per-cell dataVerification map into a
 * deduplicated, human-readable list of distinct rules (one entry per unique
 * regulation), each with the set of cell keys it covers. This is what the panel
 * shows, so a rule applied to A1:A10 reads as a single row, not ten.
 */
export function listValidationRules(sheet) {
  const dv = sheet?.dataVerification || {}
  const groups = new Map()
  for (const [key, reg] of Object.entries(dv)) {
    if (!reg) continue
    const sig = JSON.stringify([reg.type, reg.type2, reg.value1, reg.value2])
    if (!groups.has(sig)) groups.set(sig, { reg, keys: [] })
    groups.get(sig).keys.push(key)
  }
  return [...groups.values()].map(({ reg, keys }) => ({
    reg,
    keys,
    summary: validationSummary(reg),
    count: keys.length,
  }))
}
