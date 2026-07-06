/**
 * src/apps/sheets/ChartWizard.jsx  (WAVE-54, rewritten)
 *
 * Chart editor dialog for Sheets. Produces a PLAIN-DATA chart descriptor
 * (see charts.js) that is stored on the sheet as `sheet.charts`, CRDT-synced,
 * and rendered live by ChartLayer/ChartSvg as inline SVG.
 *
 * This replaces the previous version, which emitted a FortuneSheet-native
 * `sheet.chart` descriptor — but @fortune-sheet/react (OSS) has no chart
 * renderer, so that descriptor was inert dead data. We now own the render.
 *
 * Insert mode  (chart == null): builds a new chart, defaulting the range to the
 *   current grid selection.
 * Edit mode    (chart set):      pre-fills from an existing chart, patches it.
 *
 * SECURITY: title / axis labels are captured as plain form strings and stored as
 * plain data; they are only ever rendered as SVG <text> (escaped). No formula or
 * HTML is evaluated here.
 */
import { useRef, useState } from 'react'
import { X, BarChart2 } from 'lucide-react'
import { Button, IconButton, useDialogA11y } from '../../components/ui'
import { CHART_TYPES, makeChart, insertChart, updateChart } from './charts.js'

/**
 * selectionToRange — turn the editor's tracked selection rect (0-indexed
 * inclusive {r0,r1,c0,c1}) into A1 text. Returns '' when no usable selection.
 */
export function selectionToRange(sel) {
  if (!sel) return ''
  const { r0, r1, c0, c1 } = sel
  if ([r0, r1, c0, c1].some((n) => typeof n !== 'number' || n < 0)) return ''
  const a1 = (r, c) => colName(c) + (r + 1)
  return a1(Math.min(r0, r1), Math.min(c0, c1)) + ':' + a1(Math.max(r0, r1), Math.max(c0, c1))
}

function colName(c) {
  let s = ''
  let n = c
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

export default function ChartWizard({ data, chart, selectionRect, onClose, onChange }) {
  const editing = !!chart
  const [chartType, setChartType] = useState(chart?.type || 'column')
  const [range,     setRange]     = useState(chart?.range || selectionToRange(selectionRect))
  const [title,     setTitle]     = useState(chart?.title || '')
  const [xLabel,    setXLabel]    = useState(chart?.options?.xAxisLabel || '')
  const [yLabel,    setYLabel]    = useState(chart?.options?.yAxisLabel || '')
  const [legend,    setLegend]    = useState(chart?.options?.legend !== false)
  const [headerRow, setHeaderRow] = useState(chart?.options?.headerRow !== false)
  const [headerCol, setHeaderCol] = useState(chart?.options?.headerCol !== false)
  const dialogRef = useRef(null)
  useDialogA11y(dialogRef, onClose)

  function useSelection() {
    const r = selectionToRange(selectionRect)
    if (r) setRange(r)
  }

  function handleSubmit() {
    const built = makeChart({
      ...(chart || {}),
      type: chartType,
      range,
      title,
      options: { xAxisLabel: xLabel, yAxisLabel: yLabel, legend, headerRow, headerCol },
    })
    const next = editing
      ? updateChart(data, chart.id, built)
      : insertChart(data, built)
    onChange(next)
    onClose()
  }

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit chart' : 'Insert chart'}
        className="bg-paper rounded-xl border border-line shadow-e3 w-[480px] max-h-[85vh] flex flex-col overflow-hidden animate-scale-in"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <span className="text-sm font-semibold text-ink flex items-center gap-2">
            <BarChart2 size={14} className="text-accent" aria-hidden /> {editing ? 'Edit chart' : 'Insert chart'}
          </span>
          <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-xs">
          <div className="space-y-2">
            <p className="text-ink-muted font-medium">Chart type</p>
            <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label="Chart type">
              {CHART_TYPES.map((ct) => (
                <button
                  key={ct.value}
                  role="radio"
                  aria-checked={chartType === ct.value}
                  onClick={() => setChartType(ct.value)}
                  className={[
                    'flex flex-col items-center gap-1 py-2 rounded-lg border transition-colors duration-fast',
                    chartType === ct.value
                      ? 'border-accent bg-accent-tint text-accent font-semibold'
                      : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                  ].join(' ')}
                >
                  <span className="text-lg leading-none" aria-hidden>{ct.icon}</span>
                  {ct.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-ink-muted font-medium" htmlFor="chart-range">Data range</label>
            <div className="flex gap-1.5">
              <input
                id="chart-range"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                className={inputCls}
                placeholder="e.g. A1:D10"
              />
              <Button variant="secondary" size="sm" onClick={useSelection} title="Use current selection">Use selection</Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-ink-muted">
              <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
              First row = series names
            </label>
            <label className="flex items-center gap-2 text-ink-muted">
              <input type="checkbox" checked={headerCol} onChange={(e) => setHeaderCol(e.target.checked)} />
              First column = labels
            </label>
          </div>

          <div className="space-y-1">
            <label className="block text-ink-muted font-medium" htmlFor="chart-title">Chart title</label>
            <input id="chart-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Optional title" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="chart-x">X-axis label</label>
              <input id="chart-x" value={xLabel} onChange={(e) => setXLabel(e.target.value)} className={inputCls} placeholder="X axis" />
            </div>
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="chart-y">Y-axis label</label>
              <input id="chart-y" value={yLabel} onChange={(e) => setYLabel(e.target.value)} className={inputCls} placeholder="Y axis" />
            </div>
          </div>

          <label className="flex items-center gap-2 text-ink-muted">
            <input type="checkbox" checked={legend} onChange={(e) => setLegend(e.target.checked)} />
            Show legend
          </label>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-line gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}>{editing ? 'Save chart' : 'Insert chart'}</Button>
        </div>
      </div>
    </div>
  )
}
