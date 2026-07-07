/**
 * src/apps/sheets/ChartSvg.jsx  (WAVE-54)
 *
 * Self-contained SVG chart renderer — NO charting library.
 *
 * Renders a chart descriptor + extracted plain data as inline SVG. Every string
 * that reaches the DOM is an SVG <text> child (React escapes it) — there is no
 * dangerouslySetInnerHTML anywhere in this file, so a cell value like
 * `<script>alert(1)</script>` or `=HYPERLINK("javascript:…")` renders as literal
 * text glyphs and can never become markup or a formula.
 *
 * Supported: column, bar, line, area, pie. Kept intentionally compact; the goal
 * is Google-Sheets *parity of concept* (live, structured, reactive) not a full
 * charting engine.
 */
import { useMemo } from 'react'
import { extractChartData, chartAccessibleSummary, CHART_TYPES, CHART_PALETTE } from './charts.js'

const PAD = { top: 34, right: 16, bottom: 40, left: 44 }
const AXIS = '#94a3b8'
const GRID = '#e2e8f0'
const INK = '#334155'

function niceMax(v) {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/**
 * ChartBody — the SVG for a chart, given already-extracted data. Split out so
 * both the live overlay and (future) export can share it. `signature` is passed
 * only to make the memo dependency explicit.
 */
export function ChartSvg({ chart, sheet, width, height, extracted: extractedProp, titleId, descId }) {
  const extracted = useMemo(
    () => extractedProp || extractChartData(chart, sheet),
    [extractedProp, chart, sheet]
  )
  const W = Math.max(160, width || chart.w || 480)
  const H = Math.max(120, height || chart.h || 300)
  const summary = chartAccessibleSummary(chart, extracted)
  const kindLabel = CHART_TYPES.find((t) => t.value === chart.type)?.label || chart.type

  // Plot area (leave room for title + legend).
  const legendH = chart.options?.legend !== false && extracted.series.length ? 18 : 0
  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: W - PAD.left - PAD.right,
    h: H - PAD.top - PAD.bottom - legendH,
  }

  let body = null
  if (extracted.empty) {
    body = (
      <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="12" fill={AXIS}>
        No data in range
      </text>
    )
  } else if (chart.type === 'pie') {
    body = <Pie chart={chart} extracted={extracted} W={W} H={H} legendH={legendH} />
  } else if (chart.type === 'scatter' || chart.type === 'bubble') {
    // WAVE-63: X/Y scatter (2 series = x,y) and bubble (3rd series = size).
    body = <ScatterChart chart={chart} extracted={extracted} plot={plot} bubble={chart.type === 'bubble'} />
  } else {
    // column/bar/line/area/combo all share the cartesian renderer (combo draws
    // the first series as bars and the rest as lines).
    body = (
      <CartesianChart chart={chart} extracted={extracted} plot={plot} W={W} H={H} legendH={legendH} />
    )
  }

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-labelledby={titleId ? `${titleId} ${descId}` : undefined}
      aria-label={titleId ? undefined : summary}
      style={{ display: 'block', background: '#fff' }}
    >
      {titleId && <title id={titleId}>{chart.title || `${kindLabel} chart`}</title>}
      {descId && <desc id={descId}>{summary}</desc>}
      {/* Chart title — SVG <text>, escaped by React. NEVER innerHTML. */}
      {chart.title ? (
        <text x={W / 2} y={20} textAnchor="middle" fontSize="13" fontWeight="600" fill={INK}>
          {chart.title}
        </text>
      ) : null}
      {body}
      {!extracted.empty && chart.type !== 'pie' && chart.options?.legend !== false && (
        <Legend series={extracted.series} y={H - legendH + 2} W={W} />
      )}
    </svg>
  )
}

function Legend({ series, y, W }) {
  // Lay out legend chips centred on one row (truncate gracefully if too many).
  const chips = series.slice(0, 8)
  const gap = Math.min(110, (W - 20) / Math.max(1, chips.length))
  const totalW = gap * chips.length
  const startX = Math.max(10, (W - totalW) / 2)
  return (
    <g>
      {chips.map((s, i) => (
        <g key={i} transform={`translate(${startX + i * gap}, ${y})`}>
          <rect width="10" height="10" rx="2" fill={s.color} />
          <text x="14" y="9" fontSize="10" fill={INK}>
            {s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name}
          </text>
        </g>
      ))}
    </g>
  )
}

