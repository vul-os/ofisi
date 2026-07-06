/**
 * MSW / RTL integration — WAVE41 Sheets: data-validation panel + number-format
 * menu, driven through the REAL components against the live workbook model, plus
 * server persistence and XLSX-export carry.
 *
 * The @fortune-sheet canvas grid itself does NOT run under jsdom (it hangs on
 * HTMLCanvasElement.getContext), so the interactive grid rendering is covered by
 * the Playwright E2E layer. Here we drive the two wave-41 side-surfaces that DO
 * run headless — DataValidationPanel and NumberFormatMenu — through their real
 * React UI, asserting:
 *   • the data-validation form writes a native `sheet.dataVerification` rule and
 *     leaves cell VALUES untouched (so it never perturbs CRDT grid-sync);
 *   • the number-format menu stamps only cells' `ct` descriptor over the selection;
 *   • both survive a save round-trip (PUT /api/files/:id then re-GET);
 *   • the XLSX export carries the number-format code (ct.fa → worksheet cell.z).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as XLSX from 'xlsx'
import DataValidationPanel from '../../apps/sheets/DataValidationPanel.jsx'
import NumberFormatMenu from '../../apps/sheets/NumberFormatMenu.jsx'
import { listValidationRules } from '../../apps/sheets/dataValidation.js'
import { detectPresetId } from '../../apps/sheets/numberFormats.js'
import { exportSheetsToXlsx } from '../../apps/sheets/sheetsExport.js'
import { api } from '../../lib/api.js'
import { server, resetMock, mockState } from './server.js'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))
import { saveAs } from 'file-saver'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// A small workbook: a couple of numeric literals + one label. The Fortune-Sheet
// shape (celldata with r/c/v; per-sheet dataVerification map).
function makeWorkbook() {
  return [{
    name: 'Sheet1',
    celldata: [
      { r: 0, c: 0, v: { v: 'Priority', m: 'Priority' } },
      { r: 0, c: 1, v: { v: 1200.5, m: '1200.5' } },
      { r: 1, c: 1, v: { v: 0.25, m: '0.25' } },
    ],
    config: {},
  }]
}

beforeEach(() => {
  resetMock({ role: 'owner' })
  // Seed a sheet file so the save round-trip has something to PUT to.
  mockState.files.sh1 = { id: 'sh1', name: 'Budget', type: 'sheet', content: makeWorkbook() }
  saveAs.mockClear()
})

// ── Data-validation panel: writes a rule, leaves the grid values untouched ────

describe('WAVE41 data validation panel (real component + model)', () => {
  it('creates a dropdown rule → native dataVerification metadata, cell values unchanged', async () => {
    let data = makeWorkbook()
    const onChange = (next) => { data = next }
    render(
      <DataValidationPanel
        data={data}
        activeCell={{ row: 0, col: 0 }}
        onClose={() => {}}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    // Default criteria is "dropdown" — fill items + range and save.
    await userEvent.type(screen.getByLabelText('Items (comma-separated)'), 'Low, Medium, High')
    const range = screen.getByLabelText('Apply to range')
    fireEvent.change(range, { target: { value: 'A1:A3' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    // Metadata written across the range, grouped into one rule for A1:A3.
    const rules = listValidationRules(data[0])
    expect(rules).toHaveLength(1)
    expect(rules[0].summary).toBe('Dropdown · 3 items')
    expect(rules[0].count).toBe(3)
    expect(data[0].dataVerification['0_0'].type).toBe('dropdown')

    // Grid values are UNAFFECTED — no cell v was touched (CRDT-sync safe).
    expect(data[0].celldata).toEqual(makeWorkbook()[0].celldata)
  })

  it('creates a number-range rule (between) via the form', async () => {
    let data = makeWorkbook()
    render(
      <DataValidationPanel
        data={data}
        activeCell={{ row: 0, col: 1 }}
        onClose={() => {}}
        onChange={(next) => { data = next }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    // Switch criteria to Number.
    fireEvent.change(screen.getByLabelText('Criteria'), { target: { value: 'number' } })
    // "between" is the default condition (needs two values).
    await userEvent.type(screen.getByLabelText('Value'), '0')
    await userEvent.type(screen.getByLabelText('Upper value'), '100')
    fireEvent.change(screen.getByLabelText('Apply to range'), { target: { value: 'B1' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    const rules = listValidationRules(data[0])
    expect(rules).toHaveLength(1)
    expect(rules[0].summary).toBe('Number between 0 and 100')
    expect(data[0].dataVerification['0_1']).toMatchObject({ type: 'number', type2: 'between', value1: '0', value2: '100' })
  })

  it('surfaces a validation error for an empty dropdown (no rule written)', async () => {
    let data = makeWorkbook()
    render(
      <DataValidationPanel data={data} activeCell={{ row: 0, col: 0 }} onClose={() => {}} onChange={(n) => { data = n }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Add rule/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one dropdown item/i)
    expect(data[0].dataVerification).toBeUndefined()
  })
})

// ── Number-format menu: applies a preset to the selection ─────────────────────

describe('WAVE41 number-format menu (real component + model)', () => {
  it('applies a currency preset to the selection → only ct rewritten', async () => {
    let data = makeWorkbook()
    render(
      <NumberFormatMenu
        selection={{ r0: 0, r1: 1, c0: 1, c1: 1 }}
        activeCell={{ row: 0, col: 1 }}
        data={data}
        onChange={(next) => { data = next }}
      />,
    )
    // Open the menu and pick Currency ($).
    fireEvent.click(screen.getByRole('button', { name: /Number format/i }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Currency \(\$\)/ }))

    const b1 = data[0].celldata.find((c) => c.r === 0 && c.c === 1)
    const b2 = data[0].celldata.find((c) => c.r === 1 && c.c === 1)
    expect(b1.v.ct).toEqual({ fa: '"$"#,##0.00', t: 'n' })
    expect(b2.v.ct).toEqual({ fa: '"$"#,##0.00', t: 'n' })
    // Raw values are untouched (transparent to CRDT sync).
    expect(b1.v.v).toBe(1200.5)
    expect(b2.v.v).toBe(0.25)
    // The label cell (A1, out of the B-column selection) is unformatted.
    expect(data[0].celldata.find((c) => c.r === 0 && c.c === 0).v.ct).toBeUndefined()
  })

  it('reflects the active cell\'s current format as the checked radio', async () => {
    const data = makeWorkbook()
    // Pre-format B1 as percent so the menu should highlight it.
    data[0].celldata.find((c) => c.r === 0 && c.c === 1).v.ct = { fa: '0.00%', t: 'n' }
    render(<NumberFormatMenu selection={null} activeCell={{ row: 0, col: 1 }} data={data} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Number format/i }))
    const percent = await screen.findByRole('menuitemradio', { name: /^Percent$/ })
    expect(percent).toHaveAttribute('aria-checked', 'true')
    expect(detectPresetId(data[0].celldata.find((c) => c.r === 0 && c.c === 1).v)).toBe('percent')
  })
})

// ── Persistence: both survive a save (PUT) → re-GET round-trip ─────────────────

describe('WAVE41 persistence through save (MSW round-trip)', () => {
  it('a validation rule + number format saved via PUT come back on re-GET', async () => {
    const wb = makeWorkbook()
    // Apply a dropdown rule to A1 and a currency format to B1 directly on the model
    // (the panels' onChange is unit-covered above); here we assert the PERSISTENCE.
    wb[0].dataVerification = { '0_0': { type: 'dropdown', type2: '', value1: 'a,b', value2: '', prohibitInput: true } }
    wb[0].celldata.find((c) => c.r === 0 && c.c === 1).v.ct = { fa: '"$"#,##0.00', t: 'n' }

    await api.updateFile('sh1', 'Budget', wb)
    expect(mockState.calls).toContain('PUT /files/sh1')

    const reloaded = await api.getFile('sh1')
    const sheet = reloaded.content[0]
    expect(sheet.dataVerification['0_0'].type).toBe('dropdown')
    expect(sheet.celldata.find((c) => c.r === 0 && c.c === 1).v.ct.fa).toBe('"$"#,##0.00')
  })
})

// ── XLSX export carries the number format (ct.fa → worksheet cell.z) ───────────

describe('WAVE41 XLSX export carries the number format', () => {
  it('a currency-formatted cell exports with its format code in the real .xlsx', async () => {
    const wb = makeWorkbook()
    wb[0].celldata.find((c) => c.r === 0 && c.c === 1).v.ct = { fa: '"$"#,##0.00', t: 'n' }
    // An unformatted numeric cell must NOT carry a `z` (General is the default).
    // (B2 keeps its raw 0.25 with no ct.)

    exportSheetsToXlsx(wb, 'Budget')
    expect(saveAs).toHaveBeenCalledTimes(1)

    // Parse the ACTUAL Blob the real exporter handed to saveAs, so this asserts
    // the full exportSheetsToXlsx → XLSX.write → Blob path (not a re-implementation).
    const [blob, filename] = saveAs.mock.calls[0]
    expect(filename).toBe('Budget.xlsx')
    const buf = await blob.arrayBuffer()
    const parsed = XLSX.read(new Uint8Array(buf), { type: 'array', cellNF: true })
    const ws = parsed.Sheets[parsed.SheetNames[0]]

    expect(ws['B1'].z).toBe('"$"#,##0.00') // currency format carried through
    // The unformatted cell did NOT inherit the currency format (xlsx read-back
    // may fill 'General' as its default; the point is it's not our custom code).
    expect(ws['B2'].z).not.toBe('"$"#,##0.00')
    expect(ws['B2'].v).toBe(0.25) // raw value preserved
  })
})
