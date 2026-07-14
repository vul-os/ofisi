// pptx.go — server-side PPTX export for slide decks.
//
// Implementation: hand-rolled minimal PresentationML (OOXML) package, the same
// approach docs_export takes for DOCX — assemble the required ZIP entries rather
// than pull in a third-party library whose licence may not fit the project's.
//
// WHAT CHANGED. This file used to render only a slide's Title and Content, and its
// header said so — "the server renders what the server model holds". That was an
// acknowledgement, not a defence: `objects[]` IS the slide body (the editor says so
// outright), so `GET /files/:id/export?format=pptx` and the public
// `POST /v1/documents/:id/export` returned decks with every image, shape and text
// box missing — HTTP 200, no warning. The deck now renders its OBJECTS (objects.go):
// real text boxes, real pictures and real preset shapes, each at its own position,
// size and rotation. Anything that still cannot ride (a remote image the server
// must not fetch; speaker notes) is REPORTED, never dropped in silence.
//
// Parts written (the minimum a conforming consumer needs):
//
//	[Content_Types].xml
//	_rels/.rels
//	ppt/presentation.xml            + ppt/_rels/presentation.xml.rels
//	ppt/slideMasters/slideMaster1.xml + rels
//	ppt/slideLayouts/slideLayout1.xml + rels
//	ppt/theme/theme1.xml
//	ppt/slides/slideN.xml           + rels   (one per slide)
//	ppt/media/imageN_M.<ext>                 (one per embedded image)
package slides_export

import (
	"archive/zip"
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"text/template"
)

// Slide geometry in EMU (914400 EMU = 1 inch): 16:9, 13.333in × 7.5in.
//
// The old fixed title/body boxes are gone: object geometry is NORMALISED to the
// stage, so every position now comes from the object itself (see objects.go).
const (
	slideW = 12192000
	slideH = 6858000
)

// pptxEscape escapes text for an XML text node / attribute value.
func pptxEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	// Drop control characters XML 1.0 cannot carry (tab/LF/CR excepted).
	var sb strings.Builder
	for _, c := range s {
		if c < 0x20 && c != '\t' && c != '\n' && c != '\r' {
			continue
		}
		sb.WriteRune(c)
	}
	return r.Replace(sb.String())
}

// pptxSlide is the per-slide view model: its background, and the SHAPES its
// objects[] became.
type pptxSlide struct {
	SpTree  string // the rendered <p:sp>/<p:pic> elements, in paint order
	BgHex   string // "RRGGBB", no leading '#'
	TextHex string // "RRGGBB", contrasts with BgHex
	Images  []slideMedia
}

// slideMedia is one image part this slide references.
type slideMedia struct {
	rID  string // "rId2" (rId1 is the layout)
	name string // "image1.png"
	data []byte
	ext  string
}

// blockBreakRe matches the block-level tags that end a line of slide copy.
// PPTX carries real paragraphs (<a:p>), so — unlike the PDF renderer, which
// re-wraps one flat string — we keep the deck's paragraph breaks.
var blockBreakRe = regexp.MustCompile(`(?i)</(p|div|li|h[1-6])\s*>|<br\s*/?>`)

// headingRe detects a heading wrapper, which renders larger + bold (the same rough
// rule the browser exporter applies).
var headingRe = regexp.MustCompile(`(?i)<h[1-3][\s>]`)

// contentLines turns a slide's HTML body into one plain-text line per paragraph.
func contentLines(content string) []string {
	var lines []string
	for _, l := range strings.Split(stripHTML(blockBreakRe.ReplaceAllString(content, "\n")), "\n") {
		lines = append(lines, strings.TrimSpace(l))
	}
	// A text body with no paragraphs is invalid; keep at least one (empty) one.
	if len(lines) == 0 {
		lines = []string{""}
	}
	return lines
}

// EMU geometry: the slide is 12192000 × 6858000 EMU, and object coordinates are
// normalised fractions of it — so the mapping is an exact multiplication.
func emuX(v float64) int { return int(v * float64(slideW)) }
func emuY(v float64) int { return int(v * float64(slideH)) }

