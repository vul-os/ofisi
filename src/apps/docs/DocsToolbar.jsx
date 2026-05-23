import { useRef } from 'react'
import {
  Bold, Italic, Underline, Strikethrough, Code,
  List, ListOrdered, CheckSquare, Quote, AlignLeft,
  AlignCenter, AlignRight, AlignJustify, Image, Link,
  Table, Highlighter, Palette, Undo, Redo,
  RemoveFormatting, ChevronDown, Minus, Download,
} from 'lucide-react'
import { api } from '../../lib/api'
import { exportToDocx, exportToPdf, exportToMarkdown } from './docsExport'

const HEADINGS = [
  { label: 'Normal', value: 0, style: 'text-sm' },
  { label: 'Heading 1', value: 1, style: 'text-lg font-bold' },
  { label: 'Heading 2', value: 2, style: 'text-base font-bold' },
  { label: 'Heading 3', value: 3, style: 'text-sm font-semibold' },
  { label: 'Heading 4', value: 4, style: 'text-sm font-medium' },
]

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]

function Btn({ title, children, onClick, active, disabled }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={!!disabled}
      className={`toolbar-btn ${active ? 'active' : ''}`}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="toolbar-divider" />
}

function Group({ label, children }) {
  // Group label uses the eyebrow tracking — Vercel-style typographic discipline.
  return (
    <div className="flex flex-col items-center border-r border-line pr-3 mr-1 last:border-0">
      <div className="flex items-center gap-0.5 flex-wrap">{children}</div>
      {label && (
        <span className="text-[9px] text-ink-faint mt-0.5 tracking-eyebrow uppercase">
          {label}
        </span>
      )}
    </div>
  )
}

