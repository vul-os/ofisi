package slides_export

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"
)

// These tests assert on the REAL EXPORTED BYTES: the .pptx is unzipped and its
// PresentationML parts are read.
//
// The bug they pin: buildSlide() read only Title + Content, so every positioned
// object — every image, shape and text box, which is what a slide actually IS —
// was missing from the server's .pptx, returned as a 200 with no warning.

// ─── fixtures ───────────────────────────────────────────────────────────────

func pngURI(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 255), G: 40, B: uint8(y % 255), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func pptxParts(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("pptx is not a valid ZIP: %v", err)
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

func exportDeck(t *testing.T, deck Deck) (map[string]string, *Report) {
	t.Helper()
	b, rep, err := GeneratePPTX(deck)
	if err != nil {
		t.Fatalf("GeneratePPTX: %v", err)
	}
	if rep == nil {
		t.Fatal("GeneratePPTX returned a nil report — a caller could never learn what was lost")
	}
	return pptxParts(t, b), rep
}

// ─── THE BUG: positioned objects must reach the exported bytes ──────────────

func TestPPTX_ExportsPositionedObjects(t *testing.T) {
	deck := Deck{Title: "Deck", Slides: []Slide{{
		Background: "#1a1a2e",
		Objects: []SlideObject{
			{ID: "t1", Type: "text", X: 0.1, Y: 0.1, W: 0.8, H: 0.2, Z: 1, HTML: "<h2>Quarterly review</h2>"},
			{ID: "s1", Type: "shape", X: 0.5, Y: 0.5, W: 0.25, H: 0.25, Z: 2, Shape: "oval", Fill: "#ff0000", Stroke: "#00ff00", StrokeWidth: 3},
			{ID: "i1", Type: "image", X: 0.05, Y: 0.5, W: 0.3, H: 0.3, Z: 3, Src: pngURI(t, 20, 10)},
		},
	}}}
	parts, rep := exportDeck(t, deck)
	slide := parts["ppt/slides/slide1.xml"]

	// TEXT
	if !strings.Contains(slide, "Quarterly review") {
		t.Errorf("the text object's words are missing from slide1.xml")
	}
	// It must be a real text box AT ITS OWN POSITION (0.1 × 12192000 = 1219200 EMU).
	if !strings.Contains(slide, `<a:off x="1219200" y="685800"/>`) {
		t.Errorf("the text object is not at its own position:\n%s", clip(slide))
	}

	// SHAPE — a real preset geometry with its own fill and stroke.
	if !strings.Contains(slide, `<a:prstGeom prst="ellipse">`) {
		t.Errorf("the shape object did not become an ellipse preset:\n%s", clip(slide))
	}
	if !strings.Contains(slide, `<a:srgbClr val="FF0000">`) {
		t.Error("the shape's fill colour was lost")
	}
	if !strings.Contains(slide, `<a:ln w="38100">`) { // 3pt × 12700 EMU
		t.Error("the shape's stroke width was lost")
	}

	// IMAGE — a real picture with real bytes in the package.
	if !strings.Contains(slide, "<p:pic>") {
		t.Fatalf("the image object did not become a <p:pic>:\n%s", clip(slide))
	}
	media, ok := parts["ppt/media/image1_1.png"]
	if !ok {
		t.Fatalf("ppt/media/image1_1.png is MISSING — the image was dropped.\nparts: %v", names(parts))
	}
	if !strings.HasPrefix(media, "\x89PNG") {
		t.Error("the media part is not real PNG bytes")
	}
	if !strings.Contains(slide, `r:embed="rId2"`) {
		t.Error("the picture does not reference an image relationship")
	}
	if !strings.Contains(parts["ppt/slides/_rels/slide1.xml.rels"], "../media/image1_1.png") {
		t.Error("the slide's rels do not point at the media part — PowerPoint shows a broken image")
	}
	if !strings.Contains(parts["[Content_Types].xml"], `Default Extension="png"`) {
		t.Error("[Content_Types].xml does not declare the png extension — PowerPoint refuses the package")
	}

	if rep.ObjectsEmbedded != 3 || rep.ImagesEmbedded != 1 {
		t.Errorf("report says %d objects / %d images, want 3 / 1", rep.ObjectsEmbedded, rep.ImagesEmbedded)
	}
	if rep.Degraded() {
		t.Errorf("a fully-carried deck must not warn: %v", rep.Warnings)
	}
}

// Rotation and stacking order are part of the object model, so they must survive.
func TestPPTX_RotationAndZOrder(t *testing.T) {
	deck := Deck{Slides: []Slide{{
		Objects: []SlideObject{
			{ID: "front", Type: "text", X: 0.1, Y: 0.1, W: 0.3, H: 0.1, Z: 9, HTML: "<p>FRONT</p>"},
			{ID: "back", Type: "shape", X: 0.1, Y: 0.1, W: 0.3, H: 0.1, Z: 1, Shape: "rect", Rotation: 45},
		},
	}}}
	parts, _ := exportDeck(t, deck)
	slide := parts["ppt/slides/slide1.xml"]

	if !strings.Contains(slide, `rot="2700000"`) { // 45° × 60000
		t.Errorf("rotation was lost:\n%s", clip(slide))
	}
	// PPTX has no z-index: paint order IS stacking order, so the z=1 shape must be
	// written BEFORE the z=9 text, or the text ends up hidden behind it.
	shapeAt := strings.Index(slide, "<p:sp>\n        <p:nvSpPr><p:cNvPr id=\"2\" name=\"Shape")
	textAt := strings.Index(slide, "FRONT")
	if shapeAt < 0 || textAt < 0 || shapeAt > textAt {
		t.Errorf("objects are not painted in z order (shape@%d, text@%d)", shapeAt, textAt)
	}
}

// A legacy slide (no objects[]) still exports — its title/content are migrated into
// positioned text boxes, exactly as the editor migrates them.
func TestPPTX_LegacySlideStillExports(t *testing.T) {
	deck := Deck{Slides: []Slide{{Title: "Old slide", Content: "<p>Body copy</p>"}}}
	parts, rep := exportDeck(t, deck)
	slide := parts["ppt/slides/slide1.xml"]
	if !strings.Contains(slide, "Old slide") || !strings.Contains(slide, "Body copy") {
		t.Fatalf("a legacy title/content slide lost its text:\n%s", clip(slide))
	}
	if rep.ObjectsEmbedded != 2 {
		t.Errorf("legacy migration produced %d objects, want 2 (title + body)", rep.ObjectsEmbedded)
	}
}

// ─── Honest degradation ─────────────────────────────────────────────────────

func TestPPTX_RemoteImageIsNotFetchedButIsReported(t *testing.T) {
	deck := Deck{Slides: []Slide{{
		Objects: []SlideObject{
			{ID: "i1", Type: "image", X: 0.1, Y: 0.1, W: 0.3, H: 0.3, Src: "https://cdn.example.com/logo.png"},
		},
	}}}
	parts, rep := exportDeck(t, deck)

	for name := range parts {
		if strings.HasPrefix(name, "ppt/media/") {
			t.Fatalf("the server FETCHED a remote image (%s) — that is an SSRF vector", name)
		}
	}
	if !rep.Degraded() {
		t.Fatal("a dropped remote image produced NO warning — silent data loss")
	}
	if len(rep.ObjectsSkipped) != 1 || rep.ObjectsSkipped[0].ID != "i1" {
		t.Errorf("the skipped object was not reported: %+v", rep.ObjectsSkipped)
	}
	if !hasWarning(rep, "remote image") {
		t.Errorf("the warning does not explain the loss: %v", rep.Warnings)
	}
}

func TestPPTX_SpeakerNotesLossIsReported(t *testing.T) {
	deck := Deck{Slides: []Slide{{Title: "S", Notes: "Remember to mention the roadmap"}}}
	_, rep := exportDeck(t, deck)
	if !hasWarning(rep, "notes") {
		t.Fatalf("speaker notes were dropped with no warning: %v", rep.Warnings)
	}
}

// A shape that never set an opacity must not export INVISIBLE — the JSON zero value
// for a missing key would otherwise mean "fully transparent".
func TestPPTX_MissingOpacityIsOpaqueNotInvisible(t *testing.T) {
	deck := Deck{Slides: []Slide{{Objects: []SlideObject{
		{ID: "s", Type: "shape", X: 0.1, Y: 0.1, W: 0.2, H: 0.2, Shape: "rect", Fill: "#123456"},
	}}}}
	parts, _ := exportDeck(t, deck)
	slide := parts["ppt/slides/slide1.xml"]
	if strings.Contains(slide, "<a:alpha val=\"0\"/>") {
		t.Error("a shape with no opacity key exported fully transparent")
	}
	if !strings.Contains(slide, `<a:srgbClr val="123456">`) {
		t.Errorf("the shape's fill is missing:\n%s", clip(slide))
	}
}

// A hostile/corrupt object must never be able to inject XML or produce a NaN extent
// (which is one of the few ways to make PowerPoint reject the whole package).
func TestPPTX_HostileObjectCannotInjectXMLOrBreakGeometry(t *testing.T) {
	deck := Deck{Slides: []Slide{{Objects: []SlideObject{
		{ID: "x", Type: "text", X: 1e30, Y: -1e30, W: 0, H: 0, Z: 1,
			HTML: `<p></a:t></a:r><p:evil/></p>`},
		{ID: "c", Type: "shape", X: 0.2, Y: 0.2, W: 0.2, H: 0.2, Shape: "rect",
			Fill: "url(javascript:alert(1))"},
	}}}}
	parts, _ := exportDeck(t, deck)
	slide := parts["ppt/slides/slide1.xml"]

	if strings.Contains(slide, "<p:evil/>") {
		t.Fatal("user content closed a tag and injected an element into the slide XML")
	}
	if strings.Contains(slide, "NaN") || strings.Contains(slide, "e+") {
		t.Fatalf("a non-finite extent reached the markup:\n%s", clip(slide))
	}
	// The hostile colour must fail closed to the default, not reach the markup.
	if strings.Contains(slide, "javascript") {
		t.Fatal("a hostile colour value reached the slide XML")
	}
	if !strings.Contains(slide, `<a:srgbClr val="7C6AF7">`) {
		t.Errorf("the shape fill did not fail closed to the default:\n%s", clip(slide))
	}
}

// ─── The slide PDF path derives from the same model — and says what it can't do ──

func TestRenderPDF_ReportsObjectsItCannotDraw(t *testing.T) {
	deck := Deck{Slides: []Slide{{
		Title: "S", Content: "<p>text</p>",
		Objects: []SlideObject{
			{ID: "t", Type: "text", X: 0.1, Y: 0.1, W: 0.5, H: 0.2, HTML: "<p>text</p>"},
			{ID: "i", Type: "image", X: 0.1, Y: 0.5, W: 0.3, H: 0.3, Src: pngURI(t, 8, 8)},
			{ID: "s", Type: "shape", X: 0.6, Y: 0.5, W: 0.2, H: 0.2, Shape: "rect"},
		},
	}}}
	data, rep, err := RenderPDF(deck)
	if err != nil {
		t.Fatalf("RenderPDF: %v", err)
	}
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		t.Fatal("not a PDF")
	}
	if !hasWarning(rep, "image") || !hasWarning(rep, "shape") {
		t.Fatalf("the PDF path drops images and shapes but reported neither: %v", rep.Warnings)
	}
}

// ─── Warnings must be safe to put on an HTTP response header ────────────────

func TestPPTX_WarningsAreHeaderSafe(t *testing.T) {
	deck := Deck{Slides: []Slide{{
		Notes: "notes\r\nX-Injected: yes",
		Objects: []SlideObject{
			{ID: "i", Type: "image", X: 0.1, Y: 0.1, W: 0.2, H: 0.2, Src: "https://evil.example/\r\nX-Injected: yes"},
		},
	}}}
	_, rep := exportDeck(t, deck)
	if len(rep.Warnings) == 0 {
		t.Fatal("expected warnings")
	}
	for _, w := range rep.Warnings {
		if strings.ContainsAny(w, "\r\n") {
			t.Errorf("warning contains CR/LF — it could split an HTTP response header: %q", w)
		}
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
