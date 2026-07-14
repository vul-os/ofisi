// blocks.go — the document's BLOCK structure, which the server exporter used to
// throw away.
//
// THE BUG THIS FIXES. extractNode() handled paragraph / heading / lists /
// codeBlock / blockquote / horizontalRule, and its `default` branch merely
// recursed into n.Content. Two node kinds are destroyed by that:
//
//   - IMAGE. An image node is ATOMIC — all of its content is in `attrs` and its
//     Content is empty (see src/apps/docs/docsImage.js). Recursing into an empty
//     Content yields NOTHING, so every image silently vanished from the server's
//     DOCX and PDF. HTTP 200, no warning.
//
//   - TABLE. Recursing into a table walks its rows → cells → paragraphs, so a 3×4
//     table was emitted as 12 LOOSE TOP-LEVEL PARAGRAPHS. The text survived; the
//     structure — which is what a table IS — was shredded.
//
// The browser exporter (src/apps/docs/docsExport.js) gets both right: it imports
// Table/TableRow/TableCell and ImageRun from `docx`. This file gives the server the
// same model — a flat []Block where a block is a paragraph, a TABLE, or an IMAGE —
// and the DOCX/PDF writers render all three.
//
// TRUST BOUNDARY. Document content is untrusted (a hostile collaborator can PUT
// any doc JSON). So:
//   - only RASTER data: images are embedded (png/jpeg/gif/webp), matching the
//     editor's own embed allow-list; an SVG data: URI is refused (script carrier),
//   - a REMOTE image (http/https) is NOT fetched. The server must not be turned
//     into an SSRF probe by a document. It is reported as a warning instead —
//     dropped loudly, never silently,
//   - images are bounded (bytes + pixels) so one document cannot exhaust memory,
//   - table nesting is bounded, so a deeply-nested table cannot blow the stack.
package docs_export

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"regexp"
	"strings"

	"golang.org/x/image/webp"
)

// Limits. An inline image is capped at the same 5 MiB the editor enforces
// (docsImage.js MAX_INLINE_IMAGE_BYTES); the pixel cap stops a "decompression
// bomb" (a tiny file that decodes to gigapixels) from exhausting memory.
const (
	MaxImageBytes  = 5 << 20 // 5 MiB of decoded image data
	MaxImagePixels = 40 << 20
	maxTableDepth  = 3
	// Page content width in px at 96dpi (Letter, 1in margins) — the widest an
	// image may render before we scale it down.
	contentWidthPx = 624
)

// BlockKind discriminates the Block union.
type BlockKind string

const (
	BlockParagraph BlockKind = "paragraph"
	BlockTable     BlockKind = "table"
	BlockImage     BlockKind = "image"
)

// Block is one top-level piece of the document.
type Block struct {
	Kind  BlockKind
	Para  Paragraph
	Table *Table
	Image *Image
}

// Table is a real table: rows of cells, each cell holding its own blocks.
type Table struct {
	Rows []TableRow
	// Cols is the widest row's cell count — the DOCX tblGrid needs it.
	Cols int
}

// TableRow is one row; Header marks a header row (rendered bold/shaded).
type TableRow struct {
	Cells  []TableCell
	Header bool
}

// TableCell holds the cell's own content. Cells can carry paragraphs and images.
type TableCell struct {
	Blocks   []Block
	ColSpan  int
	RowSpan  int
	IsHeader bool
}

// Image is a decoded, bounded raster image ready to embed.
type Image struct {
	Data     []byte // the bytes as they will be written into the package
	Ext      string // "png" | "jpeg" | "gif"
	Mime     string // "image/png" | …
	WidthPx  int    // intrinsic width
	HeightPx int    // intrinsic height
	// Render size, honouring the node's width attr and the page width.
	RenderWPx int
	RenderHPx int
	Alt       string
}

// ─── Report ─────────────────────────────────────────────────────────────────

// Report is the honest account of a docs export: what it carried, and what it
// could not. A caller MUST surface the warnings — an export that quietly loses an
// image is the bug this type exists to prevent.
type Report struct {
	ImagesEmbedded int      `json:"images_embedded"`
	TablesEmbedded int      `json:"tables_embedded"`
	Warnings       []string `json:"warnings,omitempty"`
}

// Degraded reports whether anything about this export was lossy.
func (r *Report) Degraded() bool { return r != nil && len(r.Warnings) > 0 }

func (r *Report) warn(format string, args ...any) {
	if r == nil {
		return
	}
	msg := sanitizeWarning(fmt.Sprintf(format, args...))
	for _, w := range r.Warnings {
		if w == msg {
			return // one warning per distinct cause, not one per occurrence
		}
	}
	r.Warnings = append(r.Warnings, msg)
}