function CartesianChart({ chart, extracted, plot, W, H, legendH }) {
  const { categories, series } = extracted
  const isBar = chart.type === 'bar' // horizontal
  const isLine = chart.type === 'line'
  const isArea = chart.type === 'area'
  const isCombo = chart.type === 'combo' // series[0] = columns, series[1..] = lines

  // Compute max (stacked=false → grouped bars / independent lines).
  let dataMax = 0
  for (const s of series) for (const v of s.values) if (v > dataMax) dataMax = v
  const maxV = niceMax(dataMax)
  const ticks = 4

  const gridLines = []
  for (let t = 0; t <= ticks; t++) {
    const frac = t / ticks
    const val = maxV * frac
    if (isBar) {
      const x = plot.x + plot.w * frac
      gridLines.push(
        <g key={t}>
          <line x1={x} y1={plot.y} x2={x} y2={plot.y + plot.h} stroke={GRID} strokeWidth="1" />
          <text x={x} y={plot.y + plot.h + 12} textAnchor="middle" fontSize="9" fill={AXIS}>
            {formatTick(val)}
          </text>
        </g>
      )
    } else {
      const y = plot.y + plot.h - plot.h * frac
      gridLines.push(
        <g key={t}>
          <line x1={plot.x} y1={y} x2={plot.x + plot.w} y2={y} stroke={GRID} strokeWidth="1" />
          <text x={plot.x - 6} y={y + 3} textAnchor="end" fontSize="9" fill={AXIS}>
            {formatTick(val)}
          </text>
        </g>
      )
    }
  }

  const nCat = categories.length
  const shapes = []

  if (isBar) {
    // Horizontal grouped bars.
    const bandH = plot.h / nCat
    const groupPad = bandH * 0.18
    const barH = (bandH - groupPad * 2) / series.length
    categories.forEach((cat, ci) => {
      series.forEach((s, sj) => {
        const v = s.values[ci] || 0
        const len = maxV ? (v / maxV) * plot.w : 0
        const y = plot.y + ci * bandH + groupPad + sj * barH
        shapes.push(
          <rect key={`b-${ci}-${sj}`} x={plot.x} y={y} width={Math.max(0, len)} height={Math.max(1, barH - 1)}
                fill={s.color} rx="1">
            <title>{`${s.name} · ${cat}: ${v}`}</title>
          </rect>
        )
      })
      shapes.push(
        <text key={`bl-${ci}`} x={plot.x - 6} y={plot.y + ci * bandH + bandH / 2 + 3}
              textAnchor="end" fontSize="9" fill={INK}>
          {truncate(cat, 10)}
        </text>
      )
    })
  } else if (isLine || isArea) {
    const stepX = nCat > 1 ? plot.w / (nCat - 1) : plot.w
    series.forEach((s, sj) => {
      const pts = s.values.map((v, ci) => {
        const x = plot.x + (nCat > 1 ? ci * stepX : plot.w / 2)
        const y = plot.y + plot.h - (maxV ? (v / maxV) * plot.h : 0)
        return [x, y]
      })
      const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ')
      if (isArea) {
        const area = line +
          ` L ${pts[pts.length - 1][0]} ${plot.y + plot.h}` +
          ` L ${pts[0][0]} ${plot.y + plot.h} Z`
        shapes.push(<path key={`a-${sj}`} d={area} fill={s.color} fillOpacity="0.18" stroke="none" />)
      }
      shapes.push(<path key={`l-${sj}`} d={line} fill="none" stroke={s.color} strokeWidth="2" />)
      pts.forEach((p, ci) => shapes.push(
        <circle key={`p-${sj}-${ci}`} cx={p[0]} cy={p[1]} r="2.5" fill={s.color}>
          <title>{`${s.name} · ${categories[ci]}: ${s.values[ci]}`}</title>
        </circle>
      ))
    })
    // category labels along x
    categories.forEach((cat, ci) => {
      const x = plot.x + (nCat > 1 ? ci * stepX : plot.w / 2)
      shapes.push(
        <text key={`xl-${ci}`} x={x} y={plot.y + plot.h + 12} textAnchor="middle" fontSize="9" fill={INK}>
          {truncate(cat, 8)}
        </text>
      )
    })
  } else {
    // Vertical grouped columns (default) — for COMBO, only series[0] is drawn as
    // columns; the remaining series are overlaid as lines below.
    const barSeries = isCombo ? series.slice(0, 1) : series
    const bandW = plot.w / nCat
    const groupPad = bandW * 0.18
    const barW = (bandW - groupPad * 2) / Math.max(1, barSeries.length)
    categories.forEach((cat, ci) => {
      barSeries.forEach((s, sj) => {
        const v = s.values[ci] || 0
        const len = maxV ? (v / maxV) * plot.h : 0
        const x = plot.x + ci * bandW + groupPad + sj * barW
        const y = plot.y + plot.h - len
        shapes.push(
          <rect key={`c-${ci}-${sj}`} x={x} y={y} width={Math.max(1, barW - 1)} height={Math.max(0, len)}
                fill={s.color} rx="1">
            <title>{`${s.name} · ${cat}: ${v}`}</title>
          </rect>
        )
      })
      shapes.push(
        <text key={`cl-${ci}`} x={plot.x + ci * bandW + bandW / 2} y={plot.y + plot.h + 12}
              textAnchor="middle" fontSize="9" fill={INK}>
          {truncate(cat, 8)}
        </text>
      )
    })
    // COMBO line overlay: series[1..] drawn as lines across the band centres.
    if (isCombo && series.length > 1) {
      const cx = (ci) => plot.x + ci * bandW + bandW / 2
      series.slice(1).forEach((s, sj) => {
        const pts = s.values.map((v, ci) => [cx(ci), plot.y + plot.h - (maxV ? (v / maxV) * plot.h : 0)])
        const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ')
        shapes.push(<path key={`combo-l-${sj}`} d={d} fill="none" stroke={s.color} strokeWidth="2" />)
        pts.forEach((p, ci) => shapes.push(
          <circle key={`combo-p-${sj}-${ci}`} cx={p[0]} cy={p[1]} r="2.5" fill={s.color}>
            <title>{`${s.name} · ${categories[ci]}: ${s.values[ci]}`}</title>
          </circle>
        ))
      })
    }
  }

  return (
    <g>
      {gridLines}
      {/* axes */}
      <line x1={plot.x} y1={plot.y} x2={plot.x} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      <line x1={plot.x} y1={plot.y + plot.h} x2={plot.x + plot.w} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      {shapes}
      {chart.options?.yAxisLabel ? (
        <text x={10} y={plot.y + plot.h / 2} fontSize="9" fill={AXIS}
              transform={`rotate(-90 10 ${plot.y + plot.h / 2})`} textAnchor="middle">
          {truncate(chart.options.yAxisLabel, 24)}
        </text>
      ) : null}
      {chart.options?.xAxisLabel ? (
        <text x={plot.x + plot.w / 2} y={H - legendH - 2} fontSize="9" fill={AXIS} textAnchor="middle">
          {truncate(chart.options.xAxisLabel, 30)}
        </text>
      ) : null}
    </g>
  )
}

