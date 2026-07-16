package docs_export

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"
)

// These tests assert on the REAL EXPORTED BYTES: the .docx is unzipped and its
// OOXML parts are read; the PDF is scanned for the actual image/graphics operators.
//
// The bug they pin: extractNode() had no `image` case and no `table` case, so the
// server's DOCX and PDF contained NO images at all (an image node is atomic — the
// default branch recursed into its empty Content and produced nothing) and every
// table was shredded into loose top-level paragraphs.

// ─── fixtures ───────────────────────────────────────────────────────────────

// pngDataURI builds a real w×h PNG as a data: URI — real bytes, so the exporters
// must genuinely decode and re-encode them.
func pngDataURI(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 7 % 255), G: uint8(y * 5 % 255), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func docFrom(t *testing.T, content ...map[string]any) *DocJSON {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"type": "doc", "content": content})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := ParseDocJSON(raw)
	if err != nil {
		t.Fatalf("ParseDocJSON: %v", err)
	}
	return doc
}

func textNode(s string) map[string]any {
	return map[string]any{"type": "text", "text": s}
}

func paragraphNode(s string) map[string]any {
	return map[string]any{"type": "paragraph", "content": []any{textNode(s)}}
}

// tableNode builds a rows×cols TipTap table whose cells read "r<i>c<j>".
func tableNode(rows, cols int, header bool) map[string]any {
	var trs []any
	for r := 0; r < rows; r++ {
		var tcs []any
		for c := 0; c < cols; c++ {
			kind := "tableCell"
			if header && r == 0 {
				kind = "tableHeader"
			}
			tcs = append(tcs, map[string]any{
				"type":    kind,
				"attrs":   map[string]any{"colspan": 1, "rowspan": 1},
				"content": []any{paragraphNode(cellName(r, c))},
			})
		}
		trs = append(trs, map[string]any{"type": "tableRow", "content": tcs})
	}
	return map[string]any{"type": "table", "content": trs}
}