// rotAttr renders a rotation as the ` rot="…"` attribute (60000ths of a degree).
func rotAttr(deg float64) string {
	if deg == 0 {
		return ""
	}
	d := deg
	for d < 0 {
		d += 360
	}
	for d >= 360 {
		d -= 360
	}
	return fmt.Sprintf(` rot="%d"`, int(d*60000))
}

func alignAttr(a string) string {
	switch a {
	case "center":
		return ` algn="ctr"`
	case "right":
		return ` algn="r"`
	}
	return ` algn="l"`
}

func anchorAttr(v string) string {
	switch v {
	case "middle":
		return "ctr"
	case "bottom":
		return "b"
	}
	return "t"
}

// buildSlide turns one Slide into its shapes. This is the fix for the dropped
// objects: every text box, image and shape the editor holds becomes a real
// PresentationML element at its real position — not just Title + Content.
func buildSlide(s Slide, idx int, rep *Report) pptxSlide {
	r, g, b := hexToRGB(s.Background)
	textHex := "14141E"
	if isDark(r, g, b) {
		textHex = "F0F0FF"
	}
	out := pptxSlide{
		BgHex:   fmt.Sprintf("%02X%02X%02X", r, g, b),
		TextHex: textHex,
	}

	var sb strings.Builder
	// Shape ids must be unique within a slide and must not collide with the group
	// (id 1), so object ids start at 2.
	shapeID := 2

	for _, o := range EnsureObjects(s) {
		switch o.Type {
		case "text":
			if el := textShapeXML(o, shapeID, textHex); el != "" {
				sb.WriteString(el)
				shapeID++
				rep.ObjectsEmbedded++
			}
		case "shape":
			sb.WriteString(shapeXML(o, shapeID))
			shapeID++
			rep.ObjectsEmbedded++
		case "image":
			img, err := decodeImageSrc(o.Src)
			if err != nil {
				rep.skip(o, err.Error())
				continue
			}
			m := slideMedia{
				rID:  fmt.Sprintf("rId%d", len(out.Images)+2), // rId1 = the layout
				name: fmt.Sprintf("image%d_%d.%s", idx+1, len(out.Images)+1, img.ext),
				data: img.data,
				ext:  img.ext,
			}
			out.Images = append(out.Images, m)
			sb.WriteString(pictureXML(o, shapeID, m.rID, m.name))
			shapeID++
			rep.ObjectsEmbedded++
			rep.ImagesEmbedded++
		}
	}

	// Speaker notes need a notesSlide part, which this minimal package does not
	// write. That is a real (small) loss, so it is REPORTED rather than ignored.
	if strings.TrimSpace(s.Notes) != "" {
		rep.warn("Speaker notes are not included in the server .pptx export.")
	}

	out.SpTree = sb.String()
	return out
}

// textShapeXML renders a text object as a real text box at its own geometry.
func textShapeXML(o SlideObject, id int, textHex string) string {
	lines := contentLines(o.HTML)
	nonEmpty := false
	for _, l := range lines {
		if strings.TrimSpace(l) != "" {
			nonEmpty = true
			break
		}
	}
	if !nonEmpty {
		return "" // an empty text box is noise, not content
	}

	size := 1800
	bold := "0"
	if headingRe.MatchString(o.HTML) {
		size = 3200
		bold = "1"
	}

	var body strings.Builder
	for _, l := range lines {
		fmt.Fprintf(&body,
			`<a:p><a:pPr%s/><a:r><a:rPr lang="en-US" sz="%d" b="%s" dirty="0"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:rPr><a:t>%s</a:t></a:r></a:p>`,
			alignAttr(o.Align), size, bold, textHex, pptxEscape(l))
	}

	return fmt.Sprintf(`      <p:sp>
        <p:nvSpPr><p:cNvPr id="%d" name="Text %d"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm%s><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" anchor="%s"><a:normAutofit/></a:bodyPr><a:lstStyle/>
%s
        </p:txBody>
      </p:sp>
`, id, id, rotAttr(o.Rotation), emuX(o.X), emuY(o.Y), emuX(o.W), emuY(o.H),
		anchorAttr(o.VAlign), body.String())
}

