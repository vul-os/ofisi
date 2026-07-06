/**
 * chartsExport.test.js (WAVE-54)
 *
 * Export fidelity (honest): charts do NOT round-trip as native Excel charts (we
 * add no heavy OOXML-chart lib), but their DEFINITIONS survive as a metadata
 * worksheet. CSV cannot carry charts and omits them. These tests pin that
 * contract so it can't silently regress.
 */
import { describe, it, expect } from 'vitest'
import { chartsMetaSheet } from './sheetsExport.js'
import * as XLSX from 'xlsx'
import { insertChart } from './charts.js'

function wb() { return [{ name: 'Sheet1', celldata: [], config: {} }] }

describe('chart export metadata', () => {
  it('returns null when there are no charts (no stray sheet emitted)', () => {
    expect(chartsMetaSheet(wb())).toBeNull()
  })

  it('serialises each chart definition to a metadata worksheet', () => {
    let data = insertChart(wb(), { id: 'c1', type: 'column', range: 'A1:B3', title: 'Rev', options: { legend: false, headerRow: true, headerCol: true } })
    data = insertChart(data, { id: 'c2', type: 'pie', range: 'D1:E4', title: 'Split' })
    const ws = chartsMetaSheet(data)
    expect(ws).toBeTruthy()
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
    expect(rows[0]).toEqual(['type', 'range', 'title', 'xAxisLabel', 'yAxisLabel', 'legend', 'headerRow', 'headerCol'])
    expect(rows[1][0]).toBe('column')
    expect(rows[1][1]).toBe('A1:B3')
    expect(rows[1][2]).toBe('Rev')
    expect(rows[1][5]).toBe('no')   // legend:false
    expect(rows[2][0]).toBe('pie')
    expect(rows[2][2]).toBe('Split')
  })

  // WAVE-55 regression: a chart title/label containing a leading formula trigger
  // (from cell data or a hostile peer) must be neutralised before it is written
  // into the exported worksheet, or Excel would evaluate it as a live formula
  // (CSV/formula injection). escapeChartText prefixes a quote.
  it('neutralises formula-injection in exported title / axis labels', () => {
    let data = insertChart(wb(), {
      id: 'c1', type: 'column', range: 'A1:B3',
      title: '=HYPERLINK("http://evil","click")',
      options: { xAxisLabel: '+SUM(1)', yAxisLabel: '@cmd', legend: true, headerRow: true, headerCol: true },
    })
    const ws = chartsMetaSheet(data)
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
    // Every free-text field is quoted so it renders as a literal glyph, not a formula.
    expect(rows[1][2].startsWith("'=")).toBe(true)   // title
    expect(rows[1][3].startsWith("'+")).toBe(true)   // xAxisLabel
    expect(rows[1][4].startsWith("'@")).toBe(true)   // yAxisLabel
    // And the raw formula string is NOT present verbatim as a leading-= cell.
    expect(rows[1][2].startsWith('=')).toBe(false)
  })
})
