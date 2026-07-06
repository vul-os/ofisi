/**
 * charts.test.js (WAVE-54)
 * Pure-model tests: insert from range, reactivity to a cell change, untrusted
 * label escaping (no injection), and immutable delete.
 */
import { describe, it, expect } from 'vitest'
import {
  makeChart, insertChart, updateChart, deleteChart, getCharts,
  extractChartData, chartValuesSignature, escapeChartText, chartAccessibleSummary,
  chartsBySheetId, mergeCharts, clampCharts,
} from './charts.js'

// Build a FortuneSheet-style workbook with the given cell display values.
// cells: { "r_c": value }
function wb(cells = {}) {
  const celldata = Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number)
    return { r, c, v: { v, m: String(v), ct: { fa: 'General', t: typeof v === 'number' ? 'n' : 'g' } } }
  })
  return [{ name: 'Sheet1', celldata, config: {} }]
}

describe('chart model', () => {
  it('makeChart clamps type and geometry, always returns plain data', () => {
    const c = makeChart({ type: 'evil', x: -999, w: 1e9, title: 'x' })
    expect(c.type).toBe('column')          // unknown → default
    expect(c.x).toBe(0)                     // clamped to lower bound
    expect(c.w).toBe(4000)                  // clamped to upper bound
    expect(typeof c.id).toBe('string')
    expect(JSON.parse(JSON.stringify(c))).toEqual(c) // serialisable = CRDT-safe
  })

  // WAVE-55: makeChart is the CRDT-ingress sanitiser (SheetsEditor runs every
  // peer-supplied descriptor through it before merge). Pin the fail-closed
  // coercion of the fields a hostile peer could weaponise: a non-string title
  // (→ React-child crash), non-finite geometry (→ NaN layout / render escape),
  // and non-string axis labels. All must become safe plain data.
  it('makeChart sanitises a hostile peer descriptor fail-closed (CRDT ingress)', () => {
    const c = makeChart({
      id: 'evil', type: '__proto__',
      title: { toString: () => 'boom' },        // object title → ''
      options: { xAxisLabel: {}, yAxisLabel: [], legend: 'yes' },
      x: NaN, y: Infinity, w: -1e9, h: 'nope',
    })
    expect(c.type).toBe('column')               // unknown type → default
    expect(c.title).toBe('')                    // non-string title coerced away
    expect(c.options.xAxisLabel).toBe('')       // non-string label coerced away
    expect(c.options.yAxisLabel).toBe('')
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    expect(Number.isFinite(c.w) && Number.isFinite(c.h)).toBe(true)
    expect(c.w).toBeGreaterThanOrEqual(160)     // clamped to sane bounds
    expect(c.h).toBeGreaterThanOrEqual(120)
    expect(c.id).toBe('evil')                   // valid string id preserved (LWW key)
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)  // pure serialisable data
  })

  it('inserts a chart from a selected range onto sheet.charts', () => {
    const data = wb({ '0_0': 'Q', '0_1': 'Sales', '1_0': 'A', '1_1': 10, '2_0': 'B', '2_1': 20 })
    const next = insertChart(data, { type: 'column', range: 'A1:B3', title: 'My chart' })
    const charts = getCharts(next)
    expect(charts).toHaveLength(1)
    expect(charts[0].range).toBe('A1:B3')
    expect(charts[0].title).toBe('My chart')
    // immutable
    expect(getCharts(data)).toHaveLength(0)
  })
})