// shapeXML renders a shape object as a preset geometry with its fill/stroke.
func shapeXML(o SlideObject, id int) string {
	preset := shapePreset[o.Shape]
	if preset == "" {
		preset = "rect"
	}

	fill := "<a:noFill/>"
	if o.Shape != "line" {
		alpha := ""
		if o.Opacity < 1 {
			alpha = fmt.Sprintf(`<a:alpha val="%d"/>`, int(o.Opacity*100000))
		}
		fill = fmt.Sprintf(`<a:solidFill><a:srgbClr val="%s">%s</a:srgbClr></a:solidFill>`, o.Fill, alpha)
	}
	// Stroke width is in EMU: 12700 EMU = 1 pt.
	line := fmt.Sprintf(`<a:ln w="%d"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:ln>`,
		int(o.StrokeWidth*12700), o.Stroke)

	return fmt.Sprintf(`      <p:sp>
        <p:nvSpPr><p:cNvPr id="%d" name="Shape %d"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm%s><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>
          <a:prstGeom prst="%s"><a:avLst/></a:prstGeom>
          %s%s
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
      </p:sp>
`, id, id, rotAttr(o.Rotation), emuX(o.X), emuY(o.Y), emuX(o.W), emuY(o.H), preset, fill, line)
}

// pictureXML renders an image object as a real <p:pic> pointing at a media part.
func pictureXML(o SlideObject, id int, rID, name string) string {
	return fmt.Sprintf(`      <p:pic>
        <p:nvPicPr><p:cNvPr id="%d" name="%s"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr>
          <a:xfrm%s><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
`, id, pptxEscape(name), rID, rotAttr(o.Rotation), emuX(o.X), emuY(o.Y), emuX(o.W), emuY(o.H))
}

const pptxContentTypesHead = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
`

const pptxRootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

const pptxMasterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`

const pptxLayoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`

const pptxSlideMaster = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`

const pptxSlideLayout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`

const pptxTheme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Vulos">
  <a:themeElements>
    <a:clrScheme name="Vulos">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F1F2E"/></a:dk2>
      <a:lt2><a:srgbClr val="EEEEF2"/></a:lt2>
      <a:accent1><a:srgbClr val="4F46E5"/></a:accent1>
      <a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
      <a:accent5><a:srgbClr val="EF4444"/></a:accent5>
      <a:accent6><a:srgbClr val="8B5CF6"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Vulos">
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Vulos">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`

var pptxFuncs = template.FuncMap{
	"add":   func(a, b int) int { return a + b },
	"sldID": func(i int) int { return 256 + i },
}

var pptxPresentationTmpl = template.Must(template.New("presentation").Funcs(pptxFuncs).Parse(
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>
{{range $i, $_ := .Slides}}    <p:sldId id="{{sldID $i}}" r:id="rId{{add $i 2}}"/>
{{end}}  </p:sldIdLst>
  <p:sldSz cx="{{.SlideW}}" cy="{{.SlideH}}"/>
  <p:notesSz cx="{{.SlideH}}" cy="{{.SlideW}}"/>
</p:presentation>`))

var pptxPresentationRelsTmpl = template.Must(template.New("presentationRels").Funcs(pptxFuncs).Parse(
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
{{range $i, $_ := .Slides}}  <Relationship Id="rId{{add $i 2}}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{{add $i 1}}.xml"/>
{{end}}</Relationships>`))

// slideXML assembles one slide part. The shape tree is pre-rendered (and fully
// escaped) by buildSlide, so this is pure assembly.
func slideXML(s pptxSlide) string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="` + s.BgHex + `"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
` + s.SpTree + `    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`
}

// slideRelsXML relates a slide to its layout and to every image it embeds.
func slideRelsXML(s pptxSlide) string {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	sb.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + "\n")
	sb.WriteString(`  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` + "\n")
	for _, m := range s.Images {
		fmt.Fprintf(&sb,
			`  <Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/%s"/>`+"\n",
			m.rID, m.name)
	}
	sb.WriteString(`</Relationships>`)
	return sb.String()
}

