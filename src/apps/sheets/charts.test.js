/**
 * charts.test.js (WAVE-54)
 * Pure-model tests: insert from range, reactivity to a cell change, untrusted
 * label escaping (no injection), and immutable delete.
 */
import { describe, it, expect } from 'vitest'
import {
  makeChart, insertChart, updateChart, deleteChart, getCharts,
  extractChartData, chartValuesSignature, escapeChartText, chartAccessibleSummary,
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
