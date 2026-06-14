/**
 * speakerGrid.test.js — covers the 1/2/4/9/16/25 responsive ladder used by
 * the mesh (CallView) speaker grid.
 */
import { describe, it, expect } from 'vitest'
import { gridColumnsFor, gridLayout } from './speakerGrid.js'

describe('speakerGrid — gridColumnsFor', () => {
  it('caps to 1 column on mobile widths (≤480px)', () => {
    expect(gridColumnsFor(1, 360)).toBe(1)
    expect(gridColumnsFor(9, 360)).toBe(1)
    expect(gridColumnsFor(25, 360)).toBe(1)
  })

  it('caps to 2 columns on tablet widths (≤768px) once there are ≥2 tiles', () => {
    expect(gridColumnsFor(1, 600)).toBe(1)
    expect(gridColumnsFor(4, 600)).toBe(2)
    expect(gridColumnsFor(25, 600)).toBe(2)
  })

  it('uses the 1/2/4/9/16/25 desktop ladder', () => {
    expect(gridColumnsFor(1, 1200)).toBe(1)
    expect(gridColumnsFor(2, 1200)).toBe(2)
    expect(gridColumnsFor(4, 1200)).toBe(2)
    expect(gridColumnsFor(5, 1200)).toBe(3)
    expect(gridColumnsFor(9, 1200)).toBe(3)
    expect(gridColumnsFor(10, 1200)).toBe(4)
    expect(gridColumnsFor(16, 1200)).toBe(4)
    expect(gridColumnsFor(17, 1200)).toBe(5)
    expect(gridColumnsFor(25, 1200)).toBe(5)
  })

  it('keeps 5 columns past 25 tiles (grid just grows down)', () => {
    expect(gridColumnsFor(50, 1600)).toBe(5)
  })
})

describe('speakerGrid — gridLayout', () => {
  it('returns a Tailwind-compatible inline style', () => {
    const { cols, style } = gridLayout(9, 1200)
    expect(cols).toBe(3)
    expect(style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    expect(style.gridAutoRows).toBe('minmax(140px, 1fr)')
  })
})