describe('extractChartData', () => {
  it('extracts categories + numeric series with headers', () => {
    const data = wb({
      '0_0': 'Region', '0_1': 'Sales',
      '1_0': 'North', '1_1': 10,
      '2_0': 'South', '2_1': 25,
    })
    const chart = makeChart({ range: 'A1:B3', headerRow: true, headerCol: true, options: { headerRow: true, headerCol: true } })
    const out = extractChartData(chart, data[0])
    expect(out.categories).toEqual(['North', 'South'])
    expect(out.series).toHaveLength(1)
    expect(out.series[0].name).toBe('Sales')
    expect(out.series[0].values).toEqual([10, 25])
    expect(out.empty).toBe(false)
  })

  it('is reactive: changing a source cell changes extracted values + signature', () => {
    const chart = makeChart({ range: 'A1:B3', options: { headerRow: true, headerCol: true } })
    const before = wb({ '0_1': 'Sales', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20 })
    const after  = wb({ '0_1': 'Sales', '1_0': 'N', '1_1': 99, '2_0': 'S', '2_1': 20 })
    const sigBefore = chartValuesSignature(chart, before[0])
    const sigAfter  = chartValuesSignature(chart, after[0])
    expect(sigBefore).not.toBe(sigAfter)
    expect(extractChartData(chart, before[0]).series[0].values).toEqual([10, 20])
    expect(extractChartData(chart, after[0]).series[0].values).toEqual([99, 20])
  })

  it('signature does NOT change when an out-of-range cell changes (perf memo)', () => {
    const chart = makeChart({ range: 'A1:B3', options: { headerRow: true, headerCol: true } })
    const base   = wb({ '0_1': 'S', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20 })
    const offRng = wb({ '0_1': 'S', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20, '50_50': 'far away' })
    expect(chartValuesSignature(chart, base[0])).toBe(chartValuesSignature(chart, offRng[0]))
  })

  it('coerces non-numeric cells to 0 and marks all-zero as empty', () => {
    const chart = makeChart({ range: 'A1:B2', options: { headerRow: false, headerCol: false } })
    const data = wb({ '0_0': 'x', '0_1': 'y', '1_0': 'p', '1_1': 'q' })
    const out = extractChartData(chart, data[0])
    expect(out.empty).toBe(true)
  })
})

