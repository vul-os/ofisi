/**
 * DocsToolbar — tiered toolbar for the Docs editor.
 *
 * Primary row: Undo/Redo, Font-family, Font-size, Bold, Italic, Underline,
 *   Strikethrough, Text-color, Highlight, Link, Bullet, Numbered, Checklist,
 *   Decrease/Increase indent, Align (L/C/R/J), Line spacing, Insert image,
 *   Insert table, Insert link, Clear formatting.
 *
 * Overflow (3-dot menu): Heading H1-H6, Code block, Blockquote, HR,
 *   Insert ToC, Insert footnote, Strikethrough (dupe for discoverability).
 *
 * Every command routes through the existing TipTap/CRDT chain.
 */

import { useRef, useState } from 'react'
import {
  Bold, Italic, Underline, Strikethrough, Code,
  List, ListOrdered, CheckSquare, Quote, AlignLeft,
  AlignCenter, AlignRight, AlignJustify, Image, Link,
  Table, Highlighter, Palette, Undo, Redo,
  RemoveFormatting, ChevronDown, Minus, Download,
  Indent, Outdent, MoreHorizontal, Heading1, Heading2,
  Heading3, Heading4, Heading5, Heading6, Type,
  ListTree, Printer,
} from 'lucide-react'
import { api } from '../../lib/api'
import { Menu, ToolbarButton, UrlPopover } from '../../components/ui'
import { exportToDocx, exportToPdf, exportToMarkdown, exportToHtml } from './docsExport'
import TableOfContents from './components/TableOfContents'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEADINGS = [
  { label: 'Normal',    value: 0, style: 'text-sm' },
  { label: 'Heading 1', value: 1, style: 'text-xl font-bold' },
  { label: 'Heading 2', value: 2, style: 'text-lg font-bold' },
  { label: 'Heading 3', value: 3, style: 'text-base font-semibold' },
  { label: 'Heading 4', value: 4, style: 'text-sm font-medium' },
  { label: 'Heading 5', value: 5, style: 'text-xs font-medium' },
  { label: 'Heading 6', value: 6, style: 'text-xs font-normal' },
]

const FONT_FAMILIES = [
  { label: 'Default',        value: '' },
  { label: 'Arial',          value: 'Arial, sans-serif' },
  { label: 'Georgia',        value: 'Georgia, serif' },
  { label: 'Times New Roman',value: '"Times New Roman", serif' },
  { label: 'Courier New',    value: '"Courier New", monospace' },
  { label: 'Verdana',        value: 'Verdana, sans-serif' },
  { label: 'Trebuchet MS',   value: '"Trebuchet MS", sans-serif' },
  { label: 'Impact',         value: 'Impact, sans-serif' },
]

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]

const LINE_SPACINGS = [
  { label: 'Single',  value: '1' },
  { label: '1.15',    value: '1.15' },
  { label: '1.5',     value: '1.5' },
  { label: 'Double',  value: '2' },
]

// ---------------------------------------------------------------------------
// Primitive components
// ---------------------------------------------------------------------------

// Toolbar primitives now come from the shared design system so the four
// editors stop drifting:
//   Btn      → ToolbarButton (emits aria-pressed from `active`)
//   Dropdown → Menu (keyboard/touch-accessible: open state + Esc + outside-click)
//   MenuItem → Menu.Item
const Btn = ToolbarButton

function Sep() {
  return <span className="toolbar-divider" aria-hidden="true" />
}

function Dropdown({ trigger, children, align = 'left', wide = false }) {
  return (
    <Menu trigger={trigger} align={align} width={wide ? 'w-52' : 'w-40'}>
      {children}
    </Menu>
  )
}

const MenuItem = Menu.Item

