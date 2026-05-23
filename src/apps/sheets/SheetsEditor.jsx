import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
import {
  ArrowLeft, Save, Loader2, Download, AlertCircle, MessageSquare,
  Check, Circle, ChevronDown,
} from 'lucide-react'
import { useFilesStore, getSaveState, onSaveStateChange } from '../../store/filesStore'
import { api } from '../../lib/api'
import { readDraft, clearDraft } from '../../lib/draftStore'
import { exportSheetsToXlsx, exportSheetsToCsv } from './sheetsExport'
import { GridSession, getGridReplicaId } from '../../lib/crdt/grid.js'
import CommentsPanel from '../../components/CommentsPanel'
import { useLiveCursors } from '../../lib/useLiveCursors.js'
import { SheetsCursorLayer } from '../../components/RemoteCursors.jsx'
import { Button, IconButton, Tooltip, Topbar } from '../../components/ui'

const RETRY_DELAY_MS = 4000
const AUTOSAVE_DELAY_MS = 3000

export default function SheetsEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { files, saveFileWithDraft, markDirty } = useFilesStore()
  const [file, setFile] = useState(files.find((f) => f.id === id))
  const [title, setTitle] = useState(file?.name || 'Untitled Sheet')
  const [data, setData] = useState(file?.content || [{ name: 'Sheet1', celldata: [], config: {} }])
  const [saveStatus, setSaveStatus] = useState(getSaveState(id))
  const [draft, setDraft] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const [showComments, setShowComments] = useState(false)
  const saveTimer = useRef(null)
  const retryTimer = useRef(null)
  const titleRef = useRef(title)
  titleRef.current = title
  const dataRef = useRef(data)
  dataRef.current = data
  const gridSessionRef = useRef(null)

  // OFFICE-23: boot a GridSession for CRDT collaboration on this file.
  // fabricClient is null until OFFICE-20 supplies one; the session still
  // runs local-only (localStorage persistence + offline convergence).
  useEffect(() => {
    if (!id) return
    const replicaId = getGridReplicaId()
    const session = new GridSession({ sessionId: id, replicaId, fabricClient: null })
    gridSessionRef.current = session

    // Request a snapshot from any already-connected peers.
    session.requestSnapshot()

    // On remote op — merge CRDT cells into the current sheet data.
    const onRemote = () => {
      const crdtCells = session.cells()
      if (crdtCells.length === 0) return
      setData((prev) => {
        // Merge CRDT cells into the first sheet's celldata without clobbering
        // cells that are not managed by the CRDT (e.g. formatting).
        const sheets = prev.map((sheet, idx) => {
          if (idx !== 0) return sheet
          // Build a map of existing celldata keyed by "r_c".
          const existing = new Map((sheet.celldata || []).map((c) => [`${c.r}_${c.c}`, c]))
          for (const { r, c, v } of crdtCells) {
            const key = `${r}_${c}`
            const ex = existing.get(key)
            // Only update if the value actually differs to avoid flicker.
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

  // Subscribe to save state changes for this file
  useEffect(() => {
    const unsub = onSaveStateChange(id, (state) => setSaveStatus({ ...state }))
    return unsub
  }, [id])

  useEffect(() => {
    if (!file && id) {
      api.getFile(id).then((f) => {
        setFile(f)
        setTitle(f.name)
        setData(f.content || [{ name: 'Sheet1', celldata: [], config: {} }])
      }).catch(() => navigate('/sheets'))
    }
  }, [id])

  // Check for a pending draft on mount (crash recovery)
  useEffect(() => {
    if (!id) return
    readDraft(id).then((d) => {
      if (d && d.ts) setDraft(d)
    })
  }, [id])

  // ── OFFICE-25: Live cursors ───────────────────────────────────────────────
  // fabric is null until OFFICE-20 is wired; hook is a graceful no-op until then.
  // Cursor colour pulled from the accent ramp so remote highlights sit calmly
  // alongside the warm-neutral surface (no generic indigo).
  const { remoteCursors, broadcastSheetCursor } = useLiveCursors({
    fabric: null, localIdentity: null, color: 'var(--teal-500)',
  })

  // Reference to the Fortune Sheet container so we can measure cell positions.
  const workbookWrapRef = useRef(null)

  /** Approximate cell rect from the Fortune Sheet DOM (best-effort). */
  const getCellRect = useCallback((row, col) => {
    const container = workbookWrapRef.current
    if (!container) return null
    // Fortune Sheet renders cells as <td> inside .luckysheet-cell-main.
    // Row/col indexing starts at 0. We query the tr[row] > td[col+1] pattern.
    try {
      const tbody = container.querySelector('.luckysheet-cell-main tbody')
      if (!tbody) return null
      const tr = tbody.querySelectorAll('tr')[row]
      if (!tr) return null
      // col+1 because the first td is the row-header
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
    } catch {
      return null
    }
  }, [])

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
    // OFFICE-25: broadcast the first edited cell as the local cursor position.
    if (Array.isArray(newData) && newData[0]?.celldata?.length) {
      const last = newData[0].celldata[newData[0].celldata.length - 1]
      if (last) broadcastSheetCursor(last.r, last.c)
    }
    // OFFICE-23: emit CRDT ops for changed cells so peers converge.
    // Compare the first sheet's celldata to detect which cells changed.
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

  const handleRestoreDraft = () => {
    if (!draft) return
    setData(draft.content)
    if (draft.name) setTitle(draft.name)
    setDraft(null)
    markDirty(id)
  }

  const handleDiscardDraft = () => {
    clearDraft(id)
    setDraft(null)
  }

  // Discreet save status — a meta-line, never a banner.
  // Mirrors DocsEditor: an icon + short word in muted ink so the user
  // doesn't have to keep scanning to verify the doc is safe.
  const statusInfo = (() => {
    switch (saveStatus.status) {
      case 'saving':
        return { text: 'Saving',  tone: 'muted',   icon: Loader2,    spin: true  }
      case 'saved':
        return { text: 'Saved',   tone: 'success', icon: Check,      spin: false }
      case 'error':
        return {
          text: retryCount > 0 ? `Retrying ${retryCount}/3` : 'Save failed',
          tone: 'danger',
          icon: AlertCircle,
          spin: false,
        }
      case 'dirty':
        return { text: 'Unsaved', tone: 'muted',   icon: Circle,     spin: false }
      default:
        return null
    }
  })()
  const StatusIcon = statusInfo?.icon

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg">
      {/* Draft-restore — only banner we keep (requires user action). */}
      {draft && (
        <div className="flex items-center gap-3 px-4 py-2 bg-warning-bg border-b border-line text-xs text-warning animate-fade-in">
          <AlertCircle size={14} className="flex-shrink-0" />
          <span className="flex-1 text-ink-muted">
            Unsaved changes from a previous session were found.
          </span>
          <Button variant="primary" size="sm" onClick={handleRestoreDraft}>Restore</Button>
          <Button variant="secondary" size="sm" onClick={handleDiscardDraft}>Discard</Button>
        </div>
      )}

      {/* Top bar — composed from the design system, mirroring DocsEditor. */}
      <Topbar
        leading={
          <Tooltip label="Back to Sheets">
            <IconButton size="sm" onClick={() => navigate('/sheets')}>
              <ArrowLeft size={15} />
            </IconButton>
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
              className={[
                'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm',
                statusInfo.tone === 'success' ? 'text-success' :
                statusInfo.tone === 'danger'  ? 'text-danger' :
                                                'text-ink-faint',
              ].join(' ')}
              title={saveStatus.error || ''}
            >
              {StatusIcon && (
                <StatusIcon
                  size={11}
                  className={statusInfo.spin ? 'animate-spin' : ''}
                />
              )}
              {statusInfo.text}
            </span>
          )
        }
        actions={
          <>
            <Tooltip label="Comments">
              <IconButton
                size="sm"
                active={showComments}
                onClick={() => setShowComments((v) => !v)}
              >
                <MessageSquare size={14} />
              </IconButton>
            </Tooltip>
            {/* Export — quiet secondary so it doesn't compete with primary Save. */}
            <div className="relative group">
              <button
                type="button"
                aria-haspopup="menu"
                className={[
                  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md',
                  'bg-paper border border-line text-xs font-medium tracking-tightish',
                  'text-ink-muted hover:border-line-strong hover:text-ink',
                  'transition-colors duration-fast ease-out',
                  'focus-visible:outline-none focus-visible:shadow-focus',
                ].join(' ')}
              >
                <Download size={12} /> Export
                <ChevronDown size={11} className="opacity-60" />
              </button>
              <div
                role="menu"
                className={[
                  'absolute right-0 top-full mt-0.5 w-44 py-1',
                  'bg-paper border border-line rounded-md shadow-e2 z-30 text-sm',
                  'hidden group-hover:block animate-scale-in',
                ].join(' ')}
              >
                <button
                  role="menuitem"
                  onClick={() => exportSheetsToXlsx(data, title)}
                  className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2"
                >
                  <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">XLSX</span>
                  Excel workbook
                </button>
                <button
                  role="menuitem"
                  onClick={() => exportSheetsToCsv(data, title)}
                  className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2"
                >
                  <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-10">CSV</span>
                  Comma-separated
                </button>
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saveStatus.status === 'saving'}
            >
              {saveStatus.status === 'saving'
                ? <Loader2 size={13} className="animate-spin" />
                : <Save size={13} />}
              Save
            </Button>
          </>
        }
      />

      {/* Workbook + optional comments panel.
          We wrap Fortune Sheet in `sheets-themed` so a small set of CSS rules
          re-tint cell selection / column headers with the design tokens,
          without touching the library's grid internals. */}
      <div className="flex-1 flex overflow-hidden bg-bg">
        <div
          className="flex-1 overflow-hidden relative bg-paper sheets-themed"
          ref={workbookWrapRef}
        >
          <Workbook
            data={data}
            onChange={handleChange}
          />
          {/* OFFICE-25: remote cell selection overlays */}
          <SheetsCursorLayer remoteCursors={remoteCursors} getCellRect={getCellRect} />
        </div>

        {/* Comments panel (OFFICE-26) */}
        {showComments && (
          <CommentsPanel
            fileId={id}
            anchorCtx={{ type: 'cell', sheet: 'Sheet1', row: 0, col: 0, snapshot: '' }}
            onClose={() => setShowComments(false)}
          />
        )}
      </div>
    </div>
  )
}
