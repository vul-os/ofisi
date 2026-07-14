// pdf.go — the PDF writer.
//
// Pure Go, no Chromium, no font embedding: a minimal but valid PDF built
// object-by-object (Helvetica is a PDF standard font). What changed with the block
// model is that it no longer renders text ONLY:
//
//	Paragraph → wrapped text lines                          (as before)
//	Table     → a REAL ruled grid: cell borders + per-cell wrapped text
//	Image     → a REAL embedded image XObject (Flate-compressed RGB)
//
// Before, both were derived from the same flat paragraph list the DOCX used, so a
// table came out as loose paragraphs and an image came out as nothing at all.
//
// IMAGE PIPELINE. Every image is decoded, alpha-flattened onto white, downscaled to
// at most 2× its render size (so a 12-megapixel photo cannot inflate the PDF or the
// server's memory), converted to raw RGB and Flate-compressed. One code path for
// PNG/JPEG/GIF/WebP means no per-format viewer quirks.
package docs_export

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"image"
	"image/draw"
	"strings"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
)

const (
	pageWidth    = 595.28
	pageHeight   = 841.89
	marginLeft   = 72.0
	marginRight  = 72.0
	marginTop    = 72.0
	marginBottom = 72.0
	bodyWidth    = pageWidth - marginLeft - marginRight

	// PDF user-space units are points (1/72in); the document model measures in CSS
	// pixels (1/96in).
	ptPerPx = 72.0 / 96.0

	// A single embedded image is never stored at more than this many pixels wide —
	// twice the widest it can render, which is ample for print.
	maxEmbedWidthPx = 1400
)

// fontSizeForPara returns the PDF font size for a paragraph type.
func fontSizeForPara(p Paragraph) float64 {
	switch p.HeadingLevel {
	case 1:
		return 22
	case 2:
		return 18
	case 3:
		return 15
	case 4:
		return 13
	case 5:
		return 12
	case 6:
		return 11
	default:
		if p.IsCode {
			return 9
		}
		return 11
	}
}

func lineHeightForPara(p Paragraph) float64 { return fontSizeForPara(p) * 1.4 }

// wrapWords wraps text to a maximum width. Proper PDF measurement would need glyph
// metrics; we approximate Helvetica at ~0.55 × fontSize per character.
func wrapWords(text string, maxWidth, fontSize float64) []string {
	if text == "" {
		return []string{""}
	}
	charWidth := fontSize * 0.55
	maxChars := int(maxWidth / charWidth)
	if maxChars < 1 {
		maxChars = 1
	}
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{""}
	}
	var lines []string
	var cur strings.Builder
	for _, w := range words {
		switch {
		case cur.Len() == 0:
			cur.WriteString(w)
		case cur.Len()+1+utf8.RuneCountInString(w) <= maxChars:
			cur.WriteByte(' ')
			cur.WriteString(w)
		default:
			lines = append(lines, cur.String())
			cur.Reset()
			cur.WriteString(w)
		}
	}
	if cur.Len() > 0 {
		lines = append(lines, cur.String())
	}
	return lines
}

// pdfEscapeString escapes a string for a PDF literal-string (Tj) operand.
func pdfEscapeString(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '(':
			sb.WriteString(`\(`)
		case r == ')':
			sb.WriteString(`\)`)
		case r >= 32 && r < 127:
			sb.WriteRune(r)
		default:
			// The standard-font encoding is ASCII-only here; keep spacing sane.
			sb.WriteRune(' ')
		}
	}
	return sb.String()
}

// ─── image XObjects ─────────────────────────────────────────────────────────

type pdfImage struct {
	name    string // "/Im1"
	width   int
	height  int
	data    []byte // Flate-compressed RGB
	rawSize int
}