describe('security — untrusted cell labels never inject', () => {
  it('escapeChartText neutralises formula triggers and strips markup-as-text', () => {
    expect(escapeChartText('=HYPERLINK("javascript:alert(1)","x")').startsWith("'=")).toBe(true)
    expect(escapeChartText('+SUM(1)').startsWith("'+")).toBe(true)
    expect(escapeChartText('@cmd').startsWith("'@")).toBe(true)
    // markup is returned as plain text (renderer escapes via SVG <text>);
    // escapeChartText itself does not build HTML — it just returns a string.
    const s = escapeChartText('<script>alert(1)</script>')
    expect(typeof s).toBe('string')
    expect(s).toContain('<script>')   // literal text, not stripped-to-markup
  })

  it('a <script>/=HYPERLINK cell used as a chart label stays plain data', () => {
    const data = wb({
      '0_0': 'Cat', '0_1': '<script>alert(1)</script>',
      '1_0': '=HYPERLINK("javascript:evil")', '1_1': 5,
    })
    const chart = makeChart({ range: 'A1:B2', options: { headerRow: true, headerCol: true } })
    const out = extractChartData(chart, data[0])
    // series name came from a <script> cell — it is a plain string, escaped
    expect(out.series[0].name).toContain('<script>')
    // category came from an =HYPERLINK cell — neutralised with a leading quote
    expect(out.categories[0].startsWith("'=")).toBe(true)
    // the whole extracted structure is JSON — no functions, no HTML nodes
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('accessible summary is plain text', () => {
    const data = wb({ '0_1': 'S', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20 })
    const chart = makeChart({ range: 'A1:B3', title: 'Sales', options: { headerRow: true, headerCol: true } })
    const summary = chartAccessibleSummary(chart, extractChartData(chart, data[0]))
    expect(summary).toContain('chart')
    expect(typeof summary).toBe('string')
  })
})

describe('delete / update immutability', () => {
  it('updateChart patches by id without mutating the source', () => {
    const data = insertChart(wb(), { id: 'c1', type: 'bar', range: 'A1:B2' })
    const next = updateChart(data, 'c1', { title: 'New', type: 'line' })
    expect(getCharts(next)[0].title).toBe('New')
    expect(getCharts(next)[0].type).toBe('line')
    expect(getCharts(data)[0].title).toBe('')   // original untouched
  })

  it('deleteChart removes only the target chart', () => {
    let data = insertChart(wb(), { id: 'a', range: 'A1:B2' })
    data = insertChart(data, { id: 'b', range: 'C1:D2' })
    const next = deleteChart(data, 'a')
    expect(getCharts(next).map((c) => c.id)).toEqual(['b'])
    expect(getCharts(data)).toHaveLength(2)      // original untouched
  })
})

// ── WAVE-61: chart persistence merge (the data-loss fix core) ────────────────
// FortuneSheet's onChange re-emits normalised sheet objects that DROP the
// app-owned `sheet.charts` field. chartsBySheetId snapshots the authoritative
// charts; mergeCharts re-attaches them to the normalised payload so a local
// edit never clobbers them.
describe('WAVE-61 chart persistence merge', () => {
  // A normalised FortuneSheet payload: a real onChange strips `charts` but keeps
  // sheet identity (id) + celldata.
  function normalised(cells = {}, id = 'sheet_1') {
    const [wbSheet] = wb(cells)
    return [{ ...wbSheet, id }]  // note: NO `charts` field (as FortuneSheet emits)
  }

  it('chartsBySheetId indexes the authoritative charts by sheet id', () => {
    let data = insertChart(wb({ '1_1': 10 }), { id: 'c1', range: 'A1:B2' })
    data = data.map((s, i) => (i === 0 ? { ...s, id: 'sheet_1' } : s))
    const map = chartsBySheetId(data)
    expect(map.get('sheet_1')).toHaveLength(1)
    expect(map.get('sheet_1')[0].id).toBe('c1')
  })

  it('mergeCharts re-attaches charts a normalised onChange payload dropped', () => {
    // Authoritative prior state has a chart on sheet_1.
    let prev = insertChart(wb({ '1_1': 10 }), { id: 'c1', range: 'A1:B2' })
    prev = prev.map((s, i) => (i === 0 ? { ...s, id: 'sheet_1' } : s))
    // FortuneSheet emits a normalised payload with the SAME sheet id but no charts.
    const payload = normalised({ '1_1': 42 }, 'sheet_1')
    expect(getCharts(payload)).toHaveLength(0)   // the bug: charts gone

    const merged = mergeCharts(payload, chartsBySheetId(prev))
    // Charts survive; the fresh cell edit (42) survives too.
    expect(getCharts(merged)).toHaveLength(1)
    expect(getCharts(merged)[0].id).toBe('c1')
    const cell = merged[0].celldata.find((c) => c.r === 1 && c.c === 1)
    expect(cell.v.v).toBe(42)
  })

  it('mergeCharts matches by position when the sheet id changed (index #0 fallback)', () => {
    let prev = insertChart(wb(), { id: 'c1', range: 'A1:B2' })  // no id → positional
    const payload = normalised({}, undefined) // id undefined
    const merged = mergeCharts(payload, chartsBySheetId(prev))
    expect(getCharts(merged)).toHaveLength(1)
    expect(getCharts(merged)[0].id).toBe('c1')
  })

  it('mergeCharts is a no-op when there are no authoritative charts', () => {
    const payload = normalised({ '0_0': 'x' }, 'sheet_1')
    const merged = mergeCharts(payload, chartsBySheetId(wb({ '0_0': 'x' })))
    expect(merged).toBe(payload) // empty map → returns the input untouched
  })

  it('mergeCharts does NOT override charts the payload already carries (authoritative update)', () => {
    let prev = insertChart(wb(), { id: 'old', range: 'A1:B2' })
    prev = prev.map((s, i) => (i === 0 ? { ...s, id: 'sheet_1' } : s))
    // A chart-authoritative payload (e.g. a delete leaving a different set).
    let payload = insertChart(normalised({}, 'sheet_1'), { id: 'new', range: 'C1:D2' })
    const merged = mergeCharts(payload, chartsBySheetId(prev))
    // The payload's own charts win — the previous 'old' chart is NOT re-added.
    expect(getCharts(merged).map((c) => c.id)).toEqual(['new'])
  })

  it('clampCharts re-clamps a corrupt local descriptor so render cannot see NaN', () => {
    // Simulate a corrupt persisted chart (non-finite geometry, bad type).
    const corrupt = [{ name: 'Sheet1', celldata: [], config: {}, charts: [
      { id: 'c1', type: 'evil', range: 'A1:B2', title: 't', x: NaN, y: Infinity, w: -1, h: 'x' },
    ] }]
    const fixed = clampCharts(corrupt)
    const c = getCharts(fixed)[0]
    expect(c.type).toBe('column')
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    expect(c.w).toBeGreaterThanOrEqual(160)
    expect(c.h).toBeGreaterThanOrEqual(120)
    expect(c.id).toBe('c1')
  })

  it('clampCharts leaves a well-formed chart intact + is a no-op with no charts', () => {
    const good = insertChart(wb(), { id: 'c1', type: 'bar', range: 'A1:B2' })
    expect(getCharts(clampCharts(good))[0]).toEqual(getCharts(good)[0])
    const none = wb({ '0_0': 'x' })
    expect(clampCharts(none)).toBe(none)
  })
})

// ── WAVE-62: untrusted LOAD paths must clamp a poisoned charts array ──────────
// The trusted-local mergeCharts path deliberately does NOT re-run makeChart on
// every keystroke; correctness of that shortcut RELIES on the invariant that
// every chart ENTERING sheet.charts already passed makeChart — i.e. every
// untrusted-origin load path (initial useState, api.getFile, XLSX import, AND
// draft-restore) funnels content through clampCharts. This suite pins the
// load-path clamp against a maliciously-crafted persisted document: a chart
// with an OBJECT title (→ "Objects are not valid as a React child" render
// crash) and NON-FINITE geometry (→ NaN SVG layout) — the exact wave-55 DoS
// class, reached through the load door instead of the CRDT peer door.
describe('WAVE-62 load-path clamp neutralises a poisoned saved/draft document', () => {
  // A poisoned persisted first sheet: charts array an attacker who can write the
  // file/draft JSON could craft. None of these fields passed makeChart.
  const poisoned = () => [{
    name: 'Sheet1', id: 'sheet_1', celldata: [], config: {},
    charts: [{
      id: 'evil',
      type: '__proto__',                        // not in allow-list
      range: 'A1:B2',
      title: { toString: () => 'boom' },        // OBJECT title → React-child crash
      options: { xAxisLabel: {}, legend: 'yes' },
      x: NaN, y: Infinity, w: -1e9, h: 'nope',  // non-finite geometry → NaN layout
    }],
  }]

  it('clampCharts coerces every hostile field to safe plain data', () => {
    const safe = getCharts(clampCharts(poisoned()))[0]
    expect(safe.type).toBe('column')                 // unknown type → default
    expect(typeof safe.title).toBe('string')         // object title → string
    expect(safe.title).toBe('')                       // ('' — not the object)
    expect(typeof safe.options.xAxisLabel).toBe('string')
    expect(Number.isFinite(safe.x) && Number.isFinite(safe.y)).toBe(true)
    expect(Number.isFinite(safe.w) && Number.isFinite(safe.h)).toBe(true)
    expect(safe.w).toBeGreaterThanOrEqual(160)
    expect(safe.h).toBeGreaterThanOrEqual(120)
    // Whole descriptor is now pure serialisable data — render-safe.
    expect(JSON.parse(JSON.stringify(safe))).toEqual(safe)
  })

  it('a title that is NOT a string never survives the load clamp (React-child crash guard)', () => {
    for (const badTitle of [{}, [], { toString: () => 'x' }, 42, true, null]) {
      const doc = [{ name: 'Sheet1', id: 's', celldata: [], config: {},
        charts: [{ id: 'c', type: 'bar', range: 'A1:B2', title: badTitle }] }]
      const t = getCharts(clampCharts(doc))[0].title
      expect(typeof t).toBe('string')   // ALWAYS a string → safe as a React child
    }
  })

  it('mergeCharts trusts its input — proving clamp MUST happen at load, not merge', () => {
    // Documents WHY the draft-restore path had to clamp: mergeCharts re-attaches
    // the in-memory (already-validated) charts verbatim, so if a poisoned array
    // ever reached `data` unclamped, mergeCharts would faithfully preserve the
    // poison on the next keystroke. The clamp is the load-boundary's job.
    const poison = poisoned()
    const payload = [{ name: 'Sheet1', id: 'sheet_1', celldata: [], config: {} }] // no charts
    const merged = mergeCharts(payload, chartsBySheetId(poison))
    // mergeCharts re-attaches the SAME (unvalidated) object — hence load must clamp.
    expect(getCharts(merged)[0].title).toEqual(poison[0].charts[0].title)
    // ...whereas clamping the source first yields a render-safe descriptor.
    const mergedSafe = mergeCharts(payload, chartsBySheetId(clampCharts(poison)))
    expect(typeof getCharts(mergedSafe)[0].title).toBe('string')
  })
})