func cellName(r, c int) string { return "r" + itoa(r) + "c" + itoa(c) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func docxParts(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("docx is not a valid ZIP: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = string(data)
	}
	return out
}

func exportDocx(t *testing.T, doc *DocJSON) (map[string]string, *Report) {
	t.Helper()
	blocks, rep := ExtractBlocks(doc)
	b, err := GenerateDOCX("Doc", blocks)
	if err != nil {
		t.Fatalf("GenerateDOCX: %v", err)
	}
	return docxParts(t, b), rep
}

// ─── BUG 2a: images must reach the DOCX ─────────────────────────────────────

func TestDOCX_EmbedsRealImage(t *testing.T) {
	doc := docFrom(t,
		paragraphNode("Before"),
		map[string]any{"type": "image", "attrs": map[string]any{
			"src": pngDataURI(t, 40, 20), "alt": "A chart", "width": "200px",
		}},
		paragraphNode("After"),
	)
	parts, rep := exportDocx(t, doc)

	media, ok := parts["word/media/image1.png"]
	if !ok {
		t.Fatalf("word/media/image1.png is MISSING — the image was dropped from the .docx.\nparts: %v", names(parts))
	}
	if !strings.HasPrefix(media, "\x89PNG") {
		t.Errorf("the media part is not real PNG bytes (got %q…)", media[:min(8, len(media))])
	}
	docXML := parts["word/document.xml"]
	if !strings.Contains(docXML, "<w:drawing>") || !strings.Contains(docXML, "<pic:pic>") {
		t.Error("document.xml has no <w:drawing>/<pic:pic> — nothing references the image")
	}
	if !strings.Contains(docXML, `r:embed="rId2"`) {
		t.Errorf("the drawing does not reference the image relationship:\n%s", clip(docXML))
	}
	if !strings.Contains(parts["word/_rels/document.xml.rels"], "media/image1.png") {
		t.Error("no relationship points at the media part — Word would show a broken image")
	}
	if !strings.Contains(parts["[Content_Types].xml"], `Extension="png"`) {
		t.Error("[Content_Types].xml does not declare the png extension — Word refuses the package")
	}
	// The explicit 200px width is honoured, and the aspect ratio comes from the REAL
	// decoded size (40×20 → 2:1), so 200px wide ⇒ 100px tall ⇒ 1905000×952500 EMU.
	if !strings.Contains(docXML, `cx="1905000"`) || !strings.Contains(docXML, `cy="952500"`) {
		t.Errorf("image extent is not the requested 200px at the true 2:1 aspect:\n%s", clip(docXML))
	}
	if !strings.Contains(docXML, "A chart") {
		t.Error("the alt text was not carried into the drawing (accessibility loss)")
	}
	if rep.ImagesEmbedded != 1 {
		t.Errorf("report says %d images embedded, want 1", rep.ImagesEmbedded)
	}
	if rep.Degraded() {
		t.Errorf("a fully-carried export must not warn: %v", rep.Warnings)
	}
}

// ─── BUG 2b: tables must survive as tables ──────────────────────────────────

func TestDOCX_EmbedsRealTable(t *testing.T) {
	doc := docFrom(t, tableNode(3, 4, true))
	parts, rep := exportDocx(t, doc)
	docXML := parts["word/document.xml"]

	if !strings.Contains(docXML, "<w:tbl>") {
		t.Fatalf("document.xml has NO <w:tbl> — the 3×4 table was shredded into loose paragraphs:\n%s", clip(docXML))
	}
	if got := strings.Count(docXML, "<w:tr>"); got != 3 {
		t.Errorf("got %d <w:tr> rows, want 3", got)
	}
	if got := strings.Count(docXML, "<w:tc>"); got != 12 {
		t.Errorf("got %d <w:tc> cells, want 12", got)
	}
	if got := strings.Count(docXML, "<w:gridCol"); got != 4 {
		t.Errorf("tblGrid declares %d columns, want 4", got)
	}
	// Every cell's text must still be there, in its cell.
	for r := 0; r < 3; r++ {
		for c := 0; c < 4; c++ {
			if !strings.Contains(docXML, cellName(r, c)) {
				t.Errorf("cell %s is missing from the table", cellName(r, c))
			}
		}
	}
	// Word requires a paragraph after a table, or it declares the file corrupt.
	if !strings.Contains(docXML, "</w:tbl>\n    <w:p/>") {
		t.Error("no paragraph follows the table — Word would 'repair' this document")
	}
	if rep.TablesEmbedded != 1 {
		t.Errorf("report says %d tables embedded, want 1", rep.TablesEmbedded)
	}
}

func TestDOCX_TableColspanBecomesGridSpan(t *testing.T) {
	doc := docFrom(t, map[string]any{"type": "table", "content": []any{
		map[string]any{"type": "tableRow", "content": []any{
			map[string]any{"type": "tableCell", "attrs": map[string]any{"colspan": 2},
				"content": []any{paragraphNode("wide")}},
			map[string]any{"type": "tableCell", "content": []any{paragraphNode("narrow")}},
		}},
	}})
	parts, _ := exportDocx(t, doc)
	docXML := parts["word/document.xml"]
	if !strings.Contains(docXML, `<w:gridSpan w:val="2"/>`) {
		t.Errorf("colspan=2 did not become a gridSpan:\n%s", clip(docXML))
	}
	if got := strings.Count(docXML, "<w:gridCol"); got != 3 {
		t.Errorf("tblGrid declares %d columns, want 3 (2 spanned + 1)", got)
	}
}

// An image INSIDE a table cell must be embedded too — the cell is a document, not
// a string.
func TestDOCX_ImageInsideTableCellIsEmbedded(t *testing.T) {
	doc := docFrom(t, map[string]any{"type": "table", "content": []any{
		map[string]any{"type": "tableRow", "content": []any{
			map[string]any{"type": "tableCell", "content": []any{
				map[string]any{"type": "image", "attrs": map[string]any{"src": pngDataURI(t, 10, 10)}},
			}},
		}},
	}})
	parts, rep := exportDocx(t, doc)
	if _, ok := parts["word/media/image1.png"]; !ok {
		t.Fatal("an image inside a table cell was dropped")
	}
	if !strings.Contains(parts["word/document.xml"], "<w:tbl>") {
		t.Error("the table itself was lost")
	}
	if rep.ImagesEmbedded != 1 {
		t.Errorf("report says %d images embedded, want 1", rep.ImagesEmbedded)
	}
}

// ─── Honest degradation: what CANNOT be carried must be reported ────────────

func TestDOCX_RemoteImageIsNotFetchedButIsReported(t *testing.T) {
	doc := docFrom(t, map[string]any{"type": "image", "attrs": map[string]any{
		"src": "https://images.example.com/cat.png", "alt": "Cat",
	}})
	parts, rep := exportDocx(t, doc)

	// SSRF: the exporter must not fetch a URL a document tells it to.
	for name := range parts {
		if strings.HasPrefix(name, "word/media/") {
			t.Fatalf("the server FETCHED a remote image (%s) — that is an SSRF vector", name)
		}
	}
	if !rep.Degraded() {
		t.Fatal("a remote image was dropped with NO warning — silent data loss")
	}
	if !hasWarning(rep, "remote image") {
		t.Errorf("the warning does not explain the loss: %v", rep.Warnings)
	}
	// The alt text is the only trace left of it, and it is kept.
	if !strings.Contains(parts["word/document.xml"], "Cat") {
		t.Error("not even the alt text survived")
	}
}

func TestDOCX_SvgDataURIIsRefused(t *testing.T) {
	svg := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))
	doc := docFrom(t, map[string]any{"type": "image", "attrs": map[string]any{"src": svg}})
	parts, rep := exportDocx(t, doc)

	for name, body := range parts {
		if strings.HasPrefix(name, "word/media/") {
			t.Fatalf("an SVG (a script carrier) was embedded as %s", name)
		}
		if strings.Contains(body, "alert(1)") {
			t.Fatalf("SVG script content reached %s", name)
		}
	}
	if !rep.Degraded() {
		t.Error("the refused SVG produced no warning")
	}
}