// encodeImage decodes, bounds, flattens and Flate-compresses an image for the PDF.
func encodeImage(img *Image, name string) (*pdfImage, error) {
	src, err := img.decoded()
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("empty image")
	}

	// Bound the stored resolution: a 12MP photo rendered 3 inches wide does not need
	// 12MP in the file (and must not cost us 36MB of RGB to hold).
	target := img.RenderWPx * 2
	if target <= 0 || target > maxEmbedWidthPx {
		target = maxEmbedWidthPx
	}
	if w > target {
		nh := int(float64(h) * float64(target) / float64(w))
		if nh < 1 {
			nh = 1
		}
		dst := image.NewRGBA(image.Rect(0, 0, target, nh))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Over, nil)
		src = dst
		b = dst.Bounds()
		w, h = target, nh
	}

	// Flatten onto white: PDF /DeviceRGB has no alpha channel, and an unflattened
	// transparent PNG would otherwise composite against garbage.
	flat := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(flat, flat.Bounds(), image.NewUniform(image.White), image.Point{}, draw.Src)
	draw.Draw(flat, flat.Bounds(), src, b.Min, draw.Over)

	rgb := make([]byte, 0, w*h*3)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := flat.RGBAAt(x, y)
			rgb = append(rgb, c.R, c.G, c.B)
		}
	}

	var buf bytes.Buffer
	zw := zlib.NewWriter(&buf)
	if _, err := zw.Write(rgb); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return &pdfImage{name: name, width: w, height: h, data: buf.Bytes(), rawSize: len(rgb)}, nil
}

// ─── the document builder ───────────────────────────────────────────────────

// pdfDoc lays content out top-down across pages, accumulating one content stream
// per page plus the image XObjects those streams reference.
type pdfDoc struct {
	pages  []string
	cur    strings.Builder
	y      float64
	images []*pdfImage
	rep    *Report
}

func newPDFDoc(rep *Report) *pdfDoc {
	return &pdfDoc{y: pageHeight - marginTop, rep: rep}
}

func (d *pdfDoc) newPage() {
	d.pages = append(d.pages, d.cur.String())
	d.cur.Reset()
	d.y = pageHeight - marginTop
}

// space reserves h points, breaking the page when they do not fit.
func (d *pdfDoc) space(h float64) {
	if d.y-h < marginBottom {
		d.newPage()
	}
}

func (d *pdfDoc) text(s string, x, y, size float64, bold bool) {
	font := "F1"
	if bold {
		font = "F2"
	}
	fmt.Fprintf(&d.cur, "BT\n/%s %g Tf\n%g %g Td\n(%s) Tj\nET\n", font, size, x, y, pdfEscapeString(s))
}

// rect strokes a rectangle outline (used for table cell borders).
func (d *pdfDoc) rect(x, y, w, h float64) {
	fmt.Fprintf(&d.cur, "q 0.5 w 0.6 0.6 0.6 RG %g %g %g %g re S Q\n", x, y, w, h)
}

func (d *pdfDoc) drawParagraph(p Paragraph) {
	size := fontSizeForPara(p)
	lh := lineHeightForPara(p)
	bold := p.HeadingLevel > 0
	x := marginLeft
	if p.IsBullet {
		x = marginLeft + 12
	}
	if p.IsBlockquote {
		x = marginLeft + 20
	}

	before := 4.0
	if p.HeadingLevel > 0 {
		before = size * 0.5
	}
	d.y -= before
	if d.y < marginBottom {
		d.newPage()
	}

	prefix := ""
	if p.IsBullet {
		prefix = "• "
	}
	for _, line := range wrapWords(prefix+p.Text, bodyWidth-(x-marginLeft), size) {
		if d.y-lh < marginBottom {
			d.newPage()
		}
		d.y -= lh
		d.text(line, x, d.y, size, bold)
	}
	if p.HeadingLevel > 0 {
		d.y -= size * 0.3
	}
}

// drawImage places an image at the left margin, scaled to fit the body width, and
// registers its XObject.
func (d *pdfDoc) drawImage(img *Image) {
	name := fmt.Sprintf("/Im%d", len(d.images)+1)
	xo, err := encodeImage(img, name)
	if err != nil {
		d.rep.warn("An image could not be rendered into the PDF: %v.", err)
		return
	}
	d.images = append(d.images, xo)

	w := float64(img.RenderWPx) * ptPerPx
	h := float64(img.RenderHPx) * ptPerPx
	if w > bodyWidth {
		h *= bodyWidth / w
		w = bodyWidth
	}
	// An image taller than the page is scaled to fit rather than clipped away.
	maxH := pageHeight - marginTop - marginBottom
	if h > maxH {
		w *= maxH / h
		h = maxH
	}

	d.y -= 6
	if d.y-h < marginBottom {
		d.newPage()
	}
	d.y -= h
	fmt.Fprintf(&d.cur, "q %g 0 0 %g %g %g cm %s Do Q\n", w, h, marginLeft, d.y, name)
	d.y -= 6
}

