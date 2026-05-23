import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Placeholder from '@tiptap/extension-placeholder'
import {
  ArrowLeft, Save, Loader2, Play, Plus, Trash2,
  ChevronUp, ChevronDown, Download, EyeOff, MessageSquare,
  Bold, Italic, Underline as UnderlineIcon,
  AlignLeft, AlignCenter, AlignRight, List, Image as ImageIcon,
  Check, Circle, AlertCircle, StickyNote,
} from 'lucide-react'
import DOMPurify from 'dompurify'
import { useFilesStore } from '../../store/filesStore'
import { api } from '../../lib/api'
import SlidePreview from './SlidePreview'
import { exportSlidesToPdf, exportSlidesToPptx } from './slidesExport'
import { TreeSession, getTreeReplicaId, ordKeyBetween } from '../../lib/crdt/tree.js'
import CommentsPanel from '../../components/CommentsPanel'
import { useLiveCursors } from '../../lib/useLiveCursors.js'
import { getSlideViewers } from '../../components/RemoteCursors.jsx'
import { Button, IconButton, Tooltip, Topbar } from '../../components/ui'

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
                'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress'],
}

const sanitize = (html) => DOMPurify.sanitize(html ?? '', PURIFY_CONFIG)

const THEMES = ['black', 'white', 'league', 'beige', 'sky', 'night', 'serif', 'simple', 'solarized', 'moon', 'dracula']
const TRANSITIONS = ['none', 'fade', 'slide', 'convex', 'concave', 'zoom']

function newSlide() {
  return { id: crypto.randomUUID(), title: '', content: '<p></p>', notes: '', background: '' }
}

