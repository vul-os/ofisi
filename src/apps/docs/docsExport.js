import { saveAs } from 'file-saver'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun,
} from 'docx'
import TurndownService from 'turndown'
import {
  computeFootnoteOrder, collectFootnoteRefIds, numberFootnotesInHtml,
} from './footnotes.js'

// HTML
export function exportToHtml(editor, filename) {
  // Bake sequential footnote numbers into the markup (getHTML() alone omits
  // them — they live in an editor decoration, not the document).
  const body = numberFootnotesInHtml(editor.getHTML())
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${filename}</title>
<style>
  body { font-family: Georgia, serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3, h4, h5, h6 { font-family: system-ui, sans-serif; }
  pre, code { font-family: "Courier New", monospace; background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
  pre { padding: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 8px; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 16px; color: #555; }
</style>
</head>
<body>
${body}
</body>
</html>`
  saveAs(new Blob([html], { type: 'text/html;charset=utf-8' }), `${filename}.html`)
}

// Markdown
export function exportToMarkdown(editor, filename) {
  const html = numberFootnotesInHtml(editor.getHTML())
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  const md = td.turndown(html)
  saveAs(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${filename}.md`)
}

// PDF (browser print)
export function exportToPdf(filename) {
  const old = document.title
  document.title = filename
  window.print()
  document.title = old
}

// DOCX
export async function exportToDocx(editor, filename) {
  const json = editor.getJSON()
  // Derive the same sequential footnote numbering the editor shows so exported
  // refs/items read 1, 2, 3… (the numbers are decoration-only in the doc JSON).
  const fnOrder = computeFootnoteOrder(collectFootnoteRefIds(json))
  const children = await nodesToDocx(json.content || [], fnOrder)
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 24 } } } },
    sections: [{ children }],
  })
  const blob = await Packer.toBlob(doc)
  saveAs(blob, `${filename}.docx`)
}

async function nodesToDocx(nodes, fnOrder) {
  const out = []
  for (const node of nodes) {
    out.push(...(await nodeToDocx(node, fnOrder)))
  }
  return out
}

// Recursively flatten nested bullet/ordered lists with indentation levels
async function listToDocx(listNode, depth) {
  const isOrdered = listNode.type === 'orderedList'
  const items = []
  for (const item of listNode.content || []) {
    // item is a listItem; its content may be paragraphs and/or nested lists
    for (const child of item.content || []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        items.push(...(await listToDocx(child, depth + 1)))
      } else if (child.type === 'taskItem') {
        const checked = child.attrs?.checked || false
        items.push(new Paragraph({
          bullet: { level: Math.min(depth, 8) },
          children: [new TextRun({ text: (checked ? '☑ ' : '☐ ') }), ...inlineNodes(child.content?.[0]?.content || [])],
        }))
      } else {
        // paragraph or other inline container
        items.push(new Paragraph({
          ...(isOrdered
            ? { numbering: { reference: 'default-numbering', level: Math.min(depth, 8) } }
            : { bullet: { level: Math.min(depth, 8) } }),
          children: inlineNodes(child.content || []),
        }))
      }
    }
  }
  return items
}

const HEADING_MAP = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
}

async function nodeToDocx(node, fnOrder) {
  switch (node.type) {
    case 'paragraph':
      return [new Paragraph({ children: inlineNodes(node.content || [], fnOrder) })]
    case 'heading':
      return [new Paragraph({ heading: HEADING_MAP[node.attrs?.level] || HeadingLevel.HEADING_1, children: inlineNodes(node.content || [], fnOrder) })]
    case 'bulletList':
    case 'orderedList':
      return await listToDocx(node, 0)
    case 'taskList':
      return await listToDocx(node, 0)
    case 'blockquote':
      return await nodesToDocx(node.content || [], fnOrder)
    case 'codeBlock':
      return [new Paragraph({ children: [new TextRun({ text: node.content?.map((n) => n.text).join('') || '', font: 'Courier New', size: 20 })] })]
    case 'horizontalRule':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' } } })]
    case 'table': {
      const rows = (node.content || []).map((rowNode) =>
        new TableRow({
          children: (rowNode.content || []).map((cellNode) =>
            new TableCell({
              width: { size: 2000, type: WidthType.DXA },
              children: (cellNode.content || []).map((para) => new Paragraph({ children: inlineNodes(para.content || []) })),
            })
          ),
        })
      )
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })]
    }
    case 'image': {
      const src = node.attrs?.src
      if (src?.startsWith('data:image')) {
        try {
          const [header, base64] = src.split(',')
          const ext = (header.match(/data:(image\/\w+);/)?.[1] || 'image/png').split('/')[1]
          const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          return [new Paragraph({ children: [new ImageRun({ data: buffer, transformation: { width: 400, height: 300 }, type: ext })] })]
        } catch { return [] }
      }
      return []
    }
    case 'footnotesList': {
      // Render the footnotes section: a rule, then one numbered paragraph per
      // footnote item (number derived from the ref order in the body).
      const out = [new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' } } })]
      for (const item of node.content || []) {
        if (item.type !== 'footnoteItem') continue
        const num = fnOrder?.get(item.attrs?.id)
        const marker = num ? `${num}. ` : ''
        // A footnoteItem holds paragraph+ content; flatten them, prefixing the
        // first with its number.
        const paras = item.content || []
        paras.forEach((para, i) => {
          const inline = inlineNodes(para.content || [], fnOrder)
          const children = i === 0
            ? [new TextRun({ text: marker, bold: true }), ...inline]
            : inline
          out.push(new Paragraph({ children }))
        })
      }
      return out
    }
    default:
      return []
  }
}

function inlineNodes(nodes, fnOrder) {
  return nodes.map((node) => {
    if (node.type === 'footnoteRef') {
      const num = fnOrder?.get(node.attrs?.id)
      return new TextRun({ text: num ? String(num) : '*', superScript: true })
    }
    if (node.type !== 'text') return new TextRun('')
    const marks = node.marks || []
    const hasMark = (type) => marks.some((m) => m.type === type)
    const markAttr = (type, attr) => marks.find((m) => m.type === type)?.attrs?.[attr]
    const color = markAttr('color', 'color')?.replace('#', '')
    // Font size / family live on the textStyle mark (see lib/tiptap/fontStyle.js).
    const rawSize = markAttr('textStyle', 'fontSize')
    const sizePt = rawSize ? parseFloat(rawSize) : NaN
    const rawFamily = markAttr('textStyle', 'fontFamily')
    // docx wants a single font name, not a CSS stack — take the first, unquoted.
    const font = rawFamily
      ? rawFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
      : undefined
    return new TextRun({
      text: node.text || '',
      bold: hasMark('bold'),
      italics: hasMark('italic'),
      underline: hasMark('underline') ? {} : undefined,
      strike: hasMark('strike'),
      superScript: hasMark('superscript'),
      subScript: hasMark('subscript'),
      color: color || undefined,
      // docx size is in half-points.
      size: Number.isFinite(sizePt) && sizePt > 0 ? Math.round(sizePt * 2) : undefined,
      font,
    })
  })
}