// drawTable renders a REAL grid: even columns, per-cell wrapped text, ruled borders,
// and a page break between rows that do not fit.
func (d *pdfDoc) drawTable(t *Table) {
	cols := max(1, t.Cols)
	colW := bodyWidth / float64(cols)
	const padX, padY = 4.0, 4.0
	const cellSize = 10.0
	cellLH := cellSize * 1.35

	d.y -= 8

	for _, row := range t.Rows {
		// Lay the row out first: its height is the tallest cell.
		type laidCell struct {
			lines []string
			span  int
			bold  bool
		}
		var cells []laidCell
		maxLines := 1
		for _, c := range row.Cells {
			span := max(1, c.ColSpan)
			w := colW*float64(span) - 2*padX
			text := cellText(c)
			lines := wrapWords(text, w, cellSize)
			if len(lines) > maxLines {
				maxLines = len(lines)
			}
			cells = append(cells, laidCell{lines: lines, span: span, bold: c.IsHeader || row.Header})
		}
		rowH := float64(maxLines)*cellLH + 2*padY

		// A row taller than a whole page cannot be split by this renderer; it starts
		// on a fresh page and is allowed to overflow rather than vanish.
		if d.y-rowH < marginBottom {
			d.newPage()
		}

		x := marginLeft
		top := d.y
		for i, c := range cells {
			w := colW * float64(c.span)
			d.rect(x, top-rowH, w, rowH)
			ty := top - padY - cellSize
			for _, line := range c.lines {
				d.text(line, x+padX, ty, cellSize, c.bold)
				ty -= cellLH
			}
			x += w
			_ = i
		}
		d.y = top - rowH
	}
	d.y -= 8
}

// cellText flattens a cell's blocks to a single string for the PDF grid. A cell
// image is noted by its alt text — the PDF table renderer places text, not pictures,
// inside a cell, and saying so is better than dropping it in silence.
func cellText(c TableCell) string {
	var parts []string
	for _, b := range c.Blocks {
		switch b.Kind {
		case BlockParagraph:
			if t := strings.TrimSpace(b.Para.Text); t != "" {
				parts = append(parts, t)
			}
		case BlockImage:
			if b.Image != nil {
				alt := b.Image.Alt
				if alt == "" {
					alt = "image"
				}
				parts = append(parts, "["+alt+"]")
			}
		case BlockTable:
			if b.Table != nil {
				for _, r := range b.Table.Rows {
					for _, cc := range r.Cells {
						if t := cellText(cc); t != "" {
							parts = append(parts, t)
						}
					}
				}
			}
		}
	}
	return strings.Join(parts, " ")
}

// GeneratePDF renders the document blocks — text, TABLES and IMAGES — to a PDF.
//
// The report collects anything the PDF path cannot carry (e.g. an image inside a
// table cell, which is rendered as its alt text): the caller must surface it.
func GeneratePDF(title string, blocks []Block) ([]byte, error) {
	rep := &Report{}
	data, _, err := GeneratePDFReport(title, blocks, rep)
	return data, err
}

// GeneratePDFReport is GeneratePDF with an explicit report to append to, so a caller
// that already holds an extraction report gets ONE list of warnings.
func GeneratePDFReport(title string, blocks []Block, rep *Report) ([]byte, *Report, error) {
	if rep == nil {
		rep = &Report{}
	}
	d := newPDFDoc(rep)

	for _, b := range blocks {
		switch b.Kind {
		case BlockParagraph:
			d.drawParagraph(b.Para)
		case BlockTable:
			if b.Table != nil {
				d.drawTable(b.Table)
				if tableHasImage(b.Table) {
					rep.warn("An image inside a table was shown as its alt text in the PDF (the .docx export embeds it).")
				}
			}
		case BlockImage:
			if b.Image != nil {
				d.drawImage(b.Image)
			}
		}
	}
	d.pages = append(d.pages, d.cur.String())

	return d.render(), rep, nil
}

