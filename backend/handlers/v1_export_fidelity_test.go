package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The /v1 developer API is the surface every integration uses, and all three of its
// exporters used to lose content SILENTLY — 200, no warning, data gone. These tests
// exercise the API end to end (not the services in isolation) and assert on the REAL
// RESPONSE: the bytes of the file, and the fidelity headers that must accompany them.

// ─── helpers ────────────────────────────────────────────────────────────────

func zipParts(t *testing.T, body []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("response body is not a ZIP package: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = string(b)
	}
	return out
}

func smallPNGDataURI(t *testing.T) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 12, 6))
	for y := 0; y < 6; y++ {
		for x := 0; x < 12; x++ {
			img.Set(x, y, color.RGBA{R: 10, G: uint8(x * 20), B: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

// warningsOf reads the fidelity headers back the way an API client would.
func warningsOf(t *testing.T, h http.Header) (fidelity string, warnings []string) {
	t.Helper()
	fidelity = h.Get("X-Export-Fidelity")
	if raw := h.Get("X-Export-Warnings"); raw != "" {
		if strings.ContainsAny(raw, "\r\n") {
			t.Fatalf("the warnings header contains CR/LF — a document could split the response: %q", raw)
		}
		if err := json.Unmarshal([]byte(raw), &warnings); err != nil {
			t.Fatalf("X-Export-Warnings is not valid JSON (%v): %q", err, raw)
		}
	}
	return fidelity, warnings
}

func containsWarning(warnings []string, substr string) bool {
	for _, w := range warnings {
		if strings.Contains(strings.ToLower(w), strings.ToLower(substr)) {
			return true
		}
	}
	return false
}

// ─── sheet → xlsx: charts must reach the API's bytes ────────────────────────

func TestV1_ExportSheetXLSX_CarriesCharts(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "sheet", []map[string]any{{
		"name": "Sheet1",
		"celldata": []map[string]any{
			{"r": 0, "c": 0, "v": map[string]any{"v": "Month", "m": "Month"}},
			{"r": 0, "c": 1, "v": map[string]any{"v": "Revenue", "m": "Revenue"}},
			{"r": 1, "c": 0, "v": map[string]any{"v": "Jan", "m": "Jan"}},
			{"r": 1, "c": 1, "v": map[string]any{"v": 120.0, "m": "120"}},
			{"r": 2, "c": 0, "v": map[string]any{"v": "Feb", "m": "Feb"}},
			{"r": 2, "c": 1, "v": map[string]any{"v": 150.0, "m": "150"}},
		},
		"charts": []map[string]any{
			{"id": "c1", "type": "column", "range": "A1:B3", "title": "Revenue", "x": 300, "y": 20, "w": 480, "h": 300},
		},
	}})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "xlsx"})
	if w.Code != http.StatusOK {
		t.Fatalf("export xlsx: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	parts := zipParts(t, w.Body.Bytes())
	if _, ok := parts["xl/charts/chart1.xml"]; !ok {
		t.Fatalf("the /v1 xlsx export contains NO chart part — the chart was silently dropped.\nparts: %v", partList(parts))
	}
	if !strings.Contains(parts["xl/charts/chart1.xml"], "$B$2:$B$3") {
		t.Error("the chart's series is not linked to the sheet's cells")
	}

	// Nothing was lost, so the API must claim full fidelity.
	fid, warns := warningsOf(t, w.Header())
	if fid != "full" {
		t.Errorf("X-Export-Fidelity = %q, want \"full\" (warnings: %v)", fid, warns)
	}
}

// A chart the exporter cannot embed must make the API SAY SO.
func TestV1_ExportSheetXLSX_UnsupportedChartIsReportedInHeaders(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "sheet", []map[string]any{{
		"name":     "Sheet1",
		"celldata": []map[string]any{{"r": 0, "c": 0, "v": map[string]any{"v": 1.0, "m": "1"}}},
		"charts": []map[string]any{
			{"id": "c9", "type": "sunburst", "range": "A1:B3", "title": "Exotic"},
		},
	}})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "xlsx"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	fid, warns := warningsOf(t, w.Header())
	if fid != "degraded" {
		t.Fatalf("a dropped chart returned X-Export-Fidelity=%q — the API lied about the file it sent", fid)
	}
	if !containsWarning(warns, "chart") {
		t.Errorf("the warnings do not mention the lost chart: %v", warns)
	}
}

// ─── doc → docx: tables and images must reach the API's bytes ───────────────

func TestV1_ExportDocDOCX_CarriesTablesAndImages(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", map[string]any{
		"type": "doc",
		"content": []any{
			map[string]any{"type": "paragraph", "content": []any{
				map[string]any{"type": "text", "text": "Intro"},
			}},
			map[string]any{"type": "image", "attrs": map[string]any{"src": smallPNGDataURI(t), "alt": "Logo"}},
			map[string]any{"type": "table", "content": []any{
				map[string]any{"type": "tableRow", "content": []any{
					map[string]any{"type": "tableCell", "content": []any{
						map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "A1"}}},
					}},
					map[string]any{"type": "tableCell", "content": []any{
						map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "B1"}}},
					}},
				}},
			}},
		},
	})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "docx"})
	if w.Code != http.StatusOK {
		t.Fatalf("export docx: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	parts := zipParts(t, w.Body.Bytes())
	if _, ok := parts["word/media/image1.png"]; !ok {
		t.Fatalf("the /v1 docx export has NO image part — the image was silently dropped.\nparts: %v", partList(parts))
	}
	doc := parts["word/document.xml"]
	if !strings.Contains(doc, "<w:tbl>") {
		t.Fatal("the /v1 docx export has NO table — the table was shredded into paragraphs")
	}
	if !strings.Contains(doc, "<w:drawing>") {
		t.Error("nothing in the document references the embedded image")
	}
	if got := strings.Count(doc, "<w:tc>"); got != 2 {
		t.Errorf("table has %d cells, want 2", got)
	}

	fid, warns := warningsOf(t, w.Header())
	if fid != "full" {
		t.Errorf("X-Export-Fidelity = %q, want \"full\" (warnings: %v)", fid, warns)
	}
}

// A remote image cannot be embedded (the server must not fetch a URL a document
// tells it to), so the API must report the loss.
func TestV1_ExportDocDOCX_RemoteImageIsReportedInHeaders(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "doc", map[string]any{
		"type": "doc",
		"content": []any{
			map[string]any{"type": "image", "attrs": map[string]any{"src": "https://cdn.example.com/x.png", "alt": "X"}},
		},
	})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "docx"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	parts := zipParts(t, w.Body.Bytes())
	for name := range parts {
		if strings.HasPrefix(name, "word/media/") {
			t.Fatalf("the server fetched a remote image (%s) — SSRF", name)
		}
	}
	fid, warns := warningsOf(t, w.Header())
	if fid != "degraded" {
		t.Fatalf("a dropped image returned X-Export-Fidelity=%q — the API lied about the file it sent", fid)
	}
	if !containsWarning(warns, "remote image") {
		t.Errorf("the warnings do not explain the loss: %v", warns)
	}
}