// sanitizeWarning keeps a warning safe to put on an HTTP response header: single
// line, no control characters, bounded length.
func sanitizeWarning(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			sb.WriteRune(' ')
		case r < 0x20 || r == 0x7f:
			// drop
		default:
			sb.WriteRune(r)
		}
	}
	out := strings.TrimSpace(sb.String())
	if len(out) > 300 {
		out = out[:299] + "…"
	}
	return out
}

// ─── Extraction ─────────────────────────────────────────────────────────────

// ExtractBlocks walks the TipTap tree and returns the document as blocks —
// paragraphs, REAL tables, and REAL images — plus a report of anything the export
// cannot carry.
func ExtractBlocks(doc *DocJSON) ([]Block, *Report) {
	rep := &Report{}
	var out []Block
	headings := headingOutline(doc)
	for _, n := range doc.Content {
		out = append(out, extractBlocks(n, rep, 0, headings)...)
	}
	return out, rep
}

// ExtractParagraphs returns the document as a flat paragraph list.
//
// Retained for callers that want a plain-text/outline view of a document (and for
// the tests that pin that behaviour). It is NOT what the exporters use: flattening
// is precisely what destroyed tables and images before ExtractBlocks existed.
func ExtractParagraphs(doc *DocJSON) []Paragraph {
	blocks, _ := ExtractBlocks(doc)
	return FlattenBlocks(blocks)
}

// FlattenBlocks reduces blocks to paragraphs (tables → their cell text, images →
// their alt text). Lossy by definition — for text-only consumers.
func FlattenBlocks(blocks []Block) []Paragraph {
	var out []Paragraph
	for _, b := range blocks {
		switch b.Kind {
		case BlockParagraph:
			out = append(out, b.Para)
		case BlockTable:
			if b.Table == nil {
				continue
			}
			for _, row := range b.Table.Rows {
				for _, cell := range row.Cells {
					out = append(out, FlattenBlocks(cell.Blocks)...)
				}
			}
		case BlockImage:
			if b.Image != nil && b.Image.Alt != "" {
				out = append(out, Paragraph{Text: b.Image.Alt})
			}
		}
	}
	return out
}

func para(p Paragraph) Block { return Block{Kind: BlockParagraph, Para: p} }

func paras(ps []Paragraph) []Block {
	out := make([]Block, 0, len(ps))
	for _, p := range ps {
		out = append(out, para(p))
	}
	return out
}

// extractBlocks is extractNode's structure-preserving replacement.
func extractBlocks(n Node, rep *Report, depth int, headings []headingRef) []Block {
	switch n.Type {
	case "image":
		img, err := decodeImageNode(n)
		if err != nil {
			rep.warn("An image was not embedded in the export: %s.", err.Error())
			// The alt text is all that is left of it — better than nothing, and the
			// caller has been told.
			if alt := attrString(n.Attrs, "alt"); alt != "" {
				return []Block{para(Paragraph{Text: "[image: " + alt + "]"})}
			}
			return nil
		}
		rep.ImagesEmbedded++
		return []Block{{Kind: BlockImage, Image: img}}

	case "table":
		if depth >= maxTableDepth {
			rep.warn("A table nested more than %d levels deep was flattened to text.", maxTableDepth)
			return paras(extractNodeParagraphs(n))
		}
		tbl := extractTable(n, rep, depth+1, headings)
		if tbl == nil || len(tbl.Rows) == 0 {
			return nil
		}
		rep.TablesEmbedded++
		return []Block{{Kind: BlockTable, Table: tbl}}

	case "mathBlock":
		// Best-effort, and the SAME best effort the browser makes (docsExport.js):
		// there is no LaTeX→OMML path, so a display equation is exported as its
		// LaTeX source. Before this case existed the node hit `default`, had no
		// Content to recurse into, and vanished without a trace.
		latex := attrString(n.Attrs, "latex")
		if latex == "" {
			return nil
		}
		rep.warn("Equations were exported as their LaTeX source (the server cannot typeset math).")
		return []Block{para(Paragraph{Text: latex, IsCode: true})}

	case "tableOfContents":
		// The live ToC renders from a node view, so the stored node is an empty
		// shell. Bake the heading outline in, as the browser export does.
		if len(headings) == 0 {
			return nil
		}
		out := []Block{para(Paragraph{Text: "Table of Contents", HeadingLevel: 2})}
		for _, h := range headings {
			t := h.text
			if t == "" {
				t = "(untitled heading)"
			}
			out = append(out, para(Paragraph{Text: strings.Repeat("    ", max(0, h.level-1)) + t}))
		}
		return out

	case "paragraph", "heading", "bulletList", "orderedList", "taskList",
		"codeBlock", "blockquote", "horizontalRule":
		// These carry no structure the flat model loses — but their children might
		// (a list item can hold an image), so containers recurse through here.
		return blocksFromFlat(n, rep, depth, headings)

	default:
		var out []Block
		for _, child := range n.Content {
			out = append(out, extractBlocks(child, rep, depth, headings)...)
		}
		return out
	}
}

