/**
 * src/apps/sheets/PivotPanel.jsx  (WAVE-63 — reactive pivot)
 *
 * Pivot table configuration side panel. Instead of inserting a STATIC snapshot
 * into a new sheet (which went stale the moment a source cell changed), it now
 * builds a PIVOT DESCRIPTOR (plain structured data) that the PivotLayer renders
 * LIVE — re-aggregating from its source range whenever those cells change, like
 * the WAVE-54 charts. The descriptor is validated/clamped through makePivot at
 * every entry point (and at the CRDT ingress in SheetsEditor).
 *
 * Props:
 *   data        {Sheet[]}  — current workbook sheets
 *   pivot       {object?}  — existing descriptor when editing (null = insert)
 *   selectionRect {object?}— {r0,r1,c0,c1} to seed the source range
 *   onClose     {fn}       — close the panel
 *   onInsert    {fn(Sheet[])} — commit workbook data with the pivot upserted
 */
import { useState, useMemo, useEffect } from 'react'
import { X, RefreshCw, Table2 } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import {
  makePivot, insertPivot, updatePivot, computePivot, pivotHeaders, pivotToSheet, PIVOT_AGGS,
} from './pivot.js'

// Turn a 0-indexed selection rect into an A1 range string.
function colToLetter(idx) {
  let s = ''
  let n = idx + 1
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}
function rectToA1(rect) {
  if (!rect) return ''
  const { r0, r1, c0, c1 } = rect
  return `${colToLetter(c0)}${r0 + 1}:${colToLetter(c1)}${r1 + 1}`
}

export default function PivotPanel({ data, pivot: editPivot, selectionRect, onClose, onInsert, onInsertStatic }) {
  const activeSheet = data?.[0]
  const isEditing = !!editPivot

  // Seed the source range: existing pivot → its range; else the selection; else
  // a bounded default over the used area of the sheet.
  const initialRange = useMemo(() => {
    if (editPivot?.range) return editPivot.range
    const sel = rectToA1(selectionRect)
    if (sel) return sel
    let maxR = 0, maxC = 0
    for (const { r, c } of activeSheet?.celldata || []) { if (r > maxR) maxR = r; if (c > maxC) maxC = c }
    return maxR || maxC ? `A1:${colToLetter(maxC)}${maxR + 1}` : 'A1:C10'
  }, [editPivot, selectionRect, activeSheet])

  const [range, setRange] = useState(initialRange)
  const [rowField, setRowField] = useState(editPivot?.rowField || '')
  const [colField, setColField] = useState(editPivot?.colField || '')
  const [valueField, setValueField] = useState(editPivot?.valueField || '')
  const [agg, setAgg] = useState(editPivot?.agg || 'SUM')
  const [title, setTitle] = useState(editPivot?.title || '')

  // Headers available for the current range (live).
  const headers = useMemo(
    () => pivotHeaders(makePivot({ range }), activeSheet || {}),
    [range, activeSheet]
  )

  // Default field selections when headers first resolve (insert flow only).
  useEffect(() => {
    if (isEditing || headers.length === 0) return
    setRowField((v) => v || headers[0] || '')
    setValueField((v) => v || headers[2] || headers[1] || '')
  }, [headers, isEditing])

  const draft = useMemo(
    () => makePivot({ id: editPivot?.id, range, rowField, colField, valueField, agg, title }),
    [editPivot, range, rowField, colField, valueField, agg, title]
  )
  const preview = useMemo(() => computePivot(draft, activeSheet || {}), [draft, activeSheet])

  function handleCommit() {
    const next = isEditing
      ? updatePivot(data, editPivot.id, { range, rowField, colField, valueField, agg, title })
      : insertPivot(data, { range, rowField, colField, valueField, agg, title })
    onInsert(next)
    onClose()
  }

  // "Insert as static sheet" — materialise the CURRENT result into a real sheet
  // (celldata) so it exports to XLSX / is formula-referenceable. Snapshot, not
  // reactive; distinct from the live pivot above.
  function handleInsertStatic() {
    if (!onInsertStatic) return
    const sheet = pivotToSheet(draft, activeSheet || {}, title)
    if (sheet) onInsertStatic([...data, sheet])
    onClose()
  }

  const sel = 'w-full rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'

  return (
    <div className="flex flex-col w-full sm:w-72 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink tracking-tightish">
          <Table2 size={13} /> {isEditing ? 'Edit pivot' : 'Pivot table'}
        </span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-4 text-xs">
        <div className="space-y-1">
          <label className="block text-ink-muted font-medium">Source range</label>
          <input value={range} onChange={(e) => setRange(e.target.value)} className={sel} placeholder="e.g. A1:D100" />
        </div>

        {headers.length === 0 ? (
          <p className="text-ink-faint">No headers found in that range. The first row of the range should hold column names.</p>
        ) : (
          <>
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Row field</label>
              <select value={rowField} onChange={(e) => setRowField(e.target.value)} className={sel}>
                <option value="">— choose —</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Column field</label>
              <select value={colField} onChange={(e) => setColField(e.target.value)} className={sel}>
                <option value="">— none —</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Value field</label>
              <select value={valueField} onChange={(e) => setValueField(e.target.value)} className={sel}>
                <option value="">— choose —</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Aggregation</label>
              <select value={agg} onChange={(e) => setAgg(e.target.value)} className={sel}>
                {PIVOT_AGGS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Title (optional)</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={sel} placeholder="Pivot title" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Button variant="primary" size="sm" onClick={handleCommit} className="w-full" disabled={!preview}>
                {isEditing ? 'Update pivot' : 'Insert live pivot'}
              </Button>
              {!isEditing && onInsertStatic && (
                <Button variant="secondary" size="sm" onClick={handleInsertStatic} className="w-full" disabled={!preview}>
                  Insert as static sheet (exportable)
                </Button>
              )}
            </div>

            {preview ? (
              <div className="overflow-auto border border-line rounded-md">
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-ink-faint border-b border-line">
                  <RefreshCw size={9} /> Live preview — updates when source cells change
                </div>
                <table className="text-xs w-full border-collapse">
                  <thead>
                    <tr>
                      {preview[0].map((h, i) => (
                        <th key={i} className="px-1.5 py-1 border border-line bg-bg text-ink-muted font-semibold text-left whitespace-nowrap">
                          {String(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(1).map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? '' : 'bg-bg'}>
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-1.5 py-0.5 border border-line text-ink whitespace-nowrap">
                            {typeof cell === 'number' ? cell.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-ink-faint text-[11px]">Pick a Row field and a Value field that match header names to preview.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
