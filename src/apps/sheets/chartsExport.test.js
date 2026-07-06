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
})