export default function SlidesEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { files, updateFile } = useFilesStore()
  const stored = files.find((f) => f.id === id)
  const [file, setFile] = useState(stored)

  const defaultData = file?.content && file.content.slides
    ? file.content
    : { theme: 'black', transition: 'slide', slides: [newSlide()] }

  const [title, setTitle] = useState(file?.name || 'Untitled Presentation')
  const [slidesData, setSlidesData] = useState(defaultData)
  const [activeIdx, setActiveIdx] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
  const [presenting, setPresenting] = useState(false)
  const [showComments, setShowComments] = useState(false)
  const saveTimer = useRef(null)
  const imgInput = useRef(null)
  const treeSessionRef = useRef(null)

  const activeSlide = slidesData.slides[activeIdx] ?? slidesData.slides[0]

  // ── OFFICE-25: Live cursors (slide viewers) ───────────────────────────────
  // fabric is null until OFFICE-20 is wired; hook is a graceful no-op.
  // Colour comes from a warm signal (honey) so viewer badges sit comfortably
  // on the paper canvas instead of shouting a generic amber.
  const { remoteCursors, broadcastSlideCursor } = useLiveCursors({
    fabric: null, localIdentity: null, color: 'var(--signal-warning)',
  })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Image.configure({ allowBase64: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Underline,
      TextStyle,
      Color,
      Placeholder.configure({ placeholder: 'Slide content…' }),
    ],
    content: activeSlide?.content || '<p></p>',
    onUpdate: ({ editor }) => {
      updateSlideField(activeIdx, 'content', editor.getHTML())
    },
  })

  useEffect(() => {
    if (!file && id) {
      api.getFile(id).then((f) => {
        setFile(f)
        setTitle(f.name)
        if (f.content?.slides) setSlidesData(f.content)
      }).catch(() => navigate('/slides'))
    }
  }, [id])

  // OFFICE-23: boot a TreeSession for CRDT collaboration on this presentation.
  // fabricClient is null until OFFICE-20 is wired; runs local-only in the meantime.
  useEffect(() => {
    if (!id) return
    const replicaId = getTreeReplicaId()
    const session = new TreeSession({ sessionId: id, replicaId, fabricClient: null })
    treeSessionRef.current = session

    // Seed the CRDT with the initial slides so we have nodes for them.
    // Only insert nodes that the CRDT doesn't already know about (idempotent).
    // We wait until slidesData is populated via the file load above.
    // We defer to next tick to allow state to settle.
    const seedTimer = setTimeout(() => {
      setSlidesData((current) => {
        const existing = session.orderedSlides().map((s) => s.nodeId)
        current.slides.forEach((slide, idx) => {
          if (!existing.includes(slide.id)) {
            const ordKey = String(idx).padStart(10, '0')
            // Insert using the existing slide.id as the CRDT node id.
            // We call internal ops directly via insertSlide (which generates its
            // own id), so instead we use setSlide to upsert the content only —
            // to keep the slide.id stable we store data keyed by slide.id.
            // Preferred: use insertSlide but pass an ordKey that reflects order.
            session.insertSlide(ordKey, slide)
          }
        })
        return current
      })
    }, 0)

    session.requestSnapshot()

    // On remote op — merge CRDT tree into local slidesData.
    const onRemote = () => {
      const crdtSlides = session.orderedSlides()
      if (crdtSlides.length === 0) return
      setSlidesData((prev) => {
        const next = {
          ...prev,
          slides: crdtSlides
            .filter((s) => s.data && typeof s.data === 'object')
            .map((s) => ({ ...s.data })),
        }
        schedule(next)
        return next
      })
    }

    session.addEventListener('remoteOp', onRemote)
    return () => {
      clearTimeout(seedTimer)
      session.removeEventListener('remoteOp', onRemote)
      session.destroy()
      treeSessionRef.current = null
    }
  }, [id]) // eslint-disable-line

  // Sync editor when switching slides
  useEffect(() => {
    if (editor && activeSlide) {
      editor.commands.setContent(activeSlide.content || '<p></p>', false)
    }
    // OFFICE-25: broadcast which slide the local user is viewing.
    if (activeSlide?.id) broadcastSlideCursor(activeSlide.id)
  }, [activeIdx]) // eslint-disable-line

  const autosave = useCallback(async (sd) => {
    if (!id) return
    setSaving(true)
    try {
      await updateFile(id, title, sd)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }, [id, title])

  const schedule = (sd) => {
    setSaved(false)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => autosave(sd), 2000)
  }

  const updateSlideField = (idx, field, value) => {
    setSlidesData((prev) => {
      const slides = [...prev.slides]
      slides[idx] = { ...slides[idx], [field]: value }
      const next = { ...prev, slides }
      schedule(next)
      // OFFICE-23: broadcast updated slide content via CRDT.
      const session = treeSessionRef.current
      if (session) {
        const slide = slides[idx]
        session.setSlide(slide.id, slide)
        session.saveLocal()
      }
      return next
    })
  }

  const addSlide = () => {
    setSlidesData((prev) => {
      const slide = newSlide()
      const slides = [...prev.slides, slide]
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(slides.length - 1)
      // OFFICE-23: insert the new slide into the CRDT tree.
      const session = treeSessionRef.current
      if (session) {
        const prevOrdKey = slides.length >= 2
          ? String(slides.length - 2).padStart(10, '0')
          : ''
        const ordKey = ordKeyBetween(prevOrdKey, '')
        session.insertSlide(ordKey, slide)
        session.saveLocal()
      }
      return next
    })
  }

  const deleteSlide = (idx) => {
    setSlidesData((prev) => {
      if (prev.slides.length === 1) return prev
      const slide = prev.slides[idx]
      const slides = prev.slides.filter((_, i) => i !== idx)
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(Math.min(idx, slides.length - 1))
      // OFFICE-23: tombstone the deleted slide in the CRDT.
      const session = treeSessionRef.current
      if (session) {
        session.deleteSlide(slide.id)
        session.saveLocal()
      }
      return next
    })
  }

  const moveSlide = (idx, dir) => {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= slidesData.slides.length) return
    setSlidesData((prev) => {
      const slides = [...prev.slides];
      [slides[idx], slides[newIdx]] = [slides[newIdx], slides[idx]]
      const next = { ...prev, slides }
      schedule(next)
      setActiveIdx(newIdx)
      // OFFICE-23: update ordKey for the moved slide.
      const session = treeSessionRef.current
      if (session) {
        const beforeKey = newIdx > 0 ? String(newIdx - 1).padStart(10, '0') : ''
        const afterKey  = newIdx < slides.length - 1 ? String(newIdx + 1).padStart(10, '0') : ''
        const newOrdKey = ordKeyBetween(beforeKey, afterKey)
        session.moveSlide(slides[newIdx].id, newOrdKey)
        session.saveLocal()
      }
      return next
    })
  }

  const updateMeta = (key, value) => {
    const next = { ...slidesData, [key]: value }
    setSlidesData(next)
    schedule(next)
  }

  const handleImageUpload = async (e) => {
    const f = e.target.files?.[0]
    if (!f || !editor) return
    try {
      const { url } = await api.uploadImage(f)
      editor.chain().focus().setImage({ src: url }).run()
    } catch {
      const reader = new FileReader()
      reader.onload = (ev) => { if (ev.target?.result) editor.chain().focus().setImage({ src: ev.target.result }).run() }
      reader.readAsDataURL(f)
    }
    e.target.value = ''
  }

  if (!editor) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <Loader2 className="animate-spin text-accent" size={22} />
      </div>
    )
  }

  // Discreet save status — meta-line, not banner (matches DocsEditor).
  const statusInfo = (() => {
    if (saving)  return { text: 'Saving',  tone: 'muted',   icon: Loader2,    spin: true  }
    if (saved)   return { text: 'Saved',   tone: 'success', icon: Check,      spin: false }
    return         { text: 'Unsaved', tone: 'muted',   icon: Circle,     spin: false }
  })()
  const StatusIcon = statusInfo.icon

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg">
      {/* Top bar — composed from the design system, mirroring DocsEditor. */}
      <Topbar
        leading={
          <Tooltip label="Back to Slides">
            <IconButton size="sm" onClick={() => navigate('/slides')}>
              <ArrowLeft size={15} />
            </IconButton>
          </Tooltip>
        }
        title={
          <input
            value={title}
            onChange={(e) => { setTitle(e.target.value); setSaved(false) }}
            placeholder="Untitled presentation"
            aria-label="Presentation title"
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
          <span
            className={[
              'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm',
              statusInfo.tone === 'success' ? 'text-success' :
              statusInfo.tone === 'danger'  ? 'text-danger' :
                                              'text-ink-faint',
            ].join(' ')}
          >
            <StatusIcon size={11} className={statusInfo.spin ? 'animate-spin' : ''} />
            {statusInfo.text}
          </span>
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPresenting(!presenting)}
              aria-pressed={presenting}
            >
              {presenting ? <><EyeOff size={13} /> Edit</> : <><Play size={13} /> Present</>}
            </Button>
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
                  'absolute right-0 top-full mt-0.5 w-48 py-1',
                  'bg-paper border border-line rounded-md shadow-e2 z-30 text-sm',
                  'hidden group-hover:block animate-scale-in',
                ].join(' ')}
              >
                <button
                  role="menuitem"
                  onClick={() => exportSlidesToPdf(title)}
                  className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2"
                >
                  <span className="text-2xs font-bold tracking-eyebrow text-danger w-10">PDF</span>
                  Print to PDF
                </button>
                <button
                  role="menuitem"
                  onClick={() => exportSlidesToPptx(slidesData, title)}
                  className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2"
                >
                  <span className="text-2xs font-bold tracking-eyebrow text-accent w-10">PPTX</span>
                  PowerPoint
                </button>
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { clearTimeout(saveTimer.current); autosave(slidesData) }}
              disabled={saving}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </Button>
          </>
        }
      />

      {presenting ? (
        <SlidePreview data={slidesData} onClose={() => setPresenting(false)} />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Slide list — clay panel with the same warm-neutral language as the
              sidebar. Selected thumbnail is marked with a quiet 2-px accent
              rail, not a coloured frame (mirrors Sidebar pattern). */}
          <aside className="w-56 flex-shrink-0 bg-clay border-r border-line flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 h-9 border-b border-line">
              <span className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow">
                Slides · {slidesData.slides.length}
              </span>
              <Tooltip label="Add slide">
                <IconButton size="sm" onClick={addSlide} aria-label="Add slide">
                  <Plus size={13} />
                </IconButton>
              </Tooltip>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
              {slidesData.slides.map((slide, idx) => {
                const viewers = getSlideViewers(remoteCursors, slide.id)
                const isActive = idx === activeIdx
                return (
                  <div
                    key={slide.id}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => setActiveIdx(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setActiveIdx(idx)
                      }
                    }}
                    className={[
                      'group relative cursor-pointer rounded-md overflow-hidden',
                      'transition-[box-shadow,background] duration-fast ease-out',
                      'focus-visible:outline-none focus-visible:shadow-focus',
                      isActive
                        ? 'bg-paper shadow-e1'
                        : 'bg-paper/60 hover:bg-paper',
                    ].join(' ')}
                  >
                    {/* Active rail — quiet 2 px accent on the left, mirrors Sidebar. */}
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent rounded-r-sm"
                      />
                    )}
                    <div
                      className="h-20 flex flex-col items-start justify-start p-2 text-left border border-line rounded-md"
                      style={{ background: slide.background || undefined }}
                    >
                      <div
                        className={[
                          'text-2xs font-semibold truncate w-full tracking-tightish',
                          slide.background ? 'text-white' : 'text-ink',
                        ].join(' ')}
                      >
                        {slide.title || `Slide ${idx + 1}`}
                      </div>
                      <div
                        className={[
                          'text-[10px] mt-1 w-full overflow-hidden line-clamp-3 leading-snug',
                          slide.background ? 'text-white/70' : 'text-ink-faint',
                        ].join(' ')}
                        dangerouslySetInnerHTML={{ __html: sanitize(slide.content) }}
                      />
                    </div>
                    {/* Slide index — micro label, eyebrow tracking. */}
                    <div
                      className={[
                        'absolute top-1 left-1.5 text-[9px] font-semibold tracking-eyebrow uppercase px-1 rounded-sm',
                        slide.background
                          ? 'text-white/80 bg-black/30'
                          : 'text-ink-faint bg-bg-elev2',
                      ].join(' ')}
                    >
                      {String(idx + 1).padStart(2, '0')}
                    </div>
                    {/* OFFICE-25: remote viewer badges */}
                    {viewers.length > 0 && (
                      <div className="absolute bottom-1 left-1.5 flex gap-0.5">
                        {viewers.map((v) => (
                          <span
                            key={v.accountId}
                            title={v.displayName}
                            aria-label={v.displayName}
                            className="flex items-center justify-center rounded-pill text-white font-bold select-none"
                            style={{
                              background: v.color,
                              width: 14, height: 14, fontSize: 8,
                            }}
                          >
                            {(v.displayName || '?')[0].toUpperCase()}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5">
                      <IconButton
                        size="sm"
                        title="Move up"
                        className="h-5 w-5"
                        onClick={(e) => { e.stopPropagation(); moveSlide(idx, -1) }}
                      >
                        <ChevronUp size={10} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        title="Move down"
                        className="h-5 w-5"
                        onClick={(e) => { e.stopPropagation(); moveSlide(idx, 1) }}
                      >
                        <ChevronDown size={10} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        title="Delete slide"
                        className="h-5 w-5 hover:text-danger"
                        onClick={(e) => { e.stopPropagation(); deleteSlide(idx) }}
                      >
                        <Trash2 size={10} />
                      </IconButton>
                    </div>
                  </div>
                )
              })}
            </div>
            {/* Meta controls — theme + transition, quiet selects. */}
            <div className="px-3 py-3 border-t border-line space-y-2.5 bg-clay">
              <div>
                <label className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow block mb-1">
                  Theme
                </label>
                <select
                  value={slidesData.theme}
                  onChange={(e) => updateMeta('theme', e.target.value)}
                  className={[
                    'w-full bg-paper text-ink text-xs rounded-sm px-2 h-7',
                    'border border-line hover:border-line-strong',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                    'transition-colors duration-fast ease-out',
                  ].join(' ')}
                >
                  {THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow block mb-1">
                  Transition
                </label>
                <select
                  value={slidesData.transition}
                  onChange={(e) => updateMeta('transition', e.target.value)}
                  className={[
                    'w-full bg-paper text-ink text-xs rounded-sm px-2 h-7',
                    'border border-line hover:border-line-strong',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                    'transition-colors duration-fast ease-out',
                  ].join(' ')}
                >
                  {TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
          </aside>

          {/* Editor */}
          {activeSlide && (
            <div className="flex-1 flex flex-col overflow-hidden bg-bg">
              <div className="px-6 pt-4 pb-2 bg-paper border-b border-line">
                <input
                  value={activeSlide.title}
                  onChange={(e) => updateSlideField(activeIdx, 'title', e.target.value)}
                  className={[
                    'w-full text-2xl font-bold tracking-tightish font-serif',
                    'bg-transparent border-none outline-none',
                    'text-ink placeholder:text-ink-faint',
                  ].join(' ')}
                  placeholder="Slide title…"
                  aria-label="Slide title"
                />
              </div>

              {/* Mini toolbar — token-driven, quiet ribbon (mirrors DocsToolbar). */}
              <div
                className="flex items-center gap-0.5 px-3 h-10 bg-paper border-b border-line flex-wrap"
                role="toolbar"
                aria-label="Slide formatting"
              >
                <Tooltip label="Bold (⌘B)">
                  <IconButton
                    size="sm"
                    active={editor.isActive('bold')}
                    onClick={() => editor.chain().focus().toggleBold().run()}
                    aria-label="Bold"
                  >
                    <Bold size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Italic (⌘I)">
                  <IconButton
                    size="sm"
                    active={editor.isActive('italic')}
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                    aria-label="Italic"
                  >
                    <Italic size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Underline (⌘U)">
                  <IconButton
                    size="sm"
                    active={editor.isActive('underline')}
                    onClick={() => editor.chain().focus().toggleUnderline().run()}
                    aria-label="Underline"
                  >
                    <UnderlineIcon size={14} />
                  </IconButton>
                </Tooltip>
                <span className="toolbar-divider" />
                <Tooltip label="Align left">
                  <IconButton
                    size="sm"
                    active={editor.isActive({ textAlign: 'left' })}
                    onClick={() => editor.chain().focus().setTextAlign('left').run()}
                    aria-label="Align left"
                  >
                    <AlignLeft size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Align center">
                  <IconButton
                    size="sm"
                    active={editor.isActive({ textAlign: 'center' })}
                    onClick={() => editor.chain().focus().setTextAlign('center').run()}
                    aria-label="Align center"
                  >
                    <AlignCenter size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Align right">
                  <IconButton
                    size="sm"
                    active={editor.isActive({ textAlign: 'right' })}
                    onClick={() => editor.chain().focus().setTextAlign('right').run()}
                    aria-label="Align right"
                  >
                    <AlignRight size={14} />
                  </IconButton>
                </Tooltip>
                <span className="toolbar-divider" />
                <Tooltip label="Bullet list">
                  <IconButton
                    size="sm"
                    active={editor.isActive('bulletList')}
                    onClick={() => editor.chain().focus().toggleBulletList().run()}
                    aria-label="Bullet list"
                  >
                    <List size={14} />
                  </IconButton>
                </Tooltip>
                <Tooltip label="Insert image">
                  <IconButton
                    size="sm"
                    onClick={() => imgInput.current?.click()}
                    aria-label="Insert image"
                  >
                    <ImageIcon size={14} />
                  </IconButton>
                </Tooltip>
                <input
                  ref={imgInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageUpload}
                />
                <span className="toolbar-divider" />
                {/* Slide background — quiet swatch input. */}
                <label
                  className="toolbar-btn flex items-center gap-1.5 cursor-pointer text-xs px-2"
                  title="Slide background"
                >
                  <span className="text-2xs font-semibold tracking-eyebrow uppercase text-ink-faint">
                    BG
                  </span>
                  <span
                    aria-hidden="true"
                    className="inline-block w-4 h-4 rounded-xs border border-line"
                    style={{ background: activeSlide.background || 'var(--paper)' }}
                  />
                  <input
                    type="color"
                    className="sr-only"
                    value={activeSlide.background || '#1a1a2e'}
                    onChange={(e) => updateSlideField(activeIdx, 'background', e.target.value)}
                    aria-label="Slide background colour"
                  />
                </label>
              </div>

              {/* Slide canvas — paper feel with subtle grain, mirrors DocsEditor.
                  The slide itself sits on a card centred in the working area. */}
              <div className="flex-1 overflow-auto px-6 py-8 bg-bg">
                <article
                  className="paper-grain mx-auto bg-paper border border-line rounded-lg shadow-e1 px-12 py-10 animate-fade-in"
                  style={{ maxWidth: '900px', minHeight: '420px' }}
                >
                  <EditorContent editor={editor} className="tiptap" />
                </article>
              </div>

              {/* Speaker notes — quiet warning-tinted strip (not yellow shouty). */}
              <div className="px-6 py-3 bg-warning-bg border-t border-line flex-shrink-0">
                <label
                  htmlFor="slide-speaker-notes"
                  className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-eyebrow text-warning mb-1"
                >
                  <StickyNote size={11} />
                  Speaker notes
                </label>
                <textarea
                  id="slide-speaker-notes"
                  value={activeSlide.notes}
                  onChange={(e) => updateSlideField(activeIdx, 'notes', e.target.value)}
                  className={[
                    'w-full h-14 text-sm bg-transparent border-none outline-none resize-none',
                    'text-ink-muted placeholder:text-ink-faint',
                  ].join(' ')}
                  placeholder="Notes for the presenter…"
                />
              </div>
            </div>
          )}

          {/* Comments panel (OFFICE-26) */}
          {showComments && (
            <CommentsPanel
              fileId={id}
              anchorCtx={activeSlide ? { type: 'slide', slide_id: activeSlide.id, snapshot: activeSlide.title || `Slide ${activeIdx + 1}` } : null}
              onClose={() => setShowComments(false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
