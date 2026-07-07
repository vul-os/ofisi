/**
 * chartSvg.test.jsx (WAVE-54)
 *
 * Renders ChartSvg with a hostile cell label and asserts it reaches the DOM as
 * ESCAPED TEXT inside an SVG <text> node — never as a live <script> element.
 * This is the on-screen half of the security contract (charts.test.js covers the
 * data half). Confirms the renderer uses no innerHTML.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ChartSvg } from './ChartSvg.jsx'
import { makeChart } from './charts.js'

function sheetWith(cells) {
  return {
    name: 'S',
    celldata: Object.entries(cells).map(([k, v]) => {
      const [r, c] = k.split('_').map(Number)
      return { r, c, v: { v, m: String(v), ct: { fa: 'General' } } }
    }),
  }
}

describe('ChartSvg escaping', () => {
  it('renders a <script> cell label as inert text, not a script element', () => {
    const sheet = sheetWith({
      '0_0': 'Cat', '0_1': '<script>window.__pwned=1</script>',
      '1_0': 'x', '1_1': 5,
    })
    const chart = makeChart({ range: 'A1:B2', title: '<img src=x onerror=alert(1)>', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={260} />)

    // No live script/img element was created from the untrusted strings.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(window.__pwned).toBeUndefined()

    // The title text is present but only as text content of an SVG <text>.
    const text = container.textContent || ''
    expect(text).toContain('<img src=x onerror=alert(1)>')
    // It's an <svg>, and every drawn label lives in a <text> node.
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('renders an empty-range chart without throwing', () => {
    const chart = makeChart({ range: 'A1:B2' })
    const { container } = render(<ChartSvg chart={chart} sheet={sheetWith({})} width={300} height={200} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.textContent).toContain('No data')
  })

  it('renders each chart type without error', () => {
    const sheet = sheetWith({ '0_1': 'V', '1_0': 'a', '1_1': 3, '2_0': 'b', '2_1': 7 })
    // WAVE-63: scatter/combo/bubble added.
    for (const type of ['column', 'bar', 'line', 'area', 'pie', 'scatter', 'combo', 'bubble']) {
      const chart = makeChart({ type, range: 'A1:B3', options: { headerRow: true, headerCol: true } })
      const { container, unmount } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
      expect(container.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })

  // WAVE-63: scatter/bubble plot numeric X/Y (and size) columns as points.
  it('renders scatter and bubble as <circle> points, no innerHTML', () => {
    // 3 numeric columns: X, Y, Size — headerCol off so col 0 is X, not labels.
    const sheet = sheetWith({
      '0_0': 'X', '0_1': 'Y', '0_2': 'Size',
      '1_0': 1, '1_1': 10, '1_2': 5,
      '2_0': 2, '2_1': 20, '2_2': 15,
      '3_0': 3, '3_1': 15, '3_2': 8,
    })
    for (const type of ['scatter', 'bubble']) {
      const chart = makeChart({ type, range: 'A1:C4', options: { headerRow: true, headerCol: false } })
      const { container, unmount } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
      expect(container.querySelector('circle')).toBeTruthy() // points drawn
      expect(container.querySelector('script')).toBeNull()
      unmount()
    }
  })

  it('combo draws both a <rect> (bars) and a <path> (line)', () => {
    const sheet = sheetWith({
      '0_0': 'Cat', '0_1': 'Bars', '0_2': 'Line',
      '1_0': 'a', '1_1': 5, '1_2': 3,
      '2_0': 'b', '2_1': 8, '2_2': 6,
    })
    const chart = makeChart({ type: 'combo', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
    expect(container.querySelector('rect')).toBeTruthy() // series[0] bars
    expect(container.querySelector('path')).toBeTruthy() // series[1] line
  })

  // WAVE-55 regression: a HOSTILE chart descriptor from a CRDT peer — non-string
  // title (object), non-finite geometry, unknown/huge type, foreignObject-shaped
  // string — must render safely once it passes through makeChart (the ingress
  // sanitiser SheetsEditor now applies). Before the fix a non-string title threw
  // "Objects are not valid as a React child" (remote-triggered crash / DoS).
  it('renders a makeChart-sanitised hostile peer descriptor without crashing', () => {
    const sheet = sheetWith({ '0_0': 'Cat', '0_1': 'V', '1_0': 'a', '1_1': 3 })
    const hostile = {
      id: 'evil',
      type: '__proto__',                       // unknown → falls back to 'column'
      range: 'A1:B2',
      title: { toString: () => '<foreignObject><script>window.__pwned=1</script></foreignObject>' },
      options: { xAxisLabel: {}, yAxisLabel: [], legend: 'yes', headerRow: true, headerCol: true },
      x: NaN, y: Infinity, w: -1e9, h: 'not-a-number',
    }
    const safe = makeChart(hostile)
    // makeChart coerces/clamps fail-closed.
    expect(safe.type).toBe('column')
    expect(typeof safe.title).toBe('string')   // object title coerced to '' (not [object])
    expect(Number.isFinite(safe.x) && Number.isFinite(safe.y)).toBe(true)
    expect(Number.isFinite(safe.w) && Number.isFinite(safe.h)).toBe(true)

    const { container } = render(<ChartSvg chart={safe} sheet={sheet} width={360} height={240} />)
    // No live element was ever created; no foreignObject; no script executed.
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('foreignObject')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(window.__pwned).toBeUndefined()
  })
})
