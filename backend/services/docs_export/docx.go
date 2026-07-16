// docx.go — the OOXML (.docx) writer.
//
// Hand-rolled, as before: we assemble the ZIP entries ourselves rather than pull in
// a third-party DOCX library whose licence may not fit the project's. What changed
// is WHAT we can express. The writer used to render a flat []Paragraph — one
// <w:p> each — which is why the server's DOCX had no images and no tables at all
// (see blocks.go). It now renders []Block:
//
//	Paragraph → <w:p>            (as before)
//	Table     → <w:tbl>          real rows/cells/borders, gridSpan for colspan
//	Image     → <w:drawing>      real embedded bytes in word/media + a relationship
//
// Parts written:
//
//	[Content_Types].xml            (+ a Default per image extension in use)
//	_rels/.rels
//	word/document.xml
//	word/_rels/document.xml.rels   (+ one relationship per image)
//	word/styles.xml
//	word/media/imageN.<ext>        (one per embedded image)
package docs_export

import (
	"archive/zip"
	"bytes"
	"fmt"
	"sort"
	"strings"
)

// EMU (English Metric Units) per pixel at 96 dpi — the unit DrawingML sizes in.
const emuPerPx = 9525

const contentTypesHead = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
`

const contentTypesTail = `  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const relsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`

const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="160"/></w:pPr>
    <w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
    <w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
    <w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/>
    <w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="18"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="999999"/>
        <w:left w:val="single" w:sz="4" w:color="999999"/>
        <w:bottom w:val="single" w:sz="4" w:color="999999"/>
        <w:right w:val="single" w:sz="4" w:color="999999"/>
        <w:insideH w:val="single" w:sz="4" w:color="999999"/>
        <w:insideV w:val="single" w:sz="4" w:color="999999"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>`

// documentOpen declares every namespace the body can use: w (wordprocessing),
// r (relationships — image references), wp/a/pic (DrawingML — the picture itself).
const documentOpen = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
`

const documentClose = `    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`

// xmlText escapes a string for an XML text node AND removes the characters XML 1.0
// cannot carry (NUL/VT/FF/…). Word REJECTS a document that contains them ("the file
// is corrupt"), and nothing upstream strips them — a control char pasted into a doc
// would otherwise make the whole export unopenable.
func xmlText(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '&':
			sb.WriteString("&amp;")
		case r == '<':
			sb.WriteString("&lt;")
		case r == '>':
			sb.WriteString("&gt;")
		case r == '"':
			sb.WriteString("&quot;")
		case r == '\t' || r == '\n' || r == '\r':
			sb.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			// XML-1.0-illegal control character — drop.
		case r >= 0xFFFE:
			// Non-characters.
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// xmlAttr escapes for an attribute value (adds the apostrophe).
func xmlAttr(s string) string {
	return strings.ReplaceAll(xmlText(s), "'", "&apos;")
}

func styleIDFor(p Paragraph) string {
	switch p.HeadingLevel {
	case 1:
		return "Heading1"
	case 2:
		return "Heading2"
	case 3:
		return "Heading3"
	}
	if p.IsCode {
		return "Code"
	}
	return "Normal"
}

func indentFor(p Paragraph) string {
	if p.IsBullet {
		return `<w:ind w:left="720"/>`
	}
	if p.IsBlockquote {
		return `<w:ind w:left="1080"/>`
	}
	return ""
}

// docxWriter accumulates the body XML plus the media parts the body references.
type docxWriter struct {
	body   strings.Builder
	images []docxImage
	nextID int // DrawingML object ids must be unique across the document
}

type docxImage struct {
	name string // "image1.png"
	rID  string // "rId2"
	data []byte
	ext  string
}

func (w *docxWriter) writeParagraph(p Paragraph) {
	bullet := ""
	if p.IsBullet {
		bullet = `<w:r><w:t xml:space="preserve">• </w:t></w:r>`
	}
	fmt.Fprintf(&w.body,
		"    <w:p><w:pPr><w:pStyle w:val=\"%s\"/>%s</w:pPr>%s<w:r><w:t xml:space=\"preserve\">%s</w:t></w:r></w:p>\n",
		styleIDFor(p), indentFor(p), bullet, xmlText(p.Text))
}

// writeImage embeds the image bytes as a part and emits an inline <w:drawing>.
func (w *docxWriter) writeImage(img *Image) {
	w.nextID++
	id := w.nextID
	rID := fmt.Sprintf("rId%d", len(w.images)+2) // rId1 is styles.xml
	name := fmt.Sprintf("image%d.%s", len(w.images)+1, img.Ext)
	w.images = append(w.images, docxImage{name: name, rID: rID, data: img.Data, ext: img.Ext})

	cx := img.RenderWPx * emuPerPx
	cy := img.RenderHPx * emuPerPx
	alt := xmlAttr(img.Alt)

	fmt.Fprintf(&w.body, `    <w:p><w:r><w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="%d" cy="%d"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:docPr id="%d" name="Picture %d" descr="%s"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic>
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic>
              <pic:nvPicPr><pic:cNvPr id="%d" name="%s" descr="%s"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>
                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing></w:r></w:p>