// A control character would make Word declare the .docx corrupt. Nothing upstream
// strips them, so the writer must.
func TestDOCX_StripsXMLIllegalControlChars(t *testing.T) {
	doc := docFrom(t, paragraphNode("before\x0Bafter\x00end"))
	parts, _ := exportDocx(t, doc)
	docXML := parts["word/document.xml"]
	if strings.ContainsAny(docXML, "\x0B\x00") {
		t.Error("document.xml carries an XML-1.0-illegal control char — Word would refuse the file")
	}
	if !strings.Contains(docXML, "beforeafterend") {
		t.Errorf("the surrounding text was mangled:\n%s", clip(docXML))
	}
}

// ─── The PDF path derives from the same blocks ──────────────────────────────

func TestPDF_EmbedsRealImageXObject(t *testing.T) {
	doc := docFrom(t,
		paragraphNode("Report"),
		map[string]any{"type": "image", "attrs": map[string]any{"src": pngDataURI(t, 60, 30)}},
	)
	blocks, rep := ExtractBlocks(doc)
	pdf, _, err := GeneratePDFReport("Doc", blocks, rep)
	if err != nil {
		t.Fatalf("GeneratePDFReport: %v", err)
	}
	s := string(pdf)
	if !strings.Contains(s, "/Subtype /Image") {
		t.Fatal("the PDF contains NO image XObject — the image vanished")
	}
	for _, want := range []string{"/Filter /FlateDecode", "/ColorSpace /DeviceRGB", "/XObject <<", "/Im1 Do"} {
		if !strings.Contains(s, want) {
			t.Errorf("PDF is missing %q — the image is not drawn on the page", want)
		}
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Error("not a PDF")
	}
}

func TestPDF_DrawsTableGrid(t *testing.T) {
	doc := docFrom(t, tableNode(3, 4, true))
	blocks, rep := ExtractBlocks(doc)
	pdf, _, err := GeneratePDFReport("Doc", blocks, rep)
	if err != nil {
		t.Fatalf("GeneratePDFReport: %v", err)
	}
	s := string(pdf)
	// A ruled grid: one stroked rectangle per cell (3×4 = 12).
	if got := strings.Count(s, " re S Q"); got != 12 {
		t.Errorf("PDF draws %d cell rectangles, want 12 — the table is not a grid", got)
	}
	for r := 0; r < 3; r++ {
		for c := 0; c < 4; c++ {
			if !strings.Contains(s, cellName(r, c)) {
				t.Errorf("cell text %s is missing from the PDF", cellName(r, c))
			}
		}
	}
}

// ─── The old flat path is still available, and still lossy — by name ────────

func TestExtractParagraphs_IsExplicitlyLossy(t *testing.T) {
	doc := docFrom(t, tableNode(2, 2, false))
	paras := ExtractParagraphs(doc)
	if len(paras) != 4 {
		t.Errorf("flattening a 2×2 table gave %d paragraphs, want 4", len(paras))
	}
	blocks, _ := ExtractBlocks(doc)
	if len(blocks) != 1 || blocks[0].Kind != BlockTable {
		t.Fatalf("ExtractBlocks must keep the table whole, got %d blocks", len(blocks))
	}
	if blocks[0].Table.Cols != 2 || len(blocks[0].Table.Rows) != 2 {
		t.Errorf("table shape lost: %d cols × %d rows", blocks[0].Table.Cols, len(blocks[0].Table.Rows))
	}
}

// ─── helpers ────────────────────────────────────────────────────────────────

func hasWarning(rep *Report, substr string) bool {
	for _, w := range rep.Warnings {
		if strings.Contains(strings.ToLower(w), strings.ToLower(substr)) {
			return true
		}
	}
	return false
}

func names(parts map[string]string) []string {
	out := make([]string, 0, len(parts))
	for n := range parts {
		out = append(out, n)
	}
	return out
}

func clip(s string) string {
	if len(s) > 1500 {
		return s[:1500] + "…"
	}
	return s
}
