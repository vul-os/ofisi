// pptx.go — server-side PPTX export for slide decks.
//
// Implementation: hand-rolled minimal PresentationML (OOXML) package, the same
// approach docs_export takes for DOCX — assemble the required ZIP entries from
// text/template rather than pull in a third-party library whose licence may not
// fit the project's.
//
// The browser exports decks through pptxgenjs, which also carries the editor's
// positioned objects. The server renders what the server model holds — the same
// content RenderPDF does: per slide a background, a title and body text — so the
// /v1 developer API can export a deck without a browser in the loop.
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
const (
	slideW = 12192000
	slideH = 6858000

	boxLeft  = 685800 // 0.75in
	boxWidth = 10820400
	titleTop = 457200 // 0.5in
	titleH   = 1143000
	bodyTop  = 1828800 // 2in
	bodyH    = 4114800

	titleSz = 3200 // hundredths of a point
	bodySz  = 1800
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

// pptxSlide is the per-slide view model handed to the slide template.
type pptxSlide struct {
	Title   string
	Lines   []string
	BgHex   string // "RRGGBB", no leading '#'
	TextHex string // "RRGGBB", contrasts with BgHex
}

// blockBreakRe matches the block-level tags that end a line of slide copy.
// PPTX carries real paragraphs (<a:p>), so — unlike the PDF renderer, which
// re-wraps one flat string — we keep the deck's paragraph breaks.
var blockBreakRe = regexp.MustCompile(`(?i)</(p|div|li|h[1-6])\s*>|<br\s*/?>`)

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

// buildSlide normalises one Slide into the template's view model, reusing the
// same HTML-stripping and background-contrast rules as the PDF renderer.
func buildSlide(s Slide) pptxSlide {
	r, g, b := hexToRGB(s.Background)
	text := "14141E"
	if isDark(r, g, b) {
		text = "F0F0FF"
	}
	return pptxSlide{
		Title:   s.Title,
		Lines:   contentLines(s.Content),
		BgHex:   fmt.Sprintf("%02X%02X%02X", r, g, b),
		TextHex: text,
	}
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

const pptxSlideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
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

var pptxSlideTmpl = template.Must(template.New("slide").Parse(
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="{{.BgHex}}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="{{.BoxLeft}}" y="{{.TitleTop}}"/><a:ext cx="{{.BoxWidth}}" cy="{{.TitleH}}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>
          <a:p><a:r><a:rPr lang="en-US" sz="{{.TitleSz}}" b="1" dirty="0"><a:solidFill><a:srgbClr val="{{.TextHex}}"/></a:solidFill></a:rPr><a:t>{{.Title}}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="{{.BoxLeft}}" y="{{.BodyTop}}"/><a:ext cx="{{.BoxWidth}}" cy="{{.BodyH}}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>
{{range .Lines}}          <a:p><a:r><a:rPr lang="en-US" sz="{{$.BodySz}}" dirty="0"><a:solidFill><a:srgbClr val="{{$.TextHex}}"/></a:solidFill></a:rPr><a:t>{{.}}</a:t></a:r></a:p>
{{end}}        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`))

// slideTemplateData is the per-slide template context: escaped content + the
// fixed geometry the slide XML lays it out with.
type slideTemplateData struct {
	Title   string
	Lines   []string
	BgHex   string
	TextHex string

	BoxLeft, BoxWidth int
	TitleTop, TitleH  int
	BodyTop, BodyH    int
	TitleSz, BodySz   int
}

type presentationTemplateData struct {
	Slides         []pptxSlide
	SlideW, SlideH int
}

// GeneratePPTX renders a deck to a valid PresentationML (.pptx) package.
//
// Text is escaped, not templated raw: a slide title is user content and must
// never be able to close a tag and inject XML into the package.
func GeneratePPTX(deck Deck) ([]byte, error) {
	if len(deck.Slides) == 0 {
		return nil, fmt.Errorf("slides_export: deck has no slides")
	}

	slides := make([]pptxSlide, 0, len(deck.Slides))
	for _, s := range deck.Slides {
		slides = append(slides, buildSlide(s))
	}

	var pres bytes.Buffer
	pd := presentationTemplateData{Slides: slides, SlideW: slideW, SlideH: slideH}
	if err := pptxPresentationTmpl.Execute(&pres, pd); err != nil {
		return nil, fmt.Errorf("slides_export: render presentation.xml: %w", err)
	}
	var presRels bytes.Buffer
	if err := pptxPresentationRelsTmpl.Execute(&presRels, pd); err != nil {
		return nil, fmt.Errorf("slides_export: render presentation.xml.rels: %w", err)
	}

	// [Content_Types].xml must declare every slide part.
	var ct strings.Builder
	ct.WriteString(pptxContentTypesHead)
	for i := range slides {
		fmt.Fprintf(&ct, `  <Override PartName="/ppt/slides/slide%d.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`+"\n", i+1)
	}
	ct.WriteString("</Types>")

	type entry struct {
		name string
		data string
	}
	entries := []entry{
		{"[Content_Types].xml", ct.String()},
		{"_rels/.rels", pptxRootRels},
		{"ppt/presentation.xml", pres.String()},
		{"ppt/_rels/presentation.xml.rels", presRels.String()},
		{"ppt/slideMasters/slideMaster1.xml", pptxSlideMaster},
		{"ppt/slideMasters/_rels/slideMaster1.xml.rels", pptxMasterRels},
		{"ppt/slideLayouts/slideLayout1.xml", pptxSlideLayout},
		{"ppt/slideLayouts/_rels/slideLayout1.xml.rels", pptxLayoutRels},
		{"ppt/theme/theme1.xml", pptxTheme},
	}

	for i, s := range slides {
		var sb bytes.Buffer
		data := slideTemplateData{
			Title:   pptxEscape(s.Title),
			BgHex:   s.BgHex,
			TextHex: s.TextHex,

			BoxLeft: boxLeft, BoxWidth: boxWidth,
			TitleTop: titleTop, TitleH: titleH,
			BodyTop: bodyTop, BodyH: bodyH,
			TitleSz: titleSz, BodySz: bodySz,
		}
		for _, l := range s.Lines {
			data.Lines = append(data.Lines, pptxEscape(l))
		}
		if err := pptxSlideTmpl.Execute(&sb, data); err != nil {
			return nil, fmt.Errorf("slides_export: render slide%d.xml: %w", i+1, err)
		}
		entries = append(entries,
			entry{fmt.Sprintf("ppt/slides/slide%d.xml", i+1), sb.String()},
			entry{fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", i+1), pptxSlideRels},
		)
	}

	var zipBuf bytes.Buffer
	zw := zip.NewWriter(&zipBuf)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			return nil, fmt.Errorf("slides_export: zip create %s: %w", e.name, err)
		}
		if _, err := w.Write([]byte(e.data)); err != nil {
			return nil, fmt.Errorf("slides_export: zip write %s: %w", e.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("slides_export: zip close: %w", err)
	}
	return zipBuf.Bytes(), nil
}