// blocksFromFlat handles the paragraph-shaped nodes, lifting any IMAGE nested
// inside them (e.g. an image in a list item) into its own block rather than
// letting it disappear into a text-only extraction.
func blocksFromFlat(n Node, rep *Report, depth int, headings []headingRef) []Block {
	switch n.Type {
	case "bulletList", "orderedList", "taskList":
		var out []Block
		for _, item := range n.Content {
			for _, child := range item.Content {
				for _, b := range extractBlocks(child, rep, depth, headings) {
					if b.Kind == BlockParagraph {
						b.Para.IsBullet = true
					}
					out = append(out, b)
				}
			}
		}
		return out

	case "blockquote":
		var out []Block
		for _, child := range n.Content {
			for _, b := range extractBlocks(child, rep, depth, headings) {
				if b.Kind == BlockParagraph {
					b.Para.IsBlockquote = true
				}
				out = append(out, b)
			}
		}
		return out

	case "paragraph":
		// A paragraph whose only child is an image is how TipTap stores a picture in
		// some documents; hoist it so the image is embedded, not dropped.
		var imgs []Block
		for _, child := range n.Content {
			if child.Type == "image" {
				imgs = append(imgs, extractBlocks(child, rep, depth, headings)...)
			}
		}
		text := extractText(n.Content)
		if len(imgs) > 0 {
			if strings.TrimSpace(text) == "" {
				return imgs
			}
			return append([]Block{para(Paragraph{Text: text})}, imgs...)
		}
		return []Block{para(Paragraph{Text: text})}

	default:
		return paras(extractNodeParagraphs(n))
	}
}

// extractNodeParagraphs is the original flat extraction, kept for the leaf cases
// (heading / codeBlock / horizontalRule) and for flattening fallbacks.
func extractNodeParagraphs(n Node) []Paragraph {
	return extractNode(n)
}

// ─── Tables ─────────────────────────────────────────────────────────────────

func extractTable(n Node, rep *Report, depth int, headings []headingRef) *Table {
	t := &Table{}
	for _, rowNode := range n.Content {
		if rowNode.Type != "tableRow" {
			continue
		}
		row := TableRow{}
		allHeader := len(rowNode.Content) > 0
		for _, cellNode := range rowNode.Content {
			if cellNode.Type != "tableCell" && cellNode.Type != "tableHeader" {
				continue
			}
			isHeader := cellNode.Type == "tableHeader"
			if !isHeader {
				allHeader = false
			}
			cell := TableCell{
				ColSpan:  attrInt(cellNode.Attrs, "colspan", 1),
				RowSpan:  attrInt(cellNode.Attrs, "rowspan", 1),
				IsHeader: isHeader,
			}
			for _, child := range cellNode.Content {
				cell.Blocks = append(cell.Blocks, extractBlocks(child, rep, depth, headings)...)
			}
			if len(cell.Blocks) == 0 {
				// A cell must render SOMETHING or the row loses a column.
				cell.Blocks = []Block{para(Paragraph{Text: ""})}
			}
			row.Cells = append(row.Cells, cell)
		}
		if len(row.Cells) == 0 {
			continue
		}
		row.Header = allHeader
		width := 0
		for _, c := range row.Cells {
			width += max(1, c.ColSpan)
		}
		if width > t.Cols {
			t.Cols = width
		}
		t.Rows = append(t.Rows, row)
	}
	if t.Cols == 0 {
		return nil
	}
	return t
}

// ─── Images ─────────────────────────────────────────────────────────────────

var dataURIRe = regexp.MustCompile(`(?is)^data:(image/(?:png|jpe?g|gif|webp))\s*;\s*base64\s*,(.*)$`)
var pxRe = regexp.MustCompile(`^(\d+)(?:px)?$`)

