import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import {
  ArrowLeft, Save, Loader2, Download, Upload, AlertCircle, MessageSquare,
  Check, Circle, ChevronDown, BarChart2, Filter, Table2, Tag, Sliders, Keyboard, Search,
  Lock, MessageSquarePlus, X, MoreHorizontal,
} from 'lucide-react'
import { useFilesStore, getSaveState, onSaveStateChange } from '../../store/filesStore'
import { api } from '../../lib/api'
import { readDraft, clearDraft } from '../../lib/draftStore'
import { exportSheetsToXlsx, exportSheetsToCsv } from './sheetsExport'
import { importCSVFile } from './csvImport'
import { GridSession, getGridReplicaId } from '../../lib/crdt/grid.js'
import CommentsPanel from '../../components/CommentsPanel'
import { useLiveCursors } from '@vulos/relay-client/useLiveCursors'
import { SheetsCursorLayer } from '../../components/RemoteCursors.jsx'
import { Button, IconButton, Tooltip, Topbar, Menu, useToast, useDialogA11y } from '../../components/ui'
import { useSheetKeyboardShortcuts, KeyboardShortcutsHelp, useShortcutsHelp } from './KeyboardShortcuts.jsx'
import SheetsFindReplace from './SheetsFindReplace.jsx'

// Side panels — lazily loaded so they don't bloat the initial bundle.
const PivotPanel              = lazy(() => import('./PivotPanel.jsx'))
const FilterPanel             = lazy(() => import('./FilterPanel.jsx'))
const ConditionalFormatPanel  = lazy(() => import('./ConditionalFormatPanel.jsx'))
const ChartWizard             = lazy(() => import('./ChartWizard.jsx'))
const NamedRangesPanel        = lazy(() => import('./NamedRangesPanel.jsx'))

const RETRY_DELAY_MS  = 4000
const AUTOSAVE_DELAY_MS = 3000

/**
 * normalizeSheets — give every sheet the dimensions/identity fields Fortune
 * Sheet needs. Without explicit `row`/`column` (and `id`/`order`/`status`) the
 * library computes its default selection against undefined bounds, which is why
 * the name box rendered "A1:NaN" on a fresh/empty sheet. Providing them yields a
 * valid A1 selection and a stable grid.
 */
function normalizeSheets(sheets) {
  const arr = Array.isArray(sheets) && sheets.length
    ? sheets
    : [{ name: 'Sheet1', celldata: [], config: {} }]
  return arr.map((sh, i) => ({
    ...sh,
    name: sh.name || `Sheet${i + 1}`,
    celldata: sh.celldata || [],
    config: sh.config || {},
    id: sh.id || `sheet_${i + 1}`,
    order: typeof sh.order === 'number' ? sh.order : i,
    status: typeof sh.status === 'number' ? sh.status : (i === 0 ? 1 : 0),
    row: sh.row || 100,
    column: sh.column || 26,
  }))
}

// Shared trigger styling for the Import / Export menus.
const MENU_TRIGGER_CN = [
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md',
  'bg-paper border border-line text-xs font-medium tracking-tightish',
  'text-ink-muted hover:border-line-strong hover:text-ink',
  'transition-colors duration-fast ease-out',
  'focus-visible:outline-none focus-visible:shadow-focus',
].join(' ')