// ---------------------------------------------------------------------------
// HeadingSelector
// ---------------------------------------------------------------------------
function HeadingSelector({ editor }) {
  const current = HEADINGS.find((h) =>
    h.value === 0 ? !editor.isActive('heading') : editor.isActive('heading', { level: h.value })
  ) || HEADINGS[0]

  return (
    <Dropdown
      trigger={
        <button
          className="toolbar-btn flex items-center gap-1 px-2 min-w-[96px] text-xs"
          aria-label={`Text style: ${current.label}`}
          aria-haspopup="menu"
        >
          <span className="flex-1 text-left truncate">{current.label}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      }
      wide
    >
      {HEADINGS.map(({ label, value, style }) => (
        <MenuItem
          key={value}
          active={current.value === value}
          onClick={() => {
            if (value === 0) editor.chain().focus().setParagraph().run()
            else editor.chain().focus().toggleHeading({ level: value }).run()
          }}
        >
          <span className={style}>{label}</span>
        </MenuItem>
      ))}
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// FontFamilySelector
// ---------------------------------------------------------------------------
function FontFamilySelector({ editor }) {
  const currentFamily = editor.getAttributes('textStyle').fontFamily || ''
  const currentLabel = FONT_FAMILIES.find((f) => f.value === currentFamily)?.label || 'Font'

  return (
    <Dropdown
      trigger={
        <button
          className="toolbar-btn flex items-center gap-1 px-2 min-w-[80px] text-xs"
          aria-label={`Font family: ${currentLabel}`}
          aria-haspopup="menu"
        >
          <span className="flex-1 text-left truncate" style={{ fontFamily: currentFamily || undefined }}>
            {currentLabel}
          </span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      }
    >
      {FONT_FAMILIES.map(({ label, value }) => (
        <MenuItem
          key={label}
          active={currentFamily === value}
          onClick={() => {
            if (!value) {
              editor.chain().focus().unsetMark('textStyle').run()
            } else {
              editor.chain().focus().setMark('textStyle', { fontFamily: value }).run()
            }
          }}
        >
          <span style={{ fontFamily: value || undefined }}>{label}</span>
        </MenuItem>
      ))}
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// FontSizeSelector
// ---------------------------------------------------------------------------
function FontSizeSelector({ editor }) {
  const currentSize = editor.getAttributes('textStyle').fontSize || ''
  const numericSize = currentSize ? parseInt(currentSize) : ''
  const [customVal, setCustomVal] = useState('')

  const applySize = (sz) => {
    editor.chain().focus().setMark('textStyle', { fontSize: `${sz}pt` }).run()
  }

  const handleCustomKeyDown = (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(customVal)
      if (n && n > 0 && n <= 400) applySize(n)
      setCustomVal('')
    }
  }

  return (
    <Dropdown
      trigger={
        <button
          className="toolbar-btn flex items-center gap-1 px-1 w-12 text-xs"
          aria-label={`Font size: ${numericSize || 'default'}`}
          aria-haspopup="menu"
        >
          <span className="flex-1 text-center tabular-nums">{numericSize || '—'}</span>
          <ChevronDown size={10} aria-hidden="true" />
        </button>
      }
    >
      {/* Custom size input at the top */}
      <div className="px-2 py-1.5 border-b border-line">
        <input
          type="number"
          min="1"
          max="400"
          value={customVal}
          onChange={(e) => setCustomVal(e.target.value)}
          onKeyDown={handleCustomKeyDown}
          placeholder="Custom…"
          aria-label="Custom font size"
          className={[
            'w-full text-xs px-2 py-0.5 rounded-xs border border-line',
            'bg-bg text-ink placeholder:text-ink-faint',
            'focus:outline-none focus:border-accent',
          ].join(' ')}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      {FONT_SIZES.map((sz) => (
        <MenuItem
          key={sz}
          active={numericSize === sz}
          onClick={() => applySize(sz)}
        >
          {sz}
        </MenuItem>
      ))}
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// LineSpacingSelector
// ---------------------------------------------------------------------------
function LineSpacingSelector({ editor }) {
  return (
    <Dropdown
      trigger={
        <button
          className="toolbar-btn flex items-center gap-0.5 px-1.5 text-xs"
          aria-label="Line spacing"
          aria-haspopup="menu"
          title="Line spacing"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <path d="M2 4h11M2 7h8M2 10h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M12 1v13M11 2l1-1 1 1M11 13l1 1 1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <ChevronDown size={10} aria-hidden="true" />
        </button>
      }
    >
      {LINE_SPACINGS.map(({ label, value }) => (
        <MenuItem
          key={value}
          onClick={() => {
            // Apply paragraph-level lineHeight via updateAttributes so it
            // affects the block node (not an inline mark).  The paragraph
            // extension stores this as a `style` attribute rendered in HTML.
            editor.chain().focus().updateAttributes('paragraph', {
              style: `line-height:${value}`,
            }).run()
            // Also try heading nodes in case the cursor is inside a heading.
            editor.chain().focus().updateAttributes('heading', {
              style: `line-height:${value}`,
            }).run()
          }}
        >
          {label}
        </MenuItem>
      ))}
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// OverflowMenu — 3-dot menu for secondary commands
// ---------------------------------------------------------------------------
function OverflowMenu({ editor, title, onInsertToc }) {
  return (
    <Dropdown
      trigger={
        <button
          className="toolbar-btn"
          title="More options"
          aria-label="More formatting options"
          aria-haspopup="menu"
        >
          <MoreHorizontal size={15} />
        </button>
      }
      align="right"
      wide
    >
      {/* Headings H5-H6 (H1-H4 are in the styles selector) */}
      <p className="px-3 py-1 text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Headings</p>
      {[5, 6].map((level) => (
        <MenuItem
          key={level}
          active={editor.isActive('heading', { level })}
          onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
        >
          {level === 5 ? <Heading5 size={13} /> : <Heading6 size={13} />}
          Heading {level}
        </MenuItem>
      ))}
      <div className="my-1 border-t border-line" />
      <p className="px-3 py-1 text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Blocks</p>
      <MenuItem
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Code size={13} /> Code block
      </MenuItem>
      <MenuItem
        active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={13} /> Blockquote
      </MenuItem>
      <MenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
        <Minus size={13} /> Horizontal rule
      </MenuItem>
      <div className="my-1 border-t border-line" />
      <p className="px-3 py-1 text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Insert</p>
      <MenuItem onClick={onInsertToc}>
        <ListTree size={13} /> Table of contents
      </MenuItem>
      <MenuItem
        onClick={() => {
          // WAVE-45: real footnote — inserts a numbered inline ref and a
          // matching entry in the auto-numbered footnotes section at doc end.
          if (editor.commands.insertFootnote) {
            editor.chain().focus().insertFootnote().run()
          } else {
            // Fallback for editors without the extension (should not happen).
            editor.chain().focus().insertContent('<sup>[?]</sup>').run()
          }
        }}
      >
        <Type size={13} /> Footnote
      </MenuItem>
      <MenuItem
        onClick={() => editor.chain().focus().insertContent(
          '<p style="page-break-after:always;border-top:2px dashed var(--line);margin:16px 0;padding-bottom:16px;" data-page-break="true"><br/></p>'
        ).run()}
      >
        <Minus size={13} /> Page break
      </MenuItem>
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// TableSubMenu — shown when cursor is inside a table
// ---------------------------------------------------------------------------
function TableSubMenu({ editor }) {
  return (
    <Dropdown
      trigger={
        <button
          className="toolbar-btn text-xs px-2 gap-0.5 flex items-center"
          aria-label="Table options"
          aria-haspopup="menu"
        >
          <Table size={13} aria-hidden="true" />
          <ChevronDown size={10} aria-hidden="true" />
        </button>
      }
    >
      {[
        ['Add row above',     () => editor.chain().focus().addRowBefore().run()],
        ['Add row below',     () => editor.chain().focus().addRowAfter().run()],
        ['Delete row',        () => editor.chain().focus().deleteRow().run()],
        ['Add column before', () => editor.chain().focus().addColumnBefore().run()],
        ['Add column after',  () => editor.chain().focus().addColumnAfter().run()],
        ['Delete column',     () => editor.chain().focus().deleteColumn().run()],
        ['Delete table',      () => editor.chain().focus().deleteTable().run()],
      ].map(([lbl, fn]) => (
        <MenuItem key={lbl} onClick={fn}>{lbl}</MenuItem>
      ))}
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// InsertTableMenu — N×M picker
// ---------------------------------------------------------------------------
function InsertTableMenu({ editor }) {
  const [hover, setHover] = useState(null) // { row, col }
  const COLS = 8
  const ROWS = 8
  const cells = []
  for (let r = 1; r <= ROWS; r++) {
    for (let c = 1; c <= COLS; c++) {
      cells.push({ r, c })
    }
  }
  const hilite = (r, c) => hover && r <= hover.row && c <= hover.col
  return (
    <Dropdown
      trigger={
        <Btn title="Insert table">
          <Table size={15} />
        </Btn>
      }
    >
      <div className="p-2">
        <p className="text-2xs text-ink-faint mb-1 text-center">
          {hover ? `${hover.row} × ${hover.col}` : 'Insert table'}
        </p>
        <div
          className="grid gap-0.5"
          style={{ gridTemplateColumns: `repeat(${COLS}, 16px)` }}
        >
          {cells.map(({ r, c }) => (
            <button
              key={`${r}-${c}`}
              type="button"
              aria-label={`Insert ${r} by ${c} table`}
              onMouseEnter={() => setHover({ row: r, col: c })}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover({ row: r, col: c })}
              onClick={() => {
                editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: true }).run()
              }}
              className={[
                'w-4 h-4 border rounded-xs cursor-pointer transition-colors',
                'focus-visible:outline-none focus-visible:shadow-focus',
                hilite(r, c) ? 'bg-accent border-accent' : 'bg-bg-elev2 border-line hover:border-accent-press',
              ].join(' ')}
            />
          ))}
        </div>
      </div>
    </Dropdown>
  )
}

// ---------------------------------------------------------------------------
// DocsToolbar (main export)
// ---------------------------------------------------------------------------
export default function DocsToolbar({ editor, title }) {
  const imgInput = useRef(null)
  const [showToc, setShowToc] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [imgUrlOpen, setImgUrlOpen] = useState(false)

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { url } = await api.uploadImage(file)
      editor.chain().focus().setImage({ src: url }).run()
    } catch {
      const reader = new FileReader()
      reader.onload = (ev) => {
        if (ev.target?.result) editor.chain().focus().setImage({ src: ev.target.result }).run()
      }
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  if (!editor) return null

  return (
    <div
      className="bg-paper border-b border-line relative"
      role="toolbar"
      aria-label="Document formatting"
    >
      {/* Single overflow strategy: scroll horizontally (no flex-wrap) so the
          row never reflows into a crushed multi-line block on narrow screens. */}
      <div className="flex items-center gap-0 px-2 py-1 min-h-[44px] overflow-x-auto">

        {/* ── Undo / Redo ──────────────────────────────────────────────── */}
        <div className="flex items-center gap-0 mr-1">
          <Btn
            title="Undo (Cmd+Z)"
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
          >
            <Undo size={15} />
          </Btn>
          <Btn
            title="Redo (Cmd+Shift+Z)"
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
          >
            <Redo size={15} />
          </Btn>
        </div>

        <Sep />

        {/* ── Styles ───────────────────────────────────────────────────── */}
        <HeadingSelector editor={editor} />

        <Sep />

        {/* ── Font family + size ──────────────────────────────────────── */}
        <FontFamilySelector editor={editor} />
        <FontSizeSelector editor={editor} />

        <Sep />

        {/* ── Character formatting ─────────────────────────────────────── */}
        <Btn
          title="Bold (Cmd+B)"
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
        >
          <Bold size={15} />
        </Btn>
        <Btn
          title="Italic (Cmd+I)"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
        >
          <Italic size={15} />
        </Btn>
        <Btn
          title="Underline (Cmd+U)"
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')}
        >
          <Underline size={15} />
        </Btn>
        <Btn
          title="Strikethrough"
          onClick={() => editor.chain().focus().toggleStrike().run()}
          active={editor.isActive('strike')}
        >
          <Strikethrough size={15} />
        </Btn>
        <Btn
          title="Subscript"
          onClick={() => editor.chain().focus().toggleMark('subscript').run()}
          active={editor.isActive('subscript')}
          className="text-xs font-bold"
        >
          X<sub style={{ fontSize: '0.6em', lineHeight: 1 }}>2</sub>
        </Btn>
        <Btn
          title="Superscript"
          onClick={() => editor.chain().focus().toggleMark('superscript').run()}
          active={editor.isActive('superscript')}
          className="text-xs font-bold"
        >
          X<sup style={{ fontSize: '0.6em', lineHeight: 1 }}>2</sup>
        </Btn>

        {/* Text color */}
        <label className="toolbar-btn relative cursor-pointer" title="Font color" aria-label="Font color">
          <Palette size={15} aria-hidden="true" />
          <input
            type="color"
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
            aria-label="Choose font color"
          />
        </label>

        {/* Highlight */}
        <label className="toolbar-btn relative cursor-pointer" title="Highlight" aria-label="Highlight color">
          <Highlighter size={15} aria-hidden="true" />
          <input
            type="color"
            className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
            onChange={(e) => editor.chain().focus().toggleHighlight({ color: e.target.value }).run()}
            aria-label="Choose highlight color"
          />
        </label>

        {/* Link (Cmd+K) — inline anchored popover (no native prompt) */}
        <div className="relative">
          <Btn
            title="Insert link (Cmd+K)"
            onClick={() => setLinkOpen((v) => !v)}
            active={editor.isActive('link')}
          >
            <Link size={15} />
          </Btn>
          {linkOpen && (
            <UrlPopover
              label="Link URL"
              submitLabel="Apply"
              initialValue={editor.getAttributes('link').href || ''}
              onSubmit={(url) => {
                editor.chain().focus().extendMarkRange('link').setLink({ href: url, target: '_blank' }).run()
                setLinkOpen(false)
              }}
              onRemove={editor.isActive('link')
                ? () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkOpen(false) }
                : undefined}
              onClose={() => setLinkOpen(false)}
            />
          )}
        </div>

        {/* Clear formatting */}
        <Btn
          title="Clear formatting"
          onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
        >
          <RemoveFormatting size={15} />
        </Btn>

        <Sep />

        {/* ── Lists ────────────────────────────────────────────────────── */}
        <Btn
          title="Bullet list"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')}
        >
          <List size={15} />
        </Btn>
        <Btn
          title="Numbered list"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')}
        >
          <ListOrdered size={15} />
        </Btn>
        <Btn
          title="Checklist"
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          active={editor.isActive('taskList')}
        >
          <CheckSquare size={15} />
        </Btn>

        {/* Indent / Outdent */}
        <Btn
          title="Decrease indent (Shift+Tab)"
          onClick={() => {
            if (editor.isActive('listItem') || editor.isActive('taskItem')) {
              editor.chain().focus().liftListItem('listItem').run()
            }
          }}
        >
          <Outdent size={15} />
        </Btn>
        <Btn
          title="Increase indent (Tab)"
          onClick={() => {
            if (editor.isActive('listItem') || editor.isActive('taskItem')) {
              editor.chain().focus().sinkListItem('listItem').run()
            }
          }}
        >
          <Indent size={15} />
        </Btn>

        <Sep />

        {/* ── Alignment ──────────────────────────────────────────────── */}
        <Btn
          title="Align left"
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          active={editor.isActive({ textAlign: 'left' })}
        >
          <AlignLeft size={15} />
        </Btn>
        <Btn
          title="Align center"
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          active={editor.isActive({ textAlign: 'center' })}
        >
          <AlignCenter size={15} />
        </Btn>
        <Btn
          title="Align right"
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          active={editor.isActive({ textAlign: 'right' })}
        >
          <AlignRight size={15} />
        </Btn>
        <Btn
          title="Justify"
          onClick={() => editor.chain().focus().setTextAlign('justify').run()}
          active={editor.isActive({ textAlign: 'justify' })}
        >
          <AlignJustify size={15} />
        </Btn>

        <LineSpacingSelector editor={editor} />

        <Sep />

        {/* ── Insert ─────────────────────────────────────────────────── */}
        {/* Image: file upload */}
        <Btn title="Insert image (upload)" onClick={() => imgInput.current?.click()}>
          <Image size={15} />
        </Btn>
        {/* Image: from URL — inline anchored popover (no native prompt) */}
        <div className="relative">
          <Btn title="Insert image from URL" onClick={() => setImgUrlOpen((v) => !v)}>
            <span className="text-2xs font-bold">URL</span>
          </Btn>
          {imgUrlOpen && (
            <UrlPopover
              label="Image URL"
              placeholder="https://…/image.png"
              submitLabel="Insert"
              onSubmit={(url) => { editor.chain().focus().setImage({ src: url }).run(); setImgUrlOpen(false) }}
              onClose={() => setImgUrlOpen(false)}
            />
          )}
        </div>

        {/* Table: NxM picker */}
        <InsertTableMenu editor={editor} />

        {/* Table sub-menu (when cursor is inside table) */}
        {editor.isActive('table') && <TableSubMenu editor={editor} />}

        <Sep />

        {/* ── Overflow menu ──────────────────────────────────────────── */}
        <OverflowMenu
          editor={editor}
          title={title}
          onInsertToc={() => setShowToc((v) => !v)}
        />

        {/* ── Export ─────────────────────────────────────────────────── */}
        <div className="ml-auto flex items-center self-center">
          <Dropdown
            align="right"
            trigger={
              <button
                className="inline-flex items-center gap-1.5 h-7 px-2.5 bg-paper border border-line rounded-md text-xs font-medium text-ink-muted hover:border-line-strong hover:text-ink transition-colors"
                aria-haspopup="menu"
                aria-label="Export document"
              >
                <Download size={12} aria-hidden="true" /> Export
                <ChevronDown size={11} className="opacity-60" aria-hidden="true" />
              </button>
            }
            wide
          >
            <MenuItem onClick={() => exportToDocx(editor, title)}>
              <span className="text-2xs font-bold tracking-eyebrow text-accent w-9">DOCX</span>
              Word document
            </MenuItem>
            <MenuItem onClick={() => exportToPdf(title)}>
              <span className="text-2xs font-bold tracking-eyebrow text-danger w-9">PDF</span>
              PDF document
            </MenuItem>
            <MenuItem onClick={() => exportToMarkdown(editor, title)}>
              <span className="text-2xs font-bold tracking-eyebrow text-ink-faint w-9">MD</span>
              Markdown
            </MenuItem>
            <MenuItem onClick={() => exportToHtml(editor, title)}>
              <span className="text-2xs font-bold tracking-eyebrow text-warning w-9">HTML</span>
              HTML file
            </MenuItem>
            <div className="my-1 border-t border-line" />
            <MenuItem onClick={() => exportToPdf(title)}>
              <Printer size={13} className="text-ink-faint" />
              Print (Ctrl+P)
            </MenuItem>
          </Dropdown>
        </div>

        <input
          ref={imgInput}
          type="file"
          accept="image/*"
          className="hidden"
          aria-hidden="true"
          onChange={handleImageUpload}
        />
      </div>

      {/* ToC popover — anchored below toolbar */}
      {showToc && (
        <div className="absolute right-2 top-full mt-1 z-50">
          <TableOfContents editor={editor} onClose={() => setShowToc(false)} />
        </div>
      )}
    </div>
  )
}