func tableHasImage(t *Table) bool {
	for _, r := range t.Rows {
		for _, c := range r.Cells {
			for _, b := range c.Blocks {
				if b.Kind == BlockImage {
					return true
				}
				if b.Kind == BlockTable && b.Table != nil && tableHasImage(b.Table) {
					return true
				}
			}
		}
	}
	return false
}

// render serialises the laid-out pages into the PDF file structure.
func (d *pdfDoc) render() []byte {
	var buf bytes.Buffer
	var objOffsets []int

	write := func(s string) { buf.WriteString(s) }
	writef := func(format string, args ...any) { fmt.Fprintf(&buf, format, args...) }
	startObj := func(n int) {
		objOffsets = append(objOffsets, buf.Len())
		writef("%d 0 obj\n", n)
	}
	endObj := func() { write("endobj\n") }

	write("%PDF-1.4\n")
	write("%\xe2\xe3\xcf\xd3\n")

	pages := d.pages
	if len(pages) == 0 {
		pages = []string{""}
	}

	// Object numbering: 1 catalog, 2 pages tree, then page+stream pairs, then the
	// two fonts, then one object per image.
	nPages := len(pages)
	pageObj := make([]int, nPages)
	streamObj := make([]int, nPages)
	next := 3
	for i := range pages {
		pageObj[i] = next
		next++
		streamObj[i] = next
		next++
	}
	fontReg := next
	next++
	fontBold := next
	next++
	imgObj := make([]int, len(d.images))
	for i := range d.images {
		imgObj[i] = next
		next++
	}
	totalObjs := next

	startObj(1)
	write("<< /Type /Catalog /Pages 2 0 R >>\n")
	endObj()

	startObj(2)
	var kids strings.Builder
	for _, n := range pageObj {
		fmt.Fprintf(&kids, "%d 0 R ", n)
	}
	writef("<< /Type /Pages /Kids [%s] /Count %d >>\n", strings.TrimSpace(kids.String()), nPages)
	endObj()

	// The XObject resource dictionary is shared by every page: simpler than tracking
	// per-page usage, and a referenced-but-unused XObject is legal.
	var xobjRes strings.Builder
	if len(d.images) > 0 {
		xobjRes.WriteString(" /XObject << ")
		for i, img := range d.images {
			fmt.Fprintf(&xobjRes, "%s %d 0 R ", img.name, imgObj[i])
		}
		xobjRes.WriteString(">>")
	}

	for i, content := range pages {
		startObj(pageObj[i])
		writef("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %g %g]\n", pageWidth, pageHeight)
		writef("   /Resources << /Font << /F1 %d 0 R /F2 %d 0 R >>%s >>\n", fontReg, fontBold, xobjRes.String())
		writef("   /Contents %d 0 R >>\n", streamObj[i])
		endObj()

		startObj(streamObj[i])
		writef("<< /Length %d >>\n", len(content))
		write("stream\n")
		write(content)
		write("\nendstream\n")
		endObj()
	}

	startObj(fontReg)
	write("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n")
	endObj()

	startObj(fontBold)
	write("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n")
	endObj()

	for i, img := range d.images {
		startObj(imgObj[i])
		writef("<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\n",
			img.width, img.height, len(img.data))
		write("stream\n")
		buf.Write(img.data)
		write("\nendstream\n")
		endObj()
	}

	xrefOffset := buf.Len()
	write("xref\n")
	writef("0 %d\n", totalObjs)
	write("0000000000 65535 f \n")
	for i := 1; i < totalObjs; i++ {
		idx := i - 1
		if idx < len(objOffsets) {
			writef("%010d 00000 n \n", objOffsets[idx])
		} else {
			write("0000000000 65535 f \n")
		}
	}
	write("trailer\n")
	writef("<< /Size %d /Root 1 0 R >>\n", totalObjs)
	write("startxref\n")
	writef("%d\n", xrefOffset)
	write("%%EOF\n")

	return buf.Bytes()
}