type presentationTemplateData struct {
	Slides         []pptxSlide
	SlideW, SlideH int
}

// GeneratePPTX renders a deck to a valid PresentationML (.pptx) package —
// INCLUDING the positioned objects (text boxes, images, shapes) that are the
// slide's actual body.
//
// It returns a *Report describing what the deck actually carries. The report is not
// decoration: a caller that gets warnings MUST surface them, because an export that
// quietly drops every image is the bug this signature exists to prevent.
//
// Text is escaped, not templated raw: slide content is user data and must never be
// able to close a tag and inject XML into the package.
func GeneratePPTX(deck Deck) ([]byte, *Report, error) {
	rep := &Report{}
	if len(deck.Slides) == 0 {
		return nil, rep, fmt.Errorf("slides_export: deck has no slides")
	}

	slides := make([]pptxSlide, 0, len(deck.Slides))
	for i, s := range deck.Slides {
		slides = append(slides, buildSlide(s, i, rep))
	}

	var pres bytes.Buffer
	pd := presentationTemplateData{Slides: slides, SlideW: slideW, SlideH: slideH}
	if err := pptxPresentationTmpl.Execute(&pres, pd); err != nil {
		return nil, rep, fmt.Errorf("slides_export: render presentation.xml: %w", err)
	}
	var presRels bytes.Buffer
	if err := pptxPresentationRelsTmpl.Execute(&presRels, pd); err != nil {
		return nil, rep, fmt.Errorf("slides_export: render presentation.xml.rels: %w", err)
	}

	type entry struct {
		name string
		data []byte
	}
	var media []entry
	exts := map[string]bool{}
	for _, s := range slides {
		for _, m := range s.Images {
			media = append(media, entry{name: "ppt/media/" + m.name, data: m.data})
			exts[m.ext] = true
		}
	}

	// [Content_Types].xml must declare every slide part AND every media extension —
	// PowerPoint refuses a package whose image parts have no declared content type.
	var ct strings.Builder
	ct.WriteString(pptxContentTypesHead)
	for _, e := range []string{"gif", "jpeg", "png"} { // deterministic order
		if exts[e] {
			fmt.Fprintf(&ct, `  <Default Extension="%s" ContentType="image/%s"/>`+"\n", e, e)
		}
	}
	for i := range slides {
		fmt.Fprintf(&ct, `  <Override PartName="/ppt/slides/slide%d.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`+"\n", i+1)
	}
	ct.WriteString("</Types>")

	entries := []entry{
		{"[Content_Types].xml", []byte(ct.String())},
		{"_rels/.rels", []byte(pptxRootRels)},
		{"ppt/presentation.xml", pres.Bytes()},
		{"ppt/_rels/presentation.xml.rels", presRels.Bytes()},
		{"ppt/slideMasters/slideMaster1.xml", []byte(pptxSlideMaster)},
		{"ppt/slideMasters/_rels/slideMaster1.xml.rels", []byte(pptxMasterRels)},
		{"ppt/slideLayouts/slideLayout1.xml", []byte(pptxSlideLayout)},
		{"ppt/slideLayouts/_rels/slideLayout1.xml.rels", []byte(pptxLayoutRels)},
		{"ppt/theme/theme1.xml", []byte(pptxTheme)},
	}

	for i, s := range slides {
		entries = append(entries,
			entry{fmt.Sprintf("ppt/slides/slide%d.xml", i+1), []byte(slideXML(s))},
			entry{fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", i+1), []byte(slideRelsXML(s))},
		)
	}
	entries = append(entries, media...)

	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			return nil, rep, fmt.Errorf("slides_export: zip create %s: %w", e.name, err)
		}
		if _, err := w.Write(e.data); err != nil {
			return nil, rep, fmt.Errorf("slides_export: zip write %s: %w", e.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		return nil, rep, fmt.Errorf("slides_export: zip close: %w", err)
	}
	return zipBuf.Bytes(), rep, nil
}
