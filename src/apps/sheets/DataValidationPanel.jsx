/**
 * src/apps/sheets/DataValidationPanel.jsx
 *
 * Data-validation side panel: per-cell dropdown lists and number-range rules.
 * Rules are written to Fortune Sheet's native `sheet.dataVerification` map, so
 * the grid renders the dropdown chevron + enforces invalid-entry rejection with
 * no extra wiring. Pure rule logic lives in ./dataValidation.js (unit-tested);
 * this file is just the form.
 *
 * Props:
 *   data       {Sheet[]}   — workbook data
 *   activeCell {{row,col}} — current selection, used to prefill the range
 *   onClose    {fn}
 *   onChange   {fn(data)}  — called with the updated workbook after a change
 */
import { useMemo, useState } from 'react'
import { X, Plus, Trash2, ListChecks } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import { parseRange } from './ConditionalFormatPanel.jsx'
import {
  VALIDATION_KINDS,
  NUMBER_CONDITIONS,
  numberConditionArity,
  buildRegulation,
  applyValidation,
  listValidationRules,
} from './dataValidation.js'

function colLetter(col) {
  let s = ''
  let n = col
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}
function cellA1(row, col) { return `${colLetter(col)}${row + 1}` }

const EMPTY_FORM = {
  kind: 'dropdown',
  items: '',
  allowMulti: false,
  condition: 'between',
  value1: '',
  value2: '',
  rejectInvalid: true,
  hint: '',
}

export default function DataValidationPanel({ data, activeCell, onClose, onChange }) {
  const sheet = data?.[0]
  const rules = useMemo(() => listValidationRules(sheet), [sheet])

  const defaultRange = activeCell
    ? cellA1(activeCell.row, activeCell.col)
    : 'A1'
  const [editing, setEditing] = useState(false)
  const [range, setRange]     = useState(defaultRange)
  const [form, setForm]       = useState(EMPTY_FORM)
  const [error, setError]     = useState('')

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'
  const selCls   = inputCls

  function startNew() {
    setForm(EMPTY_FORM)
    setRange(defaultRange)
    setError('')
    setEditing(true)
  }

  function save() {
    const reg = buildRegulation(form)
    if (!reg) {
      setError(form.kind === 'dropdown'
        ? 'Add at least one dropdown item (comma-separated).'
        : 'Enter valid numeric value(s) for the condition.')
      return
    }
    const parsed = parseRange(range)?.[0]
    if (!parsed) { setError('Enter a valid range, e.g. A1:A10.'); return }
    const next = applyValidation(data, range, reg, parseRange)
    onChange?.(next)
    setEditing(false)
  }

  function removeRule(keys) {
    // Clear every cell key this rule covers.
    let next = data
    for (const key of keys) {
      const [r, c] = key.split('_').map(Number)
      next = applyValidation(next, cellA1(r, c), null, parseRange)
    }
    onChange?.(next)
  }

  const arity = numberConditionArity(form.condition)

  return (
    <div className="flex flex-col w-full sm:w-80 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink tracking-tightish">
          <ListChecks size={13} aria-hidden /> Data validation
        </span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-3 text-xs overflow-y-auto">
        {!editing && (
          <>
            {rules.length === 0 && (
              <p className="text-ink-faint">
                No validation rules. Add one to give cells a dropdown list or restrict them to a number range.
              </p>
            )}

            {rules.map((rule, i) => (
              <div key={i} className="flex items-start gap-2 border border-line rounded-md px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-ink truncate">{rule.summary}</p>
                  <p className="text-ink-faint text-[10px]">
                    {rule.count} cell{rule.count === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  onClick={() => removeRule(rule.keys)}
                  aria-label={`Remove validation rule: ${rule.summary}`}
                  className="text-ink-faint hover:text-danger mt-0.5 rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            <Button variant="secondary" size="sm" onClick={startNew} className="w-full">
              <Plus size={11} className="mr-1" /> Add rule
            </Button>
          </>
        )}

        {editing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="dv-range">Apply to range</label>
              <input
                id="dv-range"
                value={range}
                onChange={(e) => { setRange(e.target.value); setError('') }}
                className={inputCls}
                placeholder="e.g. A1:A10"
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="dv-kind">Criteria</label>
              <select
                id="dv-kind"
                value={form.kind}
                onChange={(e) => { setForm((f) => ({ ...f, kind: e.target.value })); setError('') }}
                className={selCls}
              >
                {VALIDATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </div>

            {form.kind === 'dropdown' && (
              <>
                <div className="space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-items">Items (comma-separated)</label>
                  <input
                    id="dv-items"
                    value={form.items}
                    onChange={(e) => { setForm((f) => ({ ...f, items: e.target.value })); setError('') }}
                    className={inputCls}
                    placeholder="e.g. Low, Medium, High"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.allowMulti}
                    onChange={(e) => setForm((f) => ({ ...f, allowMulti: e.target.checked }))}
                  />
                  <span className="text-ink-muted">Allow multiple selection</span>
                </label>
              </>
            )}

            {form.kind === 'number' && (
              <>
                <div className="space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-cond">Condition</label>
                  <select
                    id="dv-cond"
                    value={form.condition}
                    onChange={(e) => { setForm((f) => ({ ...f, condition: e.target.value })); setError('') }}
                    className={selCls}
                  >
                    {NUMBER_CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    aria-label="Value"
                    value={form.value1}
                    onChange={(e) => { setForm((f) => ({ ...f, value1: e.target.value })); setError('') }}
                    className={inputCls}
                    placeholder="Value"
                    inputMode="decimal"
                  />
                  {arity === 2 && (
                    <input
                      aria-label="Upper value"
                      value={form.value2}
                      onChange={(e) => { setForm((f) => ({ ...f, value2: e.target.value })); setError('') }}
                      className={inputCls}
                      placeholder="and"
                      inputMode="decimal"
                    />
                  )}
                </div>
              </>
            )}

            <label className="flex items-center gap-2 cursor-pointer border-t border-line pt-2">
              <input
                type="checkbox"
                checked={form.rejectInvalid}
                onChange={(e) => setForm((f) => ({ ...f, rejectInvalid: e.target.checked }))}
              />
              <span className="text-ink-muted">Reject invalid input</span>
            </label>

            {error && <p className="text-danger text-[11px]" role="alert">{error}</p>}

            <div className="flex gap-2">
              <Button variant="primary"   size="sm" onClick={save}                 className="flex-1">Save</Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} className="flex-1">Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
