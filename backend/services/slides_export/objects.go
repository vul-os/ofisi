// objects.go — the POSITIONED-OBJECT model of a slide, which the server export
// used to ignore entirely.
//
// THE BUG THIS FIXES. buildSlide() read only Title + Content, while the editor
// states plainly that `objects[]` is the source of truth for a slide's body (see
// src/apps/slides/slideObjects.js). The old pptx.go header even ACKNOWLEDGED that
// the browser "carries the editor's positioned objects" and the server "renders what
// the server model holds" — but the consequence went unsaid: `POST /v1/documents/:id/export`
// returned a deck with every image, shape and text box MISSING, as a 200, with no
// warning. Fixing the file header is not fixing the export.
//
// Now the server renders objects[] into real PresentationML shapes:
//
//	text  → <p:sp>  a text box at its real position/size/rotation
//	image → <p:pic> real bytes in ppt/media + a slide relationship
//	shape → <p:sp>  a preset geometry (rect/roundRect/ellipse/triangle/star5/…)
//
// COORDINATES. Objects are stored NORMALISED (x,y,w,h are fractions of the stage),
// which maps exactly onto PPTX's absolute EMU space — multiply by the slide size.
// That is the fidelity gain: PPTX is natively positioned, so nothing is approximated.
//
// TRUST BOUNDARY (mirrors the editor's own CRDT ingress discipline). A deck is
// untrusted input:
//   - geometry is clamped to finite, bounded values — a NaN/absurd extent is the one
//     way a slide part can make PowerPoint reject the whole package,
//   - object counts are bounded,
//   - only RASTER data: images are embedded; a REMOTE image is NOT fetched (the
//     exporter must not become an SSRF probe) — it is reported instead,
//   - every string is XML-escaped and control-stripped before it reaches the markup.
package slides_export

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"regexp"
	"strings"

	_ "image/gif"
	_ "image/jpeg"

	"golang.org/x/image/webp"
)

// Bounds — belt-and-braces against a hostile or corrupt deck (the same limits
// slideObjects.js enforces at the CRDT ingress).
const (
	maxObjectsPerSlide = 500
	minObjectSize      = 0.01
	maxImageBytes      = 5 << 20
	maxImagePixels     = 40 << 20
)

// SlideObject is one positioned object on a slide.
type SlideObject struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"` // text | image | shape
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	W        float64 `json:"w"`
	H        float64 `json:"h"`
	Rotation float64 `json:"rotation"`
	Z        int     `json:"z"`

	// text
	HTML   string `json:"html"`
	Align  string `json:"align"`
	VAlign string `json:"valign"`

	// image
	Src string `json:"src"`

	// shape
	Shape       string  `json:"shape"`
	Fill        string  `json:"fill"`
	Stroke      string  `json:"stroke"`
	StrokeWidth float64 `json:"strokeWidth"`
	Opacity     float64 `json:"opacity"`

	// hasOpacity distinguishes "opacity: 0" (fully transparent) from "absent"
	// (opaque). Without it, every object with no opacity key would export invisible.
	hasOpacity bool
}

// UnmarshalJSON records whether `opacity` was actually present. Go zero-values it
// to 0 otherwise, which would export every shape that never set an opacity as
// FULLY TRANSPARENT — a silent way to lose the whole slide body.
func (o *SlideObject) UnmarshalJSON(b []byte) error {
	type alias SlideObject // no methods → no recursion
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(b, &probe); err != nil {
		return err
	}
	*o = SlideObject(a)
	_, o.hasOpacity = probe["opacity"]
	return nil
}

// ─── Report ─────────────────────────────────────────────────────────────────

