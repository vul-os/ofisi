/**
 * pivot.test.js  (WAVE-63)
 * Reactive pivot model: clamp/ingress validation, aggregation correctness,
 * live re-aggregation on source change, and CRDT-safety of the descriptor.
 */
import { describe, it, expect } from 'vitest'
import {
  makePivot, getPivots, setPivots, insertPivot, updatePivot, deletePivot,
  clampPivots, computePivot, sourceTable, pivotHeaders, pivotValuesSignature,
  pivotText, PIVOT_AGGS,
} from './pivot.js'

// Build a FortuneSheet-style sheet from a 2-D array of display values.
function sheetFrom(grid) {
  const celldata = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c]
      if (v === '' || v == null) continue
      const isNum = typeof v === 'number'
      celldata.push({ r, c, v: { v, m: String(v), ct: { fa: 'General', t: isNum ? 'n' : 's' } } })
    }
  }
  return { name: 'Sheet1', celldata, config: {} }
}

const GRID = [
  ['Region', 'Product', 'Sales'],
  ['East', 'Apple', 10],
  ['West', 'Apple', 20],
  ['East', 'Banana', 5],
  ['West', 'Banana', 15],
]

describe('makePivot — ingress clamp', () => {
  it('allow-lists agg, coerces + caps strings, normalises range', () => {
    const p = makePivot({ agg: 'EVIL', range: 'a1:d5', title: 42, rowField: 5, valueField: null })
    expect(p.agg).toBe('SUM')                 // unknown agg → default
    expect(p.range).toBe('A1:D5')             // upper-cased
    expect(p.title).toBe('')                  // non-string → ''
    expect(p.rowField).toBe('')               // non-string → ''
    expect(typeof p.id).toBe('string')
    // Serialisable = CRDT-safe.
    expect(JSON.parse(JSON.stringify(p))).toEqual(p)
  })
  it('preserves a valid id and every valid agg', () => {
    expect(makePivot({ id: 'pvt_x', agg: 'AVG' }).id).toBe('pvt_x')
    for (const a of PIVOT_AGGS) expect(makePivot({ agg: a }).agg).toBe(a)
  })
  it('caps absurdly long strings', () => {
    const p = makePivot({ title: 'x'.repeat(9999), rowField: 'y'.repeat(9999) })
    expect(p.title.length).toBeLessThanOrEqual(200)
    expect(p.rowField.length).toBeLessThanOrEqual(120)
  })
})

describe('pivotText — untrusted label safety', () => {
  it('neutralises formula/control chars', () => {
    expect(pivotText('=HYPERLINK("evil")')).toBe("'=HYPERLINK(\"evil\")")
    expect(pivotText('a\tb\nc')).toBe('a b c')
    expect(pivotText(123)).toBe('123')
  })
})

describe('immutable model ops', () => {
  it('insert / update / delete never mutate input', () => {
    const data = [sheetFrom(GRID)]
    const a = insertPivot(data, { range: 'A1:C5', rowField: 'Region', valueField: 'Sales' })
    expect(getPivots(a)).toHaveLength(1)
    expect(getPivots(data)).toHaveLength(0)
    const id = getPivots(a)[0].id
    const b = updatePivot(a, id, { agg: 'AVG' })
    expect(getPivots(b)[0].agg).toBe('AVG')
    expect(getPivots(a)[0].agg).toBe('SUM')
    const c = deletePivot(b, id)
    expect(getPivots(c)).toHaveLength(0)
  })
})