// decodeImageNode turns an image node into embeddable bytes, or explains why it
// cannot. The error text is caller-presentable: it becomes the export warning.
func decodeImageNode(n Node) (*Image, error) {
	src := strings.TrimSpace(attrString(n.Attrs, "src"))
	if src == "" {
		return nil, fmt.Errorf("it has no source")
	}

	m := dataURIRe.FindStringSubmatch(src)
	if m == nil {
		// A REMOTE image. We do not fetch it: a document is untrusted input, and an
		// exporter that fetched arbitrary URLs would be a server-side request-forgery
		// probe (and could leak the reader's export to a third party). Say so.
		if strings.HasPrefix(strings.ToLower(src), "http://") || strings.HasPrefix(strings.ToLower(src), "https://") {
			return nil, fmt.Errorf("the server does not fetch remote images (%s)", hostOf(src))
		}
		return nil, fmt.Errorf("only PNG, JPEG, GIF and WebP images can be embedded")
	}

	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(m[2]))
	if err != nil {
		// Tolerate the unpadded/whitespaced base64 a browser may produce.
		cleaned := strings.NewReplacer("\n", "", "\r", "", " ", "", "\t", "").Replace(m[2])
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(cleaned, "="))
		if err != nil {
			return nil, fmt.Errorf("its data could not be decoded")
		}
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("its data is empty")
	}
	if len(raw) > MaxImageBytes {
		return nil, fmt.Errorf("it is larger than %d MB", MaxImageBytes>>20)
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("it is not a readable image")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, fmt.Errorf("it has no dimensions")
	}
	if cfg.Width*cfg.Height > MaxImagePixels {
		return nil, fmt.Errorf("it is too large to embed (%d×%d)", cfg.Width, cfg.Height)
	}

	img := &Image{
		Data:     raw,
		WidthPx:  cfg.Width,
		HeightPx: cfg.Height,
		Alt:      attrString(n.Attrs, "alt"),
	}

	switch format {
	case "png":
		img.Ext, img.Mime = "png", "image/png"
	case "jpeg":
		img.Ext, img.Mime = "jpeg", "image/jpeg"
	case "gif":
		img.Ext, img.Mime = "gif", "image/gif"
	case "webp":
		// Word/PowerPoint support for WebP is recent and patchy, and our PDF writer
		// has no WebP path at all — so we TRANSCODE to PNG rather than ship a part a
		// reader might refuse. The pixels are preserved exactly (PNG is lossless).
		decoded, derr := webp.Decode(bytes.NewReader(raw))
		if derr != nil {
			return nil, fmt.Errorf("its WebP data could not be decoded")
		}
		var buf bytes.Buffer
		if eerr := png.Encode(&buf, decoded); eerr != nil {
			return nil, fmt.Errorf("its WebP data could not be converted")
		}
		img.Data = buf.Bytes()
		img.Ext, img.Mime = "png", "image/png"
	default:
		return nil, fmt.Errorf("its format (%s) cannot be embedded", format)
	}

	img.RenderWPx, img.RenderHPx = renderSize(img, attrString(n.Attrs, "width"))
	return img, nil
}

// renderSize honours an explicit px width attribute, else uses the intrinsic size,
// and always scales down to fit the page. Aspect ratio is preserved from the REAL
// decoded dimensions (the browser exporter has to guess 4:3 here — the server does
// not have to).
func renderSize(img *Image, widthAttr string) (int, int) {
	w := img.WidthPx
	if m := pxRe.FindStringSubmatch(strings.TrimSpace(widthAttr)); m != nil {
		if n := atoiSafe(m[1]); n > 0 {
			w = n
		}
	}
	if w > contentWidthPx {
		w = contentWidthPx
	}
	if w <= 0 {
		w = 1
	}
	h := int(float64(w) * float64(img.HeightPx) / float64(img.WidthPx))
	if h <= 0 {
		h = 1
	}
	return w, h
}

// decodedImage decodes the (already validated) bytes into a Go image — used by the
// PDF writer, which needs raw pixels rather than a container.
func (i *Image) decoded() (image.Image, error) {
	switch i.Ext {
	case "png":
		return png.Decode(bytes.NewReader(i.Data))
	case "jpeg":
		return jpeg.Decode(bytes.NewReader(i.Data))
	case "gif":
		return gif.Decode(bytes.NewReader(i.Data))
	}
	return nil, fmt.Errorf("unsupported image format %q", i.Ext)
}

// ─── small helpers ──────────────────────────────────────────────────────────

type headingRef struct {
	level int
	text  string
}

func headingOutline(doc *DocJSON) []headingRef {
	var out []headingRef
	var walk func(n Node)
	walk = func(n Node) {
		if n.Type == "heading" {
			out = append(out, headingRef{level: attrInt(n.Attrs, "level", 1), text: extractText(n.Content)})
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	for _, n := range doc.Content {
		walk(n)
	}
	return out
}

func attrString(attrs map[string]any, key string) string {
	if attrs == nil {
		return ""
	}
	if v, ok := attrs[key].(string); ok {
		return v
	}
	return ""
}

func attrInt(attrs map[string]any, key string, dflt int) int {
	if attrs == nil {
		return dflt
	}
	switch v := attrs[key].(type) {
	case float64:
		if v > 0 && v < 1000 {
			return int(v)
		}
	case int:
		if v > 0 && v < 1000 {
			return v
		}
	}
	return dflt
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
		if n > 100000 {
			return 100000
		}
	}
	return n
}

func hostOf(rawurl string) string {
	s := rawurl
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}
