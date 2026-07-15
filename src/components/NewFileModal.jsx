import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Table2, Presentation, PenTool, Loader2, Check } from 'lucide-react'
import { useFilesStore } from '../store/filesStore'
import { Button, Input, Modal, DocThumb } from './ui'
import { templatesFor } from '../lib/templates'

// ─── Template definitions ─────────────────────────────────────────────────────
const TYPES = [
  {
    type: 'doc',
    label: 'Document',
    desc: 'Rich text with images, tables, and formatting',
    icon: FileText,
    iconCn: 'text-accent',
    bgCn: 'bg-accent-tint',
    borderActive: 'border-accent',
    bgActive: 'bg-accent-tint',
  },
  {
    type: 'sheet',
    label: 'Spreadsheet',
    desc: 'Formulas, sorting, and structured data',
    icon: Table2,
    iconCn: 'text-success',
    bgCn: 'bg-success-bg',
    borderActive: 'border-success',
    bgActive: 'bg-success-bg',
  },
  {
    type: 'slide',
    label: 'Presentation',
    desc: 'Slides with themes and transitions',
    icon: Presentation,
    iconCn: 'text-warning',
    bgCn: 'bg-warning-bg',
    borderActive: 'border-warning',
    bgActive: 'bg-warning-bg',
  },
  {
    type: 'whiteboard',
    label: 'Whiteboard',
    desc: 'Infinite canvas for diagrams and sketches',
    icon: PenTool,
    iconCn: 'text-app-board',
    bgCn: 'bg-app-board-bg',
    borderActive: 'border-app-board',
    bgActive: 'bg-app-board-bg',
  },
]

const ROUTE = { doc: 'docs', sheet: 'sheets', slide: 'slides', whiteboard: 'whiteboards' }

/**
 * NewFileModal — Modal primitive + type picker + (for Docs/Sheets) a built-in
 * template gallery. Selecting a template seeds the new file's content.
 *
 * Props:
 *   onClose       fn
 *   defaultType   'doc' | 'sheet' | 'slide'
 *   lockType      if provided, skip the type picker
 *   parentId      folder id to file the new document into ('' = root)
 */
export default function NewFileModal({ onClose, defaultType, lockType, parentId = '' }) {
  const [selectedType, setSelectedType] = useState(lockType || defaultType || 'doc')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [templateId, setTemplateId] = useState('blank')
  const { createFile } = useFilesStore()
  const navigate = useNavigate()

  const selected = TYPES.find(t => t.type === selectedType)
  const templates = templatesFor(selectedType) // null for slides (own gallery)
  const activeTemplate = templates?.find(t => t.id === templateId) || null

  const handleType = (type) => {
    setSelectedType(type)
    setTemplateId('blank') // reset template when the type changes
  }

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      const file = await createFile(name.trim(), selectedType, {
        content: activeTemplate ? activeTemplate.content : undefined,
        parentId,
      })
      onClose()
      navigate(`/${ROUTE[selectedType]}/${file.id}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={lockType ? `New ${selected?.label}` : 'New file'}
      size="sm"
    >
      <form onSubmit={handleCreate}>
        <Modal.Body className="space-y-5">
          {/* ── Type grid — only shown when not locked ── */}
          {!lockType && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {TYPES.map(({ type, label, borderActive, bgActive }) => {
                  const active = selectedType === type
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleType(type)}
                      className={[
                        'group flex flex-col items-center gap-2.5 p-2.5 rounded-lg border-2',
                        'transition-[border-color,background,transform] duration-fast ease-out',
                        'focus-visible:outline-none focus-visible:shadow-focus',
                        active
                          ? `${borderActive} ${bgActive}`
                          : 'border-line hover:border-line-strong bg-paper hover:-translate-y-0.5',
                      ].join(' ')}
                    >
                      <span className="w-full h-16 rounded-md overflow-hidden border border-line">
                        <DocThumb type={type} className="h-full" />
                      </span>
                      <span className="text-xs font-semibold text-ink tracking-tightish">{label}</span>
                    </button>
                  )
                })}
              </div>
              {selected && (
                <p className="text-2xs text-ink-faint text-center tracking-tightish">{selected.desc}</p>
              )}
            </div>
          )}

          {/* ── Template gallery (Docs + Sheets) ── */}
          {templates && (
            <div className="space-y-2">
              <p className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Start from a template</p>
              <div className="grid grid-cols-2 gap-2">
                {templates.map((t) => {
                  const active = templateId === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTemplateId(t.id)}
                      className={[
                        'relative flex flex-col items-start gap-0.5 p-2.5 rounded-lg border text-left',
                        'transition-[border-color,background] duration-fast ease-out',
                        'focus-visible:outline-none focus-visible:shadow-focus',
                        active ? 'border-accent bg-accent-tint' : 'border-line hover:border-line-strong bg-paper',
                      ].join(' ')}
                    >
                      {active && (
                        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-accent text-white flex items-center justify-center">
                          <Check size={11} />
                        </span>
                      )}
                      <span className="text-xs font-semibold text-ink tracking-tightish">{t.label}</span>
                      <span className="text-2xs text-ink-faint leading-tight">{t.desc}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Name field ── */}
          <Input
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={`Untitled ${selected?.label || 'file'}`}
            autoFocus
            size="md"
          />
        </Modal.Body>

        <Modal.Footer>
          <Button variant="secondary" size="md" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" type="submit" disabled={!name.trim() || creating}>
            {creating ? (<><Loader2 size={13} className="animate-spin" /> Creating…</>) : 'Create'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