function Pie({ chart, extracted, W, H, legendH }) {
  // Pie plots the FIRST series across categories.
  const s = extracted.series[0]
  const values = s.values.map((v) => (v > 0 ? v : 0))
  const total = values.reduce((a, b) => a + b, 0)
  const cx = W / 2
  const cy = (H - legendH) / 2 + 6
  const r = Math.min(plotRadius(W, H - legendH))
  if (total <= 0) {
    return <text x={cx} y={cy} textAnchor="middle" fontSize="12" fill={AXIS}>No positive values</text>
  }
  let acc = 0
  const slices = values.map((v, i) => {
    const start = (acc / total) * Math.PI * 2
    acc += v
    const end = (acc / total) * Math.PI * 2
    const large = end - start > Math.PI ? 1 : 0
    const x1 = cx + r * Math.sin(start), y1 = cy - r * Math.cos(start)
    const x2 = cx + r * Math.sin(end),   y2 = cy - r * Math.cos(end)
    const sliceColor = pieColor(i)
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
    const pct = ((v / total) * 100).toFixed(0)
    return { d, color: sliceColor, label: extracted.categories[i], v, pct }
  })
  return (
    <g>
      {slices.map((sl, i) => (
        <path key={i} d={sl.d} fill={sl.color} stroke="#fff" strokeWidth="1">
          <title>{`${sl.label}: ${sl.v} (${sl.pct}%)`}</title>
        </path>
      ))}
      {/* Slice legend */}
      <g>
        {slices.slice(0, 8).map((sl, i) => (
          <g key={i} transform={`translate(12, ${34 + i * 15})`}>
            <rect width="9" height="9" rx="2" fill={sl.color} />
            <text x="13" y="8" fontSize="9" fill={INK}>
              {truncate(sl.label, 12)} · {sl.pct}%
            </text>
          </g>
        ))}
      </g>
    </g>
  )
}