export default function DocsToolbar({ editor, title, onSave, saving }) {
  const imgInput = useRef(null)

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { url } = await api.uploadImage(file)
      editor.chain().focus().setImage({ src: url }).run()
    } catch {
      const reader = new FileReader()
      reader.onload = (ev) => { if (ev.target?.result) editor.chain().focus().setImage({ src: ev.target.result }).run() }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  const setLink = () => {
    const prev = editor.getAttributes('link').href || ''
    const url = window.prompt('URL:', prev)
    if (url === null) return
    if (!url) editor.chain().focus().unsetLink().run()
    else editor.chain().focus().setLink({ href: url, target: '_blank' }).run()
  }

  const currentHeading = HEADINGS.find((h) =>
    h.value === 0 ? !editor.isActive('heading') : editor.isActive('heading', { level: h.value })
  ) || HEADINGS[0]

  return (
    /*
     * Toolbar: sticky-but-quiet.  We keep the existing "ribbon" layout (group →
     * label) but pull every colour through the token layer so the bar reads as
     * paper, not as a separate floating panel.
     */
    <div className="bg-paper border-b border-line">
      <div className="flex items-start gap-0 px-3 py-1.5 flex-wrap min-h-[52px]">

        {/* Undo / Redo */}
        <Group>
          <Btn title="Undo (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()}><Undo size={15} /></Btn>
          <Btn title="Redo (Ctrl+Y)" onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()}><Redo size={15} /></Btn>
        </Group>

        {/* Style / heading */}
        <Group label="Styles">
          <div className="relative group">
            <button className="toolbar-btn flex items-center gap-1 px-2 min-w-[100px] text-xs">
              <span className="flex-1 text-left truncate">{currentHeading.label}</span>
              <ChevronDown size={11} />
            </button>
            <div className="absolute left-0 top-full mt-0.5 w-40 bg-paper border border-line rounded-md shadow-e2 z-30 py-1 hidden group-hover:block animate-scale-in">
              {HEADINGS.map(({ label, value, style }) => (
                <button
                  key={value}
                  onClick={() => value === 0 ? editor.chain().focus().setParagraph().run() : editor.chain().focus().toggleHeading({ level: value }).run()}
                  className={`w-full text-left px-3 py-1.5 hover:bg-accent-tint ${style} ${currentHeading.value === value ? 'text-accent' : 'text-ink-muted'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </Group>

        {/* Font */}
        <Group label="Font">
          <Btn title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')}><Bold size={15} /></Btn>
          <Btn title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')}><Italic size={15} /></Btn>
          <Btn title="Underline (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')}><Underline size={15} /></Btn>
          <Btn title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')}><Strikethrough size={15} /></Btn>
          <Btn title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')}><Code size={15} /></Btn>
          {/* Text color */}
          <label className="toolbar-btn relative cursor-pointer" title="Font color">
            <Palette size={15} />
            <input type="color" className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" onChange={(e) => editor.chain().focus().setColor(e.target.value).run()} />
          </label>
          {/* Highlight */}
          <label className="toolbar-btn relative cursor-pointer" title="Highlight">
            <Highlighter size={15} />
            <input type="color" className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" onChange={(e) => editor.chain().focus().toggleHighlight({ color: e.target.value }).run()} />
          </label>
          <Btn title="Clear formatting" onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}><RemoveFormatting size={15} /></Btn>
        </Group>

        {/* Paragraph */}
        <Group label="Paragraph">
          <Btn title="Align left" onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })}><AlignLeft size={15} /></Btn>
          <Btn title="Align center" onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })}><AlignCenter size={15} /></Btn>
          <Btn title="Align right" onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })}><AlignRight size={15} /></Btn>
          <Btn title="Justify" onClick={() => editor.chain().focus().setTextAlign('justify').run()} active={editor.isActive({ textAlign: 'justify' })}><AlignJustify size={15} /></Btn>
          <Sep />
          <Btn title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')}><List size={15} /></Btn>
          <Btn title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')}><ListOrdered size={15} /></Btn>
          <Btn title="Task list" onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive('taskList')}><CheckSquare size={15} /></Btn>
          <Btn title="Block quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')}><Quote size={15} /></Btn>
          <Btn title="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={15} /></Btn>
        </Group>

        {/* Insert */}
        <Group label="Insert">
          <Btn title="Insert image" onClick={() => imgInput.current?.click()}><Image size={15} /></Btn>
          <Btn title="Insert link" onClick={setLink} active={editor.isActive('link')}><Link size={15} /></Btn>
          <Btn title="Insert table (3×3)" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table size={15} /></Btn>
          {/* Table sub-menu when cursor is inside table */}
          {editor.isActive('table') && (
            <div className="relative group">
              <button className="toolbar-btn text-xs px-2">Table ▾</button>
              <div className="absolute left-0 top-full mt-0.5 w-44 bg-paper border border-line rounded-md shadow-e2 z-30 py-1 hidden group-hover:block text-xs animate-scale-in">
                {[
                  ['Add row above', () => editor.chain().focus().addRowBefore().run()],
                  ['Add row below', () => editor.chain().focus().addRowAfter().run()],
                  ['Delete row', () => editor.chain().focus().deleteRow().run()],
                  ['Add column before', () => editor.chain().focus().addColumnBefore().run()],
                  ['Add column after', () => editor.chain().focus().addColumnAfter().run()],
                  ['Delete column', () => editor.chain().focus().deleteColumn().run()],
                  ['Delete table', () => editor.chain().focus().deleteTable().run()],
                ].map(([lbl, fn]) => (
                  <button key={lbl} onClick={fn} className="w-full text-left px-3 py-1.5 hover:bg-accent-tint text-ink-muted">{lbl}</button>
                ))}
              </div>
            </div>
          )}
        </Group>

        {/* Export — right-aligned. Quiet secondary button (not primary accent) so
            it doesn't compete with the topbar's Save button. */}
        <div className="ml-auto flex items-center self-center">
          <div className="relative group">
            <button className="inline-flex items-center gap-1.5 h-7 px-2.5 bg-paper border border-line rounded-md text-xs font-medium text-ink-muted hover:border-line-strong hover:text-ink transition-colors">
              <Download size={12} /> Export
              <ChevronDown size={11} className="opacity-60" />
            </button>
            <div className="absolute right-0 top-full mt-0.5 w-44 bg-paper border border-line rounded-md shadow-e2 z-30 py-1 hidden group-hover:block text-sm animate-scale-in">
              <button onClick={() => exportToDocx(editor, title)} className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2">
                <span className="text-2xs font-bold tracking-eyebrow text-accent w-9">DOCX</span> Word document
              </button>
              <button onClick={() => exportToPdf(title)} className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2">
                <span className="text-2xs font-bold tracking-eyebrow text-danger w-9">PDF</span> PDF document
              </button>
              <button onClick={() => exportToMarkdown(editor, title)} className="w-full text-left px-3 py-2 hover:bg-accent-tint text-ink-muted flex items-center gap-2">
                <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-9">MD</span> Markdown
              </button>
            </div>
          </div>
        </div>

        <input ref={imgInput} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      </div>
    </div>
  )
}