`, cx, cy, id, id, alt, id, xmlAttr(name), alt, rID, cx, cy)
}

// writeTable emits a real <w:tbl>. Column widths are even; a colspan becomes a
// gridSpan. Word requires a paragraph after a table, so one is always appended —
// without it Word declares the document corrupt and "repairs" it.
func (w *docxWriter) writeTable(t *Table) {
	cols := max(1, t.Cols)
	// Table width is expressed in fiftieths of a percent (5000 = 100%).
	colW := 9360 / cols // total content width in twips (6.5in), split evenly

	w.body.WriteString("    <w:tbl>\n")
	w.body.WriteString(`      <w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>` +
		`<w:tblBorders>` +
		`<w:top w:val="single" w:sz="4" w:color="999999"/>` +
		`<w:left w:val="single" w:sz="4" w:color="999999"/>` +
		`<w:bottom w:val="single" w:sz="4" w:color="999999"/>` +
		`<w:right w:val="single" w:sz="4" w:color="999999"/>` +
		`<w:insideH w:val="single" w:sz="4" w:color="999999"/>` +
		`<w:insideV w:val="single" w:sz="4" w:color="999999"/>` +
		`</w:tblBorders></w:tblPr>` + "\n")
	w.body.WriteString("      <w:tblGrid>")
	for i := 0; i < cols; i++ {
		fmt.Fprintf(&w.body, `<w:gridCol w:w="%d"/>`, colW)
	}
	w.body.WriteString("</w:tblGrid>\n")

	for _, row := range t.Rows {
		w.body.WriteString("      <w:tr>")
		for _, cell := range row.Cells {
			w.body.WriteString("<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/>")
			if cell.ColSpan > 1 {
				fmt.Fprintf(&w.body, `<w:gridSpan w:val="%d"/>`, cell.ColSpan)
			}
			if cell.RowSpan > 1 {
				// A vertically merged cell starts the merge here; the continuation
				// cells the editor stores are emitted as their own restart-less <w:tc>.
				w.body.WriteString(`<w:vMerge w:val="restart"/>`)
			}
			if cell.IsHeader {
				w.body.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>`)
			}
			w.body.WriteString("</w:tcPr>")
			w.writeCellBlocks(cell)
			w.body.WriteString("</w:tc>")
		}
		w.body.WriteString("</w:tr>\n")
	}
	w.body.WriteString("    </w:tbl>\n")
	// A table must be followed by a paragraph (CT_Body content model).
	w.body.WriteString("    <w:p/>\n")
}