describe('computePivot — aggregation', () => {
  it('sums a value field grouped by row × column', () => {
    const sheet = sheetFrom(GRID)
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', colField: 'Product', valueField: 'Sales', agg: 'SUM' })
    const res = computePivot(pivot, sheet)
    // header: Region | Apple | Banana | Total
    expect(res[0]).toEqual(['Region', 'Apple', 'Banana', 'Total'])
    const east = res.find((r) => r[0] === 'East')
    const west = res.find((r) => r[0] === 'West')
    expect(east).toEqual(['East', 10, 5, 15])
    expect(west).toEqual(['West', 20, 15, 35])
    const total = res[res.length - 1]
    expect(total).toEqual(['Total', 30, 20, 50])
  })

  it('supports no column field (single value column)', () => {
    const sheet = sheetFrom(GRID)
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales', agg: 'SUM' })
    const res = computePivot(pivot, sheet)
    expect(res[0]).toEqual(['Region', 'Sales', 'Total'])
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 15, 15])
    expect(res.find((r) => r[0] === 'West')).toEqual(['West', 35, 35])
  })

  it('AVG / COUNT / MAX / MIN aggregations', () => {
    const sheet = sheetFrom(GRID)
    const mk = (agg) => computePivot(makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales', agg }), sheet)
    expect(mk('AVG').find((r) => r[0] === 'East')[1]).toBe(7.5)
    expect(mk('COUNT').find((r) => r[0] === 'East')[1]).toBe(2)
    expect(mk('MAX').find((r) => r[0] === 'West')[1]).toBe(20)
    expect(mk('MIN').find((r) => r[0] === 'West')[1]).toBe(15)
  })

  it('AVG ignores blank/non-numeric rows (denominator = numeric count)', () => {
    // East has 10, 5, and a blank Sales cell — AVG must be (10+5)/2 = 7.5, NOT 5.
    const grid = [
      ['Region', 'Sales'],
      ['East', 10],
      ['East', 5],
      ['East', ''],   // blank value must not count toward the average
    ]
    const res = computePivot(makePivot({ range: 'A1:B4', rowField: 'Region', valueField: 'Sales', agg: 'AVG' }), sheetFrom(grid))
    expect(res.find((r) => r[0] === 'East')[1]).toBe(7.5)
  })

  it('totals RE-AGGREGATE raw values (correct for AVG/MAX/MIN, not sum-of-subaggs)', () => {
    const sheet = sheetFrom(GRID)
    // AVG: East/Apple=10, East/Banana=5 → row total must be AVG(10,5)=7.5, not 15.
    const avg = computePivot(makePivot({ range: 'A1:C5', rowField: 'Region', colField: 'Product', valueField: 'Sales', agg: 'AVG' }), sheet)
    expect(avg.find((r) => r[0] === 'East').at(-1)).toBe(7.5)
    // grand total AVG over all four sales (10,20,5,15) = 12.5
    expect(avg.at(-1).at(-1)).toBe(12.5)
    // MAX: East row total = MAX(10,5)=10 (not 15); grand MAX = 20.
    const max = computePivot(makePivot({ range: 'A1:C5', rowField: 'Region', colField: 'Product', valueField: 'Sales', agg: 'MAX' }), sheet)
    expect(max.find((r) => r[0] === 'East').at(-1)).toBe(10)
    expect(max.at(-1).at(-1)).toBe(20)
  })

  it('returns null for missing fields / too-small source', () => {
    const sheet = sheetFrom(GRID)
    expect(computePivot(makePivot({ range: 'A1:C5', rowField: 'Nope', valueField: 'Sales' }), sheet)).toBeNull()
    expect(computePivot(makePivot({ range: 'A1:A1' }), sheet)).toBeNull()
  })
})

describe('LIVE re-aggregation (reactivity)', () => {
  it('recomputes when a source cell changes, and the signature changes with it', () => {
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales', agg: 'SUM' })
    const before = sheetFrom(GRID)
    const sigBefore = pivotValuesSignature(pivot, before)
    expect(computePivot(pivot, before).find((r) => r[0] === 'East')[1]).toBe(15)

    // Change East/Apple sales 10 → 100.
    const grid2 = GRID.map((row) => [...row])
    grid2[1][2] = 100
    const after = sheetFrom(grid2)
    const sigAfter = pivotValuesSignature(pivot, after)
    expect(sigAfter).not.toBe(sigBefore)                         // dep fingerprint moved
    expect(computePivot(pivot, after).find((r) => r[0] === 'East')[1]).toBe(105)
  })

  it('signature is stable when unrelated cells change', () => {
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales' })
    const sheet = sheetFrom(GRID)
    const sig1 = pivotValuesSignature(pivot, sheet)
    // Add a cell far outside the source range.
    const sheet2 = { ...sheet, celldata: [...sheet.celldata, { r: 99, c: 99, v: { v: 'x', m: 'x', ct: { t: 's' } } }] }
    expect(pivotValuesSignature(pivot, sheet2)).toBe(sig1)
  })
})

describe('bounds / DoS safety', () => {
  it('a pathological range only materialises the sheet\'s populated extent', () => {
    // A1:ZZ999999 over a 5×3 sheet must NOT try to build a 10M-cell table — it
    // iterates only the used extent (5 rows, 3 cols). This is the DoS bound.
    const sheet = sheetFrom(GRID)
    const pivot = makePivot({ range: 'A1:ZZ999999', rowField: 'Region', valueField: 'Sales' })
    const t0 = Date.now()
    const table = sourceTable(pivot, sheet)
    expect(Date.now() - t0).toBeLessThan(200)      // fast, not iterating millions
    expect(table.length).toBe(5)
    expect(table[0].length).toBe(3)
    // And it still aggregates correctly within that extent.
    const res = computePivot(pivot, sheet)
    expect(res.find((r) => r[0] === 'East')[1]).toBe(15)
  })
})

describe('clampPivots — defensive load clamp', () => {
  it('re-clamps corrupt local descriptors', () => {
    const data = [{ ...sheetFrom(GRID), pivots: [{ id: 'p1', agg: 'HACK', range: 'a1:c5' }] }]
    const clamped = clampPivots(data)
    expect(getPivots(clamped)[0].agg).toBe('SUM')
    expect(getPivots(clamped)[0].range).toBe('A1:C5')
  })
})

describe('pivotHeaders', () => {
  it('lists source header names', () => {
    expect(pivotHeaders(makePivot({ range: 'A1:C5' }), sheetFrom(GRID))).toEqual(['Region', 'Product', 'Sales'])
  })
})