/**
 * ScatterChart (WAVE-63) — X/Y scatter and bubble. Interprets the extracted
 * series as columns: series[0] = X values, series[1] = Y values, and (bubble)
 * series[2] = point size. Points are aligned by category index. Pure SVG
 * <circle> nodes; the only text is the numeric-tick / point tooltip (escaped).
 */
function ScatterChart({ chart, extracted, plot, bubble }) {
  const { series } = extracted
  const xs = series[0]?.values || []
  const ys = series[1]?.values || []
  const sizes = bubble ? (series[2]?.values || []) : []
  const n = Math.min(xs.length, ys.length)
  if (n === 0 || series.length < 2) {
    return <text x={plot.x + plot.w / 2} y={plot.y + plot.h / 2} textAnchor="middle" fontSize="11" fill={AXIS}>
      Need X and Y columns
    </text>
  }

  let xMin = Infinity, xMax = -Infinity, yMax = 0, sMax = 0
  for (let i = 0; i < n; i++) {
    if (xs[i] < xMin) xMin = xs[i]
    if (xs[i] > xMax) xMax = xs[i]
    if (ys[i] > yMax) yMax = ys[i]
    if (bubble && sizes[i] > sMax) sMax = sizes[i]
  }
  if (!isFinite(xMin)) xMin = 0
  if (!isFinite(xMax) || xMax === xMin) xMax = xMin + 1
  const yTop = niceMax(yMax)
  const xColor = CHART_PALETTE[0]

  const gridLines = []
  const ticks = 4
  for (let t = 0; t <= ticks; t++) {
    const frac = t / ticks
    const y = plot.y + plot.h - plot.h * frac
    gridLines.push(
      <g key={`gy-${t}`}>
        <line x1={plot.x} y1={y} x2={plot.x + plot.w} y2={y} stroke={GRID} strokeWidth="1" />
        <text x={plot.x - 6} y={y + 3} textAnchor="end" fontSize="9" fill={AXIS}>{formatTick(yTop * frac)}</text>
      </g>
    )
    const x = plot.x + plot.w * frac
    gridLines.push(
      <text key={`gx-${t}`} x={x} y={plot.y + plot.h + 12} textAnchor="middle" fontSize="9" fill={AXIS}>
        {formatTick(xMin + (xMax - xMin) * frac)}
      </text>
    )
  }

  const points = []
  for (let i = 0; i < n; i++) {
    const px = plot.x + ((xs[i] - xMin) / (xMax - xMin)) * plot.w
    const py = plot.y + plot.h - (yTop ? (ys[i] / yTop) * plot.h : 0)
    const r = bubble && sMax ? 3 + (Math.abs(sizes[i]) / sMax) * 14 : 3.5
    points.push(
      <circle key={`sp-${i}`} cx={px} cy={py} r={r} fill={xColor} fillOpacity={bubble ? 0.5 : 0.85} stroke={xColor}>
        <title>{`(${xs[i]}, ${ys[i]}${bubble ? `, ${sizes[i] ?? 0}` : ''})`}</title>
      </circle>
    )
  }

  return (
    <g>
      {gridLines}
      <line x1={plot.x} y1={plot.y} x2={plot.x} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      <line x1={plot.x} y1={plot.y + plot.h} x2={plot.x + plot.w} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      {points}
    </g>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pieColor(i) { return CHART_PALETTE[i % CHART_PALETTE.length] }
function plotRadius(w, h) { return Math.max(30, Math.min(w, h) / 2 - 24) }

function formatTick(v) {
  if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1) + 'M'
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function truncate(s, n) {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

export default ChartSvg
