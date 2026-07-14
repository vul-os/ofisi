// Package docs_export provides server-side PDF and DOCX export for Docs files.
//
// The document is read into a BLOCK model (blocks.go) — paragraphs, tables and
// images — which both writers render:
//
//	docx.go  hand-rolled OOXML: <w:p>, real <w:tbl>, real word/media images.
//	pdf.go   pure-Go PDF: wrapped text, ruled table grids, embedded image XObjects.
//
// Both are dependency-light on purpose (no Chromium, no third-party DOCX library
// whose licence may not fit the project's).
//
// This file holds the shared pieces: the TipTap JSON model, and the flat paragraph
// extraction the block model builds on.
package docs_export

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ─── TipTap JSON model (minimal, enough for export) ──────────────────────────

// Node represents a TipTap ProseMirror node in the stored JSON.
type Node struct {
	Type    string                 `json:"type"`
	Attrs   map[string]interface{} `json:"attrs,omitempty"`
	Content []Node                 `json:"content,omitempty"`
	Text    string                 `json:"text,omitempty"`
	Marks   []Mark                 `json:"marks,omitempty"`
}

// Mark represents a TipTap inline mark.
type Mark struct {
	Type  string                 `json:"type"`
	Attrs map[string]interface{} `json:"attrs,omitempty"`
}

// DocJSON is the root TipTap document node.
type DocJSON struct {
	Type    string `json:"type"`
	Content []Node `json:"content"`
}

// ParseDocJSON parses a raw JSON byte slice into a DocJSON.
func ParseDocJSON(raw []byte) (*DocJSON, error) {
	// The content field may be stored as a JSON object with a "type":"doc" wrapper.
	var doc DocJSON
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("docs_export: parse doc json: %w", err)
	}
	return &doc, nil
}

// ─── Text extraction ──────────────────────────────────────────────────────────

// Paragraph is a logical paragraph/heading used by both PDF and DOCX renderers.
type Paragraph struct {
	Text         string
	HeadingLevel int // 0 = normal, 1–6 = heading
	IsBullet     bool
	IsCode       bool
	IsBlockquote bool
}

// extractNode is the FLAT extraction: it renders a node as paragraphs only.
//
// It is deliberately NOT the export path any more. Flattening is what destroyed
// structure: a table walked this way came out as loose paragraphs and an image —
// which is an atomic, attrs-only node with no Content to recurse into — came out as
// nothing at all. ExtractBlocks (blocks.go) is the export path; this remains for the
// leaf cases it delegates back to, and for text-only consumers.
func extractNode(n Node) []Paragraph {
	switch n.Type {
	case "paragraph":
		return []Paragraph{{Text: extractText(n.Content), HeadingLevel: 0}}
	case "heading":
		level := 1
		if v, ok := n.Attrs["level"]; ok {
			switch vt := v.(type) {
			case float64:
				level = int(vt)
			case int:
				level = vt
			}
		}
		return []Paragraph{{Text: extractText(n.Content), HeadingLevel: level}}
	case "bulletList", "orderedList", "taskList":
		var items []Paragraph
		for _, item := range n.Content {
			for _, child := range item.Content {
				sub := extractNode(child)
				for i := range sub {
					sub[i].IsBullet = true
				}
				items = append(items, sub...)
			}
		}
		return items
	case "codeBlock":
		return []Paragraph{{Text: extractText(n.Content), IsCode: true}}
	case "blockquote":
		var ps []Paragraph
		for _, child := range n.Content {
			sub := extractNode(child)
			for i := range sub {
				sub[i].IsBlockquote = true
			}
			ps = append(ps, sub...)
		}
		return ps
	case "horizontalRule":
		return []Paragraph{{Text: strings.Repeat("─", 40)}}
	default:
		// Recurse for unknown container nodes
		var ps []Paragraph
		for _, child := range n.Content {
			ps = append(ps, extractNode(child)...)
		}
		return ps
	}
}

// extractText recursively collects text from inline nodes.
func extractText(nodes []Node) string {
	var sb strings.Builder
	for _, n := range nodes {
		if n.Type == "text" {
			sb.WriteString(n.Text)
		}
		// An inline equation is attrs-only (no Content), so a pure text walk drops
		// it. Export its LaTeX source, exactly as the browser exporter does.
		if n.Type == "mathInline" {
			sb.WriteString(attrString(n.Attrs, "latex"))
		}
		if len(n.Content) > 0 {
			sb.WriteString(extractText(n.Content))
		}
	}
	return sb.String()
}
