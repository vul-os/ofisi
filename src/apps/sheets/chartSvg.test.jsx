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
    for (const type of ['column', 'bar', 'line', 'area', 'pie']) {
      const chart = makeChart({ type, range: 'A1:B3', options: { headerRow: true, headerCol: true } })
      const { container, unmount } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
      expect(container.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })
})
