import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, Table2, Presentation, Loader2 } from 'lucide-react'
import { useFilesStore } from '../store/filesStore'
import { Button, Input, Modal, DocThumb } from './ui'

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
]

const ROUTE = { doc: 'docs', sheet: 'sheets', slide: 'slides' }

/**
 * NewFileModal — uses Modal primitive + Card-based template grid.
 *
 * Props:
 *   onClose       fn
 *   defaultType   'doc' | 'sheet' | 'slide'
 *   lockType      if provided, skip the type picker
 */
export default function NewFileModal({ onClose, defaultType, lockType }) {
  const [selectedType, setSelectedType] = useState(lockType || defaultType || 'doc')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const { createFile } = useFilesStore()
  const navigate = useNavigate()

  const selected = TYPES.find(t => t.type === selectedType)

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      const file = await createFile(name.trim(), selectedType)
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
          {/* ── Template grid — only shown when not locked ── */}
          {!lockType && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                {TYPES.map(({ type, label, borderActive, bgActive }) => {
                  const active = selectedType === type
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedType(type)}
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
                <p className="text-2xs text-ink-faint text-center tracking-tightish">
                  {selected.desc}
                </p>
              )}
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
          <Button variant="secondary" size="md" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            disabled={!name.trim() || creating}
          >
            {creating ? (
              <><Loader2 size={13} className="animate-spin" /> Creating…</>
            ) : (
              'Create'
            )}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
