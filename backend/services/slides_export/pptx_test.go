package slides_export

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"regexp"
	"strings"
	"testing"
)

func openPPTX(t *testing.T, deck Deck) map[string]string {
	t.Helper()
	data, _, err := GeneratePPTX(deck)
	if err != nil {
		t.Fatalf("GeneratePPTX: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("pptx is not a readable zip: %v", err)
	}
	parts := make(map[string]string, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		parts[f.Name] = string(b)
	}
	return parts
}

func sampleDeck() Deck {
	return Deck{
		Title: "Q3 Plan",
		Slides: []Slide{
			{Title: "Agenda", Content: "<p>Revenue</p><p>Roadmap</p>", Background: "#1a1a2e"},
			{Title: "Numbers", Content: "<p>Up and to the right</p>", Background: "#ffffff"},
		},
	}
}

// The /v1 developer API exports PPTX server-side: the package must actually be a
// valid PresentationML package, not a 501.
func TestGeneratePPTXWritesAValidPackage(t *testing.T) {
	parts := openPPTX(t, sampleDeck())

	required := []string{
		"[Content_Types].xml",
		"_rels/.rels",
		"ppt/presentation.xml",
		"ppt/_rels/presentation.xml.rels",
		"ppt/slideMasters/slideMaster1.xml",
		"ppt/slideMasters/_rels/slideMaster1.xml.rels",
		"ppt/slideLayouts/slideLayout1.xml",
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels",
		"ppt/theme/theme1.xml",
		"ppt/slides/slide1.xml",
		"ppt/slides/_rels/slide1.xml.rels",
		"ppt/slides/slide2.xml",
		"ppt/slides/_rels/slide2.xml.rels",
	}
	for _, name := range required {
		if _, ok := parts[name]; !ok {
			t.Errorf("missing part %s", name)
		}
	}

	// Every part must be well-formed XML.
	for name, body := range parts {
		dec := xml.NewDecoder(strings.NewReader(body))
		for {
			_, err := dec.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("%s: malformed XML: %v", name, err)
			}
		}
	}

	// Every part except the content-types stream and the .rels parts must be
	// declared in [Content_Types].xml (a consumer refuses the package otherwise).
	ct := parts["[Content_Types].xml"]
	for name := range parts {
		if name == "[Content_Types].xml" || strings.HasSuffix(name, ".rels") {
			continue
		}
		if !strings.Contains(ct, `PartName="/`+name+`"`) {
			t.Errorf("[Content_Types].xml does not declare %s", name)
		}
	}

	// Every relationship target must resolve to a part that exists.
	relRe := regexp.MustCompile(`Target="([^"]+)"`)
	for name, body := range parts {
		if !strings.HasSuffix(name, ".rels") {
			continue
		}
		dir := relDir(name)
		for _, m := range relRe.FindAllStringSubmatch(body, -1) {
			target := resolveRel(dir, m[1])
			if _, ok := parts[target]; !ok {
				t.Errorf("%s: relationship target %q resolves to %q, which is not in the package", name, m[1], target)
			}
		}
	}
}

// relDir returns the part directory a .rels file's targets are relative to:
// "ppt/slides/_rels/slide1.xml.rels" → "ppt/slides".
func relDir(relName string) string {
	dir := strings.TrimSuffix(relName, "/"+lastSegment(relName))
	return strings.TrimSuffix(strings.TrimSuffix(dir, "_rels"), "/")
}

func lastSegment(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// resolveRel joins a relationship target against its source directory,
// collapsing "../" segments. The package root has an empty dir.
func resolveRel(dir, target string) string {
	segs := []string{}
	if dir != "" {
		segs = strings.Split(dir, "/")
	}
	for _, s := range strings.Split(target, "/") {
		switch s {
		case ".", "":
		case "..":
			if len(segs) > 0 {
				segs = segs[:len(segs)-1]
			}
		default:
			segs = append(segs, s)
		}
	}
	return strings.Join(segs, "/")
}

// One slide in → one slide part + one sldId out, in deck order.
func TestGeneratePPTXOneSlidePartPerSlide(t *testing.T) {
	parts := openPPTX(t, sampleDeck())

	pres := parts["ppt/presentation.xml"]
	for _, want := range []string{`<p:sldId id="256" r:id="rId2"/>`, `<p:sldId id="257" r:id="rId3"/>`} {
		if !strings.Contains(pres, want) {
			t.Errorf("presentation.xml missing %s", want)
		}
	}
	if strings.Contains(pres, `r:id="rId4"`) {
		t.Errorf("presentation.xml lists a slide the deck does not have")
	}

	if !strings.Contains(parts["ppt/slides/slide1.xml"], "<a:t>Agenda</a:t>") {
		t.Errorf("slide1 is missing its title")
	}
	if !strings.Contains(parts["ppt/slides/slide1.xml"], "<a:t>Revenue</a:t>") {
		t.Errorf("slide1 is missing its HTML-stripped body text")
	}
	if !strings.Contains(parts["ppt/slides/slide2.xml"], "<a:t>Numbers</a:t>") {
		t.Errorf("slide2 is missing its title")
	}
}

// The slide background carries over, and the text colour flips to stay readable
// on it — the same contrast rule the PDF renderer uses.
func TestGeneratePPTXBackgroundAndContrast(t *testing.T) {
	parts := openPPTX(t, sampleDeck())

	dark := parts["ppt/slides/slide1.xml"]
	if !strings.Contains(dark, `<a:srgbClr val="1A1A2E"/>`) {
		t.Errorf("slide1 lost its background colour")
	}
	if !strings.Contains(dark, `<a:srgbClr val="F0F0FF"/>`) {
		t.Errorf("slide1 (dark background) should use light text")
	}

	light := parts["ppt/slides/slide2.xml"]
	if !strings.Contains(light, `<a:srgbClr val="14141E"/>`) {
		t.Errorf("slide2 (light background) should use dark text")
	}
}

// Slide text is user content: it must be escaped, never able to close a tag and
// inject XML into the package.
func TestGeneratePPTXEscapesUserContent(t *testing.T) {
	parts := openPPTX(t, Deck{
		Title: "x",
		Slides: []Slide{{
			Title:   `</a:t></a:r><a:r><a:t>injected`,
			Content: `Tom & Jerry <3`,
		}},
	})

	slide := parts["ppt/slides/slide1.xml"]
	if strings.Contains(slide, "<a:t>injected</a:t>") {
		t.Errorf("slide title escaped its text node:\n%s", slide)
	}
	if !strings.Contains(slide, "&lt;/a:t&gt;") {
		t.Errorf("slide title was not XML-escaped:\n%s", slide)
	}
	if !strings.Contains(slide, "Tom &amp; Jerry") {
		t.Errorf("slide body was not XML-escaped:\n%s", slide)
	}
}

func TestGeneratePPTXRejectsEmptyDeck(t *testing.T) {
	if _, _, err := GeneratePPTX(Deck{Title: "empty"}); err == nil {
		t.Fatal("GeneratePPTX(deck with no slides) = nil error, want an error")
	}
}