// ── FreezePanel ─────────────────────────────────────────────────────────────
function FreezePanel({ workbookRef }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(null) // 'rows' | 'cols'
  const [count, setCount] = useState(1)
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); setMode(null) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const freeze = (type, row, column) => {
    workbookRef.current?.freeze(type, { row, column })
    setOpen(false)
    setMode(null)
  }

  return (
    <div ref={panelRef} className="relative">
      <Tooltip label="Freeze rows / columns">
        <IconButton size="sm" active={open} onClick={() => { setOpen((v) => !v); setMode(null) }}>
          <Lock size={14} />
        </IconButton>
      </Tooltip>
      {open && (
        <div
          role="menu"
          className={[
            'absolute left-0 top-full mt-0.5 w-52 py-1',
            'bg-paper border border-line rounded-md shadow-e2 z-40 text-sm',
            'animate-scale-in',
          ].join(' ')}
        >
          {mode === null ? (
            <>
              <button
                role="menuitem"
                onClick={() => freeze('row', 1, 0)}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze top row
              </button>
              <button
                role="menuitem"
                onClick={() => freeze('column', 0, 1)}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze first column
              </button>
              <hr className="border-line my-1" />
              <button
                role="menuitem"
                onClick={() => { setMode('rows'); setCount(2) }}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze rows…
              </button>
              <button
                role="menuitem"
                onClick={() => { setMode('cols'); setCount(2) }}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Freeze columns…
              </button>
              <hr className="border-line my-1" />
              <button
                role="menuitem"
                onClick={() => freeze('both', 0, 0)}
                className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted"
              >
                Unfreeze
              </button>
            </>
          ) : (
            <div className="px-3 py-2 flex flex-col gap-2">
              <label className="text-2xs font-semibold uppercase tracking-eyebrow text-ink-faint">
                {mode === 'rows' ? 'Rows to freeze' : 'Columns to freeze'}
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, parseInt(e.target.value) || 1))}
                className={[
                  'w-full h-7 px-2 text-sm rounded-sm',
                  'bg-paper border border-line focus:border-line-strong',
                  'focus-visible:outline-none focus-visible:shadow-focus',
                ].join(' ')}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={() => freeze(mode === 'rows' ? 'row' : 'column', mode === 'rows' ? count : 0, mode === 'cols' ? count : 0)}
                  className="flex-1 h-7 rounded-sm bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Apply
                </button>
                <button
                  onClick={() => setMode(null)}
                  className="h-7 px-2 rounded-sm border border-line text-xs text-ink-muted hover:border-line-strong transition-colors"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── CellCommentPanel ─────────────────────────────────────────────────────────
function CellCommentPanel({ data, activeCell, onChange, onClose }) {
  const sheet = data?.[0]
  const existing = sheet?.celldata?.find(
    (c) => c.r === activeCell.row && c.c === activeCell.col
  )
  const currentComment = existing?.v?.ps?.value || ''
  const [text, setText] = useState(currentComment)

  // Reset when active cell changes
  useEffect(() => {
    const cell = data?.[0]?.celldata?.find(
      (c) => c.r === activeCell.row && c.c === activeCell.col
    )
    setText(cell?.v?.ps?.value || '')
  }, [activeCell.row, activeCell.col]) // eslint-disable-line

  const handleSave = () => {
    onChange((prev) => {
      const sheets = prev.map((sh, idx) => {
        if (idx !== 0) return sh
        const celldata = [...(sh.celldata || [])]
        const cellIdx = celldata.findIndex((c) => c.r === activeCell.row && c.c === activeCell.col)
        if (cellIdx >= 0) {
          const cell = { ...celldata[cellIdx] }
          const v = typeof cell.v === 'object' ? { ...cell.v } : { v: cell.v, m: String(cell.v ?? '') }
          if (text.trim()) {
            v.ps = { value: text.trim(), isShow: false }
          } else {
            delete v.ps
          }
          celldata[cellIdx] = { ...cell, v }
        } else if (text.trim()) {
          celldata.push({
            r: activeCell.row,
            c: activeCell.col,
            v: { v: '', m: '', ct: { fa: 'General', t: 'n' }, ps: { value: text.trim(), isShow: false } },
          })
        }
        return { ...sh, celldata }
      })
      return sheets
    })
    onClose()
  }

  const cellLabel = `${String.fromCharCode(65 + activeCell.col)}${activeCell.row + 1}`
  const panelRef = useRef(null)
  // Trap focus, close on Esc, restore focus to the triggering control on close.
  useDialogA11y(panelRef, onClose)

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Comment on cell ${cellLabel}`}
      className={[
        'absolute right-4 left-4 sm:left-auto top-4 z-40 w-auto sm:w-72 bg-paper border border-line rounded-lg shadow-e3',
        'flex flex-col animate-scale-in',
      ].join(' ')}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="text-xs font-semibold text-ink">
          Comment · <span className="text-ink-faint font-mono">{cellLabel}</span>
        </span>
        <button
          onClick={onClose}
          className="text-ink-faint hover:text-ink transition-colors rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
          aria-label="Close comment panel"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment…"
        rows={4}
        className={[
          'flex-1 w-full p-3 text-sm bg-transparent border-none outline-none resize-none',
          'text-ink placeholder:text-ink-faint',
        ].join(' ')}
      />
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-line">
        {currentComment && (
          <button
            onClick={() => { setText(''); handleSave() }}
            className="text-xs text-danger hover:underline rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
          >
            Delete
          </button>
        )}
        <button
          onClick={onClose}
          className="h-7 px-3 rounded-sm border border-line text-xs text-ink-muted hover:border-line-strong transition-colors focus-visible:outline-none focus-visible:shadow-focus"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="h-7 px-3 rounded-sm bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors focus-visible:outline-none focus-visible:shadow-focus"
        >
          Save
        </button>
      </div>
    </div>
  )
}

export default function SheetsEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { files, saveFileWithDraft, markDirty } = useFilesStore()
  const [file, setFile] = useState(files.find((f) => f.id === id))
  const [title, setTitle] = useState(file?.name || 'Untitled Sheet')
  const [data, setData] = useState(() => normalizeSheets(file?.content))
  const [saveStatus, setSaveStatus] = useState(getSaveState(id))
  const [draft, setDraft] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const { showToast, toast } = useToast()

  // Panel visibility state
  const [showComments,      setShowComments]      = useState(false)
  const [showPivot,         setShowPivot]         = useState(false)
  const [showFilter,        setShowFilter]        = useState(false)
  const [showCondFormat,    setShowCondFormat]    = useState(false)
  const [showNamedRanges,   setShowNamedRanges]   = useState(false)
  const [showChartWizard,   setShowChartWizard]   = useState(false)
  const [showFindReplace,   setShowFindReplace]   = useState(false)

  const [activeCell,      setActiveCell]      = useState({ row: 0, col: 0 })
  const [showCellComment, setShowCellComment] = useState(false)

  const saveTimer   = useRef(null)
  const retryTimer  = useRef(null)
  const titleRef    = useRef(title)
  titleRef.current  = title
  const dataRef     = useRef(data)
  dataRef.current   = data
  const gridSessionRef  = useRef(null)
  const workbookWrapRef = useRef(null)
  const workbookRef     = useRef(null)
  const importInputRef  = useRef(null)

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  const { show: showShortcutsHelp, openHelp, closeHelp } = useShortcutsHelp()
  useSheetKeyboardShortcuts({
    containerRef: workbookWrapRef,
    data,
    onChange:    setData,
    onShowHelp:  openHelp,
  })

  // Ctrl+F / Ctrl+H: open find/replace overlay for sheets
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setShowFindReplace((v) => !v)
      }
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        setShowFindReplace(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ── CRDT collaboration (OFFICE-23) ──────────────────────────────────────────
  useEffect(() => {
    if (!id) return
    const replicaId = getGridReplicaId()
    const session = new GridSession({ sessionId: id, replicaId, fabricClient: null })
    gridSessionRef.current = session
    session.requestSnapshot()

    const onRemote = () => {
      const crdtCells = session.cells()
      if (crdtCells.length === 0) return
      setData((prev) => {
        const sheets = prev.map((sheet, idx) => {
          if (idx !== 0) return sheet
          const existing = new Map((sheet.celldata || []).map((c) => [`${c.r}_${c.c}`, c]))
          for (const { r, c, v } of crdtCells) {
            const key = `${r}_${c}`
            const ex = existing.get(key)
            if (!ex || (typeof ex.v === 'object' ? ex.v?.v : ex.v) !== v) {
              existing.set(key, { r, c, v: { v, m: v, ct: { fa: 'General', t: 'n' } } })
            }
          }
          return { ...sheet, celldata: [...existing.values()] }
        })
        return sheets
      })
      markDirty(id)
    }

    session.addEventListener('remoteOp', onRemote)
    return () => {
      session.removeEventListener('remoteOp', onRemote)
      session.destroy()
      gridSessionRef.current = null
    }
  }, [id]) // eslint-disable-line

  useEffect(() => {
    const unsub = onSaveStateChange(id, (state) => setSaveStatus({ ...state }))
    return unsub
  }, [id])

  useEffect(() => {
    if (!file && id) {
      api.getFile(id).then((f) => {
        setFile(f)
        setTitle(f.name)
        setData(normalizeSheets(f.content))
      }).catch(() => {
        showToast('Could not open this spreadsheet.', 'error')
        navigate('/sheets')
      })
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    readDraft(id).then((d) => { if (d && d.ts) setDraft(d) })
  }, [id])

  // ── Live cursors (OFFICE-25) ────────────────────────────────────────────────
  const { remoteCursors, broadcastSheetCursor } = useLiveCursors({
    fabric: null, localIdentity: null, color: 'var(--teal-500)',
  })

  const getCellRect = useCallback((row, col) => {
    const container = workbookWrapRef.current
    if (!container) return null
    try {
      const tbody = container.querySelector('.luckysheet-cell-main tbody')
      if (!tbody) return null
      const tr = tbody.querySelectorAll('tr')[row]
      if (!tr) return null
      const td = tr.querySelectorAll('td')[col + 1]
      if (!td) return null
      const containerRect = container.getBoundingClientRect()
      const tdRect = td.getBoundingClientRect()
      return {
        top:    tdRect.top    - containerRect.top,
        left:   tdRect.left   - containerRect.left,
        width:  tdRect.width,
        height: tdRect.height,
      }
    } catch { return null }
  }, [])

  // ── Save / autosave ─────────────────────────────────────────────────────────
  const doSave = useCallback(async (contentOverride, retryNum = 0) => {
    if (!id) return
    const content = contentOverride !== undefined ? contentOverride : dataRef.current
    try {
      await saveFileWithDraft(id, titleRef.current, content)
      setRetryCount(0)
    } catch {
      if (retryNum < 3) {
        const delay = RETRY_DELAY_MS * (retryNum + 1)
        retryTimer.current = setTimeout(() => {
          setRetryCount(retryNum + 1)
          doSave(undefined, retryNum + 1)
        }, delay)
      }
    }
  }, [id, saveFileWithDraft])

  const handleChange = (newData) => {
    setData(newData)
    markDirty(id)
    clearTimeout(saveTimer.current)
    clearTimeout(retryTimer.current)
    setRetryCount(0)
    if (Array.isArray(newData) && newData[0]?.celldata?.length) {
      const last = newData[0].celldata[newData[0].celldata.length - 1]
      if (last) broadcastSheetCursor(last.r, last.c)
    }
    // CRDT ops
    const session = gridSessionRef.current
    if (session && Array.isArray(newData) && newData[0]?.celldata) {
      for (const cell of newData[0].celldata) {
        const row = cell.r
        const col = cell.c
        const val = typeof cell.v === 'object'
          ? (cell.v?.v ?? cell.v?.m ?? '')
          : (cell.v ?? '')
        const existing = session.cells().find((c) => c.r === row && c.c === col)
        if (!existing || existing.v !== String(val)) {
          if (val === '' || val === null || val === undefined) {
            session.clearCell(row, col)
          } else {
            session.setCell(row, col, String(val))
          }
        }
      }
      session.saveLocal()
    }
    saveTimer.current = setTimeout(() => doSave(newData), AUTOSAVE_DELAY_MS)
  }

  const handleSave = () => {
    clearTimeout(saveTimer.current)
    clearTimeout(retryTimer.current)
    setRetryCount(0)
    doSave(dataRef.current)
  }

  const handleTitleChange = (newTitle) => {
    setTitle(newTitle)
    markDirty(id)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => doSave(dataRef.current), 1500)
  }

  const handleRestoreDraft  = () => { if (!draft) return; setData(draft.content); if (draft.name) setTitle(draft.name); setDraft(null); markDirty(id) }
  const handleDiscardDraft  = () => { clearDraft(id); setDraft(null) }

  // ── Import CSV ──────────────────────────────────────────────────────────────
  const handleImportCSV = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const sheet = await importCSVFile(file)
      // Append as a new sheet.
      setData((prev) => {
        const next = [...prev, sheet]
        markDirty(id)
        clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => doSave(next), AUTOSAVE_DELAY_MS)
        return next
      })
      showToast(`Imported “${file.name}”`, 'success')
    } catch (err) {
      console.error('CSV import failed:', err)
      showToast('Could not import CSV — check the file and try again.', 'error')
    }
    e.target.value = ''
  }

  // ── Import XLSX (server-side) ───────────────────────────────────────────────
  const handleImportXLSX = async (e) => {
    const file = e.target.files?.[0]
    if (!file || !id) return
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`/api/sheets/${id}/import`, { method: 'POST', body: form })
      if (res.ok) {
        // Reload file content from server.
        const updated = await api.getFile(id)
        setData(updated.content || data)
        showToast(`Imported “${file.name}”`, 'success')
      } else {
        console.error('XLSX import failed:', await res.text())
        showToast('Could not import spreadsheet — the server rejected the file.', 'error')
      }
    } catch (err) {
      console.error('XLSX import error:', err)
      showToast('Could not import spreadsheet — check your connection and try again.', 'error')
    }
    e.target.value = ''
  }

  // ── Filter view apply ───────────────────────────────────────────────────────
  const handleFilterApply = useCallback((hiddenRows) => {
    setData((prev) => prev.map((sheet, idx) => {
      if (idx !== 0) return sheet
      const rowhidden = {}
      for (const r of hiddenRows) rowhidden[r] = 1
      return { ...sheet, config: { ...sheet.config, rowhidden } }
    }))
  }, [])

  // ── Save status display ─────────────────────────────────────────────────────
  const statusInfo = (() => {
    switch (saveStatus.status) {
      case 'saving': return { text: 'Saving',  tone: 'muted',   icon: Loader2,    spin: true  }
      case 'saved':  return { text: 'Saved',   tone: 'success', icon: Check,      spin: false }
      case 'error':  return {
        text: retryCount > 0 ? `Retrying ${retryCount}/3` : 'Save failed',
        tone: 'danger', icon: AlertCircle, spin: false,
      }
      case 'dirty': return { text: 'Unsaved', tone: 'muted',   icon: Circle,     spin: false }
      default:      return null
    }
  })()
  const StatusIcon = statusInfo?.icon

  // Only one side panel open at a time (except comments).
  const closeAllPanels = () => {
    setShowPivot(false); setShowFilter(false)
    setShowCondFormat(false); setShowNamedRanges(false)
  }
  const togglePanel = (setter) => () => {
    setter((v) => {
      if (!v) closeAllPanels()
      return !v
    })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg">
      {/* Hidden file inputs for import */}
      <input ref={importInputRef} type="file" className="hidden" accept=".csv,.xlsx" onChange={(e) => {
        const name = e.target.files?.[0]?.name || ''
        if (name.endsWith('.xlsx')) handleImportXLSX(e)
        else handleImportCSV(e)
      }} />

      {/* Draft-restore banner */}
      {draft && (
        <div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-warning-bg border-b border-line text-xs text-warning animate-fade-in">
          <AlertCircle size={14} className="flex-shrink-0" />
          <span className="flex-1 text-ink-muted">Unsaved changes from a previous session were found.</span>
          <Button variant="primary"   size="sm" onClick={handleRestoreDraft}>Restore</Button>
          <Button variant="secondary" size="sm" onClick={handleDiscardDraft}>Discard</Button>
        </div>
      )}

      {/* Top bar */}
      <Topbar
        leading={
          <Tooltip label="Back to Sheets">
            <IconButton size="sm" onClick={() => navigate('/sheets')}><ArrowLeft size={15} /></IconButton>
          </Tooltip>
        }
        title={
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Untitled sheet"
            aria-label="Sheet title"
            className={[
              'flex-1 min-w-0 text-sm font-semibold tracking-tightish',
              'bg-transparent border border-transparent rounded-sm px-2 py-1',
              'text-ink placeholder:text-ink-faint',
              'hover:border-line focus:border-line-strong focus:bg-paper',
              'transition-[border-color,background] duration-fast ease-out outline-none',
            ].join(' ')}
          />
        }
        meta={
          statusInfo && (
            <span
              role="status"
              aria-live="polite"
              className={[
                'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm',
                statusInfo.tone === 'success' ? 'text-success' :
                statusInfo.tone === 'danger'  ? 'text-danger'  : 'text-ink-faint',
              ].join(' ')}
              title={saveStatus.error || ''}
            >
              {StatusIcon && <StatusIcon size={11} aria-hidden className={statusInfo.spin ? 'animate-spin' : ''} />}
              {statusInfo.text}
            </span>
          )
        }
        actions={
          <>
            {/* Find/Replace stays primary (always visible) */}
            <Tooltip label="Find / Replace (Ctrl+F)">
              <IconButton size="sm" active={showFindReplace} onClick={() => setShowFindReplace((v) => !v)}>
                <Search size={14} />
              </IconButton>
            </Tooltip>

            {/* Secondary tools — inline on ≥lg, collapsed into "More" below lg */}
            <div className="hidden lg:flex items-center gap-1">
              <FreezePanel workbookRef={workbookRef} />
              <Tooltip label="Cell comment">
                <IconButton size="sm" active={showCellComment} onClick={() => setShowCellComment((v) => !v)}>
                  <MessageSquarePlus size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Pivot table (Insert → Pivot table)">
                <IconButton size="sm" active={showPivot} onClick={togglePanel(setShowPivot)}>
                  <Table2 size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Filter views (Data → Filter views)">
                <IconButton size="sm" active={showFilter} onClick={togglePanel(setShowFilter)}>
                  <Filter size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Conditional formatting (Format → Conditional formatting)">
                <IconButton size="sm" active={showCondFormat} onClick={togglePanel(setShowCondFormat)}>
                  <Sliders size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Named ranges (Data → Named ranges)">
                <IconButton size="sm" active={showNamedRanges} onClick={togglePanel(setShowNamedRanges)}>
                  <Tag size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Insert chart">
                <IconButton size="sm" onClick={() => setShowChartWizard(true)}>
                  <BarChart2 size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Keyboard shortcuts (⌘/)">
                <IconButton size="sm" onClick={openHelp}>
                  <Keyboard size={14} />
                </IconButton>
              </Tooltip>
              <Tooltip label="Comments">
                <IconButton size="sm" active={showComments} onClick={() => setShowComments((v) => !v)}>
                  <MessageSquare size={14} />
                </IconButton>
              </Tooltip>
            </div>

            {/* Overflow "More" — below lg only */}
            <div className="lg:hidden">
              <Menu
                align="right"
                width="w-56"
                trigger={
                  <IconButton size="sm" title="More tools">
                    <MoreHorizontal size={16} />
                  </IconButton>
                }
              >
                <Menu.Item active={showCellComment} onClick={() => setShowCellComment((v) => !v)}>
                  <MessageSquarePlus size={14} /> Cell comment
                </Menu.Item>
                <Menu.Item active={showPivot} onClick={togglePanel(setShowPivot)}>
                  <Table2 size={14} /> Pivot table
                </Menu.Item>
                <Menu.Item active={showFilter} onClick={togglePanel(setShowFilter)}>
                  <Filter size={14} /> Filter views
                </Menu.Item>
                <Menu.Item active={showCondFormat} onClick={togglePanel(setShowCondFormat)}>
                  <Sliders size={14} /> Conditional formatting
                </Menu.Item>
                <Menu.Item active={showNamedRanges} onClick={togglePanel(setShowNamedRanges)}>
                  <Tag size={14} /> Named ranges
                </Menu.Item>
                <Menu.Item onClick={() => setShowChartWizard(true)}>
                  <BarChart2 size={14} /> Insert chart
                </Menu.Item>
                <Menu.Item onClick={openHelp}>
                  <Keyboard size={14} /> Keyboard shortcuts
                </Menu.Item>
                <Menu.Item active={showComments} onClick={() => setShowComments((v) => !v)}>
                  <MessageSquare size={14} /> Comments
                </Menu.Item>
              </Menu>
            </div>

            {/* Import menu */}
            <Menu
              align="right"
              trigger={
                <button type="button" className={MENU_TRIGGER_CN}>
                  <Upload size={12} /> Import
                  <ChevronDown size={11} className="opacity-60" />
                </button>
              }
            >
              <Menu.Item onClick={() => { if (importInputRef.current) { importInputRef.current.accept = '.csv'; importInputRef.current.click() } }}>
                <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-10">CSV</span>
                CSV file
              </Menu.Item>
              <Menu.Item onClick={() => { if (importInputRef.current) { importInputRef.current.accept = '.xlsx'; importInputRef.current.click() } }}>
                <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">XLSX</span>
                Excel workbook
              </Menu.Item>
            </Menu>

            {/* Export menu */}
            <Menu
              align="right"
              trigger={
                <button type="button" className={MENU_TRIGGER_CN}>
                  <Download size={12} /> Export
                  <ChevronDown size={11} className="opacity-60" />
                </button>
              }
            >
              <Menu.Item onClick={() => exportSheetsToXlsx(data, title)}>
                <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">XLSX</span>
                Excel workbook
              </Menu.Item>
              <Menu.Item onClick={() => exportSheetsToCsv(data, title)}>
                <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-10">CSV</span>
                Current sheet (CSV)
              </Menu.Item>
              {id && (
                <Menu.Item onClick={() => {
                  const a = document.createElement('a')
                  a.href = `/api/sheets/${id}/export?format=xlsx`
                  a.download = ''
                  document.body.appendChild(a)
                  a.click()
                  a.remove()
                }}>
                  <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">SRV</span>
                  Server XLSX
                </Menu.Item>
              )}
            </Menu>

            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saveStatus.status === 'saving'}
            >
              {saveStatus.status === 'saving' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </Button>
          </>
        }
      />

      {/* Main content area: workbook + side panels */}
      <div className="flex-1 flex overflow-hidden bg-bg">
        <div
          className="flex-1 overflow-hidden relative bg-paper sheets-themed"
          ref={workbookWrapRef}
        >
          <Workbook
            ref={workbookRef}
            data={data}
            onChange={handleChange}
            showFormulaBar={true}
            defaultFontSize={11}
            hooks={{
              afterSelectionChange: (_sheetId, selection) => {
                if (selection?.row_focus !== undefined) {
                  setActiveCell({ row: selection.row_focus, col: selection.column_focus })
                }
              },
            }}
          />
          <SheetsCursorLayer remoteCursors={remoteCursors} getCellRect={getCellRect} />
          {showCellComment && (
            <CellCommentPanel
              data={data}
              activeCell={activeCell}
              onChange={(updater) => {
                const next = typeof updater === 'function' ? updater(data) : updater
                handleChange(next)
              }}
              onClose={() => setShowCellComment(false)}
            />
          )}
          {showFindReplace && (
            <SheetsFindReplace
              data={data}
              onChange={(newData) => handleChange(newData)}
              onClose={() => setShowFindReplace(false)}
            />
          )}
        </div>

        {/* Side panels — one open at a time */}
        <Suspense fallback={null}>
          {showPivot && (
            <PivotPanel
              data={data}
              onClose={() => setShowPivot(false)}
              onInsert={(next) => { handleChange(next) }}
            />
          )}
          {showFilter && (
            <FilterPanel
              data={data}
              onClose={() => setShowFilter(false)}
              onApply={handleFilterApply}
            />
          )}
          {showCondFormat && (
            <ConditionalFormatPanel
              data={data}
              onClose={() => setShowCondFormat(false)}
              onChange={(next) => { handleChange(next) }}
            />
          )}
          {showNamedRanges && (
            <NamedRangesPanel
              data={data}
              onClose={() => setShowNamedRanges(false)}
              onChange={(next) => { handleChange(next) }}
            />
          )}
        </Suspense>

        {/* Comments panel */}
        {showComments && (
          <CommentsPanel
            fileId={id}
            anchorCtx={{ type: 'cell', sheet: 'Sheet1', row: 0, col: 0, snapshot: '' }}
            onClose={() => setShowComments(false)}
          />
        )}
      </div>

      {/* Modals */}
      <Suspense fallback={null}>
        {showChartWizard && (
          <ChartWizard
            data={data}
            onClose={() => setShowChartWizard(false)}
            onChange={(next) => { handleChange(next); setShowChartWizard(false) }}
          />
        )}
      </Suspense>

      {/* Keyboard shortcuts help */}
      {showShortcutsHelp && <KeyboardShortcutsHelp onClose={closeHelp} />}

      {/* Transient notifier (import success / failure, …) */}
      {toast}
    </div>
  )
}