// SkippedObject records ONE object the exporter could not carry, and why.
type SkippedObject struct {
	ID     string `json:"id,omitempty"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// Report is the honest account of a deck export. A caller MUST surface the
// warnings: a deck that quietly loses its images is the bug this type prevents.
type Report struct {
	ObjectsEmbedded int             `json:"objects_embedded"`
	ImagesEmbedded  int             `json:"images_embedded"`
	ObjectsSkipped  []SkippedObject `json:"objects_skipped,omitempty"`
	Warnings        []string        `json:"warnings,omitempty"`
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
			return // one warning per distinct cause
		}
	}
	r.Warnings = append(r.Warnings, msg)
}

func (r *Report) skip(o SlideObject, reason string) {
	if r == nil {
		return
	}
	r.ObjectsSkipped = append(r.ObjectsSkipped, SkippedObject{ID: o.ID, Type: o.Type, Reason: reason})
	r.warn("A %s object was not included in the export: %s.", o.Type, reason)
}

// sanitizeWarning keeps a warning safe for an HTTP response header: one line, no
// control characters, bounded length.
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

// ─── Sanitise + clamp (port of slideObjects.js sanitizeObject) ──────────────

func clampFinite(v, lo, hi, dflt float64) float64 {
	if v != v { // NaN
		return dflt
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

var objectTypes = map[string]bool{"text": true, "image": true, "shape": true}

// shapePreset maps our shape kinds onto DrawingML preset geometries — the same
// mapping the browser exporter hands pptxgenjs.
var shapePreset = map[string]string{
	"rect": "rect", "roundRect": "roundRect", "oval": "ellipse", "triangle": "triangle",
	"star": "star5", "line": "line", "arrow": "rightArrow", "callout": "wedgeRectCallout",
}

var hexColorRe = regexp.MustCompile(`(?i)^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$`)

// sanitizeColor returns an RRGGBB hex (no '#') or the fallback. Fails closed: a
// value that is not a plain hex colour never reaches the markup.
func sanitizeColor(v, dflt string) string {
	s := strings.TrimSpace(v)
	if !hexColorRe.MatchString(s) {
		return dflt
	}
	s = strings.TrimPrefix(s, "#")
	switch len(s) {
	case 3:
		return strings.ToUpper(string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]}))
	case 8:
		s = s[:6] // drop the alpha byte; opacity rides on its own field
	}
	return strings.ToUpper(s)
}

// sanitizeObject validates and clamps one descriptor. Returns ok=false when it
// cannot be salvaged.
func sanitizeObject(o SlideObject) (SlideObject, bool) {
	if !objectTypes[o.Type] {
		return SlideObject{}, false
	}
	o.W = clampFinite(o.W, minObjectSize, 4, 0.3)
	o.H = clampFinite(o.H, minObjectSize, 4, 0.2)
	o.X = clampFinite(o.X, -2, 3, 0.1)
	o.Y = clampFinite(o.Y, -2, 3, 0.1)
	o.Rotation = clampFinite(o.Rotation, -360, 360, 0)

	switch o.Type {
	case "shape":
		if _, ok := shapePreset[o.Shape]; !ok {
			o.Shape = "rect"
		}
		o.Fill = sanitizeColor(o.Fill, "7C6AF7")
		o.Stroke = sanitizeColor(o.Stroke, "5B4DD0")
		o.StrokeWidth = clampFinite(o.StrokeWidth, 0, 40, 2)
		if o.hasOpacity {
			o.Opacity = clampFinite(o.Opacity, 0, 1, 1)
		} else {
			o.Opacity = 1
		}
	case "text":
		if o.Align != "left" && o.Align != "center" && o.Align != "right" {
			o.Align = "left"
		}
		if o.VAlign != "top" && o.VAlign != "middle" && o.VAlign != "bottom" {
			o.VAlign = "top"
		}
	case "image":
		if strings.TrimSpace(o.Src) == "" {
			return SlideObject{}, false
		}
	}
	return o, true
}

// EnsureObjects returns a slide's objects, migrating a LEGACY slide (title +
// content HTML, no objects[]) into positioned text boxes — the same derivation
// ensureObjects() makes in the editor, so an old deck exports with the same layout
// the user sees on the canvas.
func EnsureObjects(s Slide) []SlideObject {
	if s.Objects != nil {
		out := make([]SlideObject, 0, len(s.Objects))
		for _, raw := range s.Objects {
			if len(out) >= maxObjectsPerSlide {
				break
			}
			if o, ok := sanitizeObject(raw); ok {
				out = append(out, o)
			}
		}
		return sortByZ(out)
	}

	var objs []SlideObject
	z := 1
	if strings.TrimSpace(s.Title) != "" {
		objs = append(objs, SlideObject{
			Type: "text", X: 0.08, Y: 0.10, W: 0.84, H: 0.18, Z: z,
			HTML: "<h2>" + escapeText(s.Title) + "</h2>", Align: "left", VAlign: "top",
		})
		z++
	}
	content := strings.TrimSpace(s.Content)
	if content != "" && content != "<p></p>" {
		o := SlideObject{
			Type: "text", X: 0.08, Y: 0.30, W: 0.84, H: 0.40, Z: z,
			HTML: content, Align: "left", VAlign: "top",
		}
		if strings.TrimSpace(s.Title) == "" {
			o.X, o.Y, o.W, o.H = 0.08, 0.12, 0.84, 0.70
		}
		objs = append(objs, o)
	}
	return objs
}

func escapeText(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

// sortByZ orders objects back-to-front. PPTX has no z-index: paint order IS the
// stacking order, so getting this wrong hides objects behind others.
func sortByZ(objs []SlideObject) []SlideObject {
	out := append([]SlideObject(nil), objs...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Z < out[j-1].Z; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// ─── Images ─────────────────────────────────────────────────────────────────

var imgDataURIRe = regexp.MustCompile(`(?is)^data:(image/(?:png|jpe?g|gif|webp))\s*;\s*base64\s*,(.*)$`)

// slideImage is a decoded, bounded raster image ready to embed in the package.
type slideImage struct {
	data []byte
	ext  string // png | jpeg | gif
}

// decodeImageSrc turns an object's src into embeddable bytes, or explains why it
// cannot. The reason is caller-presentable — it becomes the export warning.
func decodeImageSrc(src string) (*slideImage, error) {
	src = strings.TrimSpace(src)
	m := imgDataURIRe.FindStringSubmatch(src)
	if m == nil {
		low := strings.ToLower(src)
		if strings.HasPrefix(low, "http://") || strings.HasPrefix(low, "https://") {
			// We do NOT fetch it: a deck is untrusted input, and an exporter that
			// fetched arbitrary URLs would be a server-side request-forgery probe.
			return nil, fmt.Errorf("the server does not fetch remote images")
		}
		return nil, fmt.Errorf("only embedded PNG, JPEG, GIF and WebP images can be exported")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(m[2]))
	if err != nil {
		cleaned := strings.NewReplacer("\n", "", "\r", "", " ", "", "\t", "").Replace(m[2])
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(cleaned, "="))
		if err != nil {
			return nil, fmt.Errorf("its data could not be decoded")
		}
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("its data is empty")
	}
	if len(raw) > maxImageBytes {
		return nil, fmt.Errorf("it is larger than %d MB", maxImageBytes>>20)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("it is not a readable image")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxImagePixels {
		return nil, fmt.Errorf("its dimensions are unusable")
	}

	switch format {
	case "png":
		return &slideImage{data: raw, ext: "png"}, nil
	case "jpeg":
		return &slideImage{data: raw, ext: "jpeg"}, nil
	case "gif":
		return &slideImage{data: raw, ext: "gif"}, nil
	case "webp":
		// PowerPoint's WebP support is recent and patchy — transcode to PNG rather
		// than ship a part a reader might refuse. PNG is lossless, so no pixels are lost.
		decoded, derr := webp.Decode(bytes.NewReader(raw))
		if derr != nil {
			return nil, fmt.Errorf("its WebP data could not be decoded")
		}
		var buf bytes.Buffer
		if eerr := png.Encode(&buf, decoded); eerr != nil {
			return nil, fmt.Errorf("its WebP data could not be converted")
		}
		return &slideImage{data: buf.Bytes(), ext: "png"}, nil
	}
	return nil, fmt.Errorf("its format (%s) cannot be embedded", format)
}