// writeCellBlocks renders a cell's content. A cell must contain at least one
// paragraph — an empty <w:tc> is invalid.
func (w *docxWriter) writeCellBlocks(cell TableCell) {
	wrote := false
	for _, b := range cell.Blocks {
		switch b.Kind {
		case BlockParagraph:
			p := b.Para
			if cell.IsHeader && p.HeadingLevel == 0 {
				// Header cells read as bold body text.
				fmt.Fprintf(&w.body,
					`<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">%s</w:t></w:r></w:p>`,
					xmlText(p.Text))
				wrote = true
				continue
			}
			w.writeParagraph(p)
			wrote = true
		case BlockImage:
			if b.Image != nil {
				w.writeImage(b.Image)
				wrote = true
			}
		case BlockTable:
			if b.Table != nil {
				w.writeTable(b.Table)
				wrote = true
			}
		}
	}
	if !wrote {
		w.body.WriteString("<w:p/>")
	}
}

func (w *docxWriter) writeBlocks(blocks []Block) {
	for _, b := range blocks {
		switch b.Kind {
		case BlockParagraph:
			w.writeParagraph(b.Para)
		case BlockTable:
			if b.Table != nil {
				w.writeTable(b.Table)
			}
		case BlockImage:
			if b.Image != nil {
				w.writeImage(b.Image)
			}
		}
	}
}

// contentTypes declares a Default for every image extension actually used. Word
// refuses to open a package whose media parts have no declared content type.
func (w *docxWriter) contentTypes() string {
	seen := map[string]bool{}
	for _, img := range w.images {
		seen[img.ext] = true
	}
	exts := make([]string, 0, len(seen))
	for e := range seen {
		exts = append(exts, e)
	}
	sort.Strings(exts) // deterministic output

	var sb strings.Builder
	sb.WriteString(contentTypesHead)
	for _, e := range exts {
		mime := "image/" + e
		if e == "jpeg" {
			// Both extensions are commonly used; we only ever write ".jpeg".
			mime = "image/jpeg"
		}
		fmt.Fprintf(&sb, "  <Default Extension=\"%s\" ContentType=\"%s\"/>\n", e, mime)
	}
	sb.WriteString(contentTypesTail)
	return sb.String()
}

func (w *docxWriter) documentRels() string {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	sb.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + "\n")
	sb.WriteString(`  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` + "\n")
	for _, img := range w.images {
		fmt.Fprintf(&sb,
			`  <Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/%s"/>`+"\n",
			img.rID, img.name)
	}
	sb.WriteString(`</Relationships>`)
	return sb.String()
}

// GenerateDOCX renders the document blocks to a valid OOXML .docx package —
// including its TABLES and its IMAGES.
//
// It takes []Block, not []Paragraph: the flat paragraph list is exactly what used
// to destroy tables (12 loose paragraphs for a 3×4 table) and drop images entirely.
func GenerateDOCX(title string, blocks []Block) ([]byte, error) {
	w := &docxWriter{}
	w.body.WriteString(documentOpen)
	w.writeBlocks(blocks)
	w.body.WriteString(documentClose)

	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)

	write := func(name string, data []byte) error {
		f, err := zw.Create(name)
		if err != nil {
			return fmt.Errorf("docs_export: zip create %s: %w", name, err)
		}
		if _, err := f.Write(data); err != nil {
			return fmt.Errorf("docs_export: zip write %s: %w", name, err)
		}
		return nil
	}

	if err := write("[Content_Types].xml", []byte(w.contentTypes())); err != nil {
		return nil, err
	}
	if err := write("_rels/.rels", []byte(relsXML)); err != nil {
		return nil, err
	}
	if err := write("word/_rels/document.xml.rels", []byte(w.documentRels())); err != nil {
		return nil, err
	}
	if err := write("word/styles.xml", []byte(stylesXML)); err != nil {
		return nil, err
	}
	if err := write("word/document.xml", []byte(w.body.String())); err != nil {
		return nil, err
	}
	for _, img := range w.images {
		if err := write("word/media/"+img.name, img.data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("docs_export: zip close: %w", err)
	}
	return zipBuf.Bytes(), nil
}