// ─── slide → pptx: positioned objects must reach the API's bytes ────────────

func TestV1_ExportSlidePPTX_CarriesPositionedObjects(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "slide", map[string]any{
		"title": "Deck",
		"slides": []map[string]any{{
			"background": "#101020",
			"objects": []map[string]any{
				{"id": "t1", "type": "text", "x": 0.1, "y": 0.1, "w": 0.8, "h": 0.2, "z": 1, "html": "<h2>Agenda</h2>"},
				{"id": "s1", "type": "shape", "x": 0.2, "y": 0.5, "w": 0.2, "h": 0.2, "z": 2, "shape": "oval", "fill": "#ff8800"},
				{"id": "i1", "type": "image", "x": 0.6, "y": 0.5, "w": 0.3, "h": 0.3, "z": 3, "src": smallPNGDataURI(t)},
			},
		}},
	})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "pptx"})
	if w.Code != http.StatusOK {
		t.Fatalf("export pptx: expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	parts := zipParts(t, w.Body.Bytes())
	slide := parts["ppt/slides/slide1.xml"]
	if !strings.Contains(slide, "Agenda") {
		t.Error("the text object is missing from the exported deck")
	}
	if !strings.Contains(slide, `<a:prstGeom prst="ellipse">`) {
		t.Error("the shape object is missing from the exported deck")
	}
	if !strings.Contains(slide, "<p:pic>") {
		t.Fatalf("the image object is missing from the exported deck:\n%s", slide)
	}
	if _, ok := parts["ppt/media/image1_1.png"]; !ok {
		t.Fatalf("no image part in the package — the image was silently dropped.\nparts: %v", partList(parts))
	}

	fid, warns := warningsOf(t, w.Header())
	if fid != "full" {
		t.Errorf("X-Export-Fidelity = %q, want \"full\" (warnings: %v)", fid, warns)
	}
}

// The slide PDF renderer cannot draw images/shapes — so it must say so.
func TestV1_ExportSlidePDF_ReportsUndrawableObjects(t *testing.T) {
	h, _ := newV1Handler()
	id := createV1DocAs(t, h, "alice", "slide", map[string]any{
		"title": "Deck",
		"slides": []map[string]any{{
			"objects": []map[string]any{
				{"id": "i1", "type": "image", "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3, "src": smallPNGDataURI(t)},
			},
		}},
	})

	alice := v1Router(h, "alice", false)
	w := doReq(alice, http.MethodPost, "/v1/documents/"+id+"/export", map[string]string{"format": "pdf"})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	fid, warns := warningsOf(t, w.Header())
	if fid != "degraded" {
		t.Fatalf("the PDF dropped an image but reported X-Export-Fidelity=%q", fid)
	}
	if !containsWarning(warns, "image") {
		t.Errorf("the warnings do not mention the undrawn image: %v", warns)
	}
}

func partList(parts map[string]string) []string {
	out := make([]string, 0, len(parts))
	for n := range parts {
		out = append(out, n)
	}
	return out
}
