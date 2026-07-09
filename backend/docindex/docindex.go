// Package docindex provides schema-agnostic plain-text extraction from Office
// document content (Docs = TipTap JSON, Sheets = Fortune Sheet JSON, Slides =
// deck JSON) plus the search-snippet and version-diff primitives built on top.
//
// The extractor deliberately avoids coupling to any one schema: it walks the
// decoded JSON tree (map[string]interface{} / []interface{} / string) and
// collects human-readable string leaves in document order. This makes it robust
// to schema drift across the three editors and to imported/legacy shapes, while
// staying cheap (no rendering, no external deps).
//
// Nothing in this package makes an authorization decision. Callers (the search
// handler) are responsible for restricting extraction to content the requester
// is allowed to read — extraction itself is content-blind.
package docindex

import (
	"sort"
	"strings"
	"unicode"
)

// keysToSkip are object keys whose string values are structural/formatting
// metadata rather than document text, so they are excluded from the extracted
// text. Everything else that is a string leaf is treated as content.
var keysToSkip = map[string]bool{
	"type":      true, // node type discriminators (paragraph/heading/…)
	"id":        true,
	"uuid":      true,
	"color":     true,
	"bg":        true,
	"align":     true,
	"font":      true,
	"fontsize":  true,
	"ff":        true, // fortune-sheet font family
	"fc":        true, // fortune-sheet font color
	"src":       true, // image sources / data URIs
	"href":      true, // link targets (the visible link text is a separate leaf)
	"class":     true,
	"style":     true,
	"ct":        true, // fortune-sheet cell-type descriptor
	"format":    true,
	"createdAt": true,
	"updatedAt": true,
}

// ExtractText walks decoded JSON content and returns a single normalized string
// of all human-readable text, space-separated, in document order.
func ExtractText(content interface{}) string {
	var b strings.Builder
	walk(content, &b)
	return normalizeSpaces(b.String())
}

// ExtractLines walks content and returns text as logical lines. A "line" is a
// run of text under a leaf; adjacent inline runs (TipTap marks, sheet cells) are
// kept together where the shape implies it. Lines feed the readable Docs diff.
func ExtractLines(content interface{}) []string {
	var lines []string
	walkLines(content, &lines)
	// Drop empty lines but keep intentional structure.
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = normalizeSpaces(l)
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func walk(v interface{}, b *strings.Builder) {
	switch t := v.(type) {
	case string:
		if s := strings.TrimSpace(t); s != "" {
			b.WriteString(s)
			b.WriteByte(' ')
		}
	case []interface{}:
		for _, e := range t {
			walk(e, b)
		}
	case map[string]interface{}:
		// Iterate keys in a stable order so extraction is deterministic.
		keys := sortedKeys(t)
		for _, k := range keys {
			if keysToSkip[k] {
				continue
			}
			walk(t[k], b)
		}
	}
}

// walkLines produces one line per block-ish container. TipTap paragraphs/
// headings and sheet cells collapse their inline children into a single line.
func walkLines(v interface{}, lines *[]string) {
	switch t := v.(type) {
	case map[string]interface{}:
		typ, _ := t["type"].(string)
		if isBlockType(typ) {
			// Collapse this block's text into one line.
			var b strings.Builder
			walk(t, &b)
			*lines = append(*lines, b.String())
			return
		}
		keys := sortedKeys(t)
		for _, k := range keys {
			if keysToSkip[k] {
				continue
			}
			walkLines(t[k], lines)
		}
	case []interface{}:
		for _, e := range t {
			walkLines(e, lines)
		}
	case string:
		if s := strings.TrimSpace(t); s != "" {
			*lines = append(*lines, s)
		}
	}
}

func isBlockType(typ string) bool {
	switch typ {
	case "paragraph", "heading", "blockquote", "codeBlock", "listItem":
		return true
	}
	return false
}

func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func normalizeSpaces(s string) string {
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return unicode.IsSpace(r)
	}), " ")
}

// ─── Search matching + snippet ───────────────────────────────────────────────

// Match reports whether query (case-insensitively) appears in text, and if so
// returns a snippet of surrounding context with the first match highlighted by
// «…» markers. window is the number of characters of context on each side of
// the match. An empty query never matches.
func Match(text, query string, window int) (snippet string, ok bool) {
	if strings.TrimSpace(query) == "" {
		return "", false
	}
	lower := strings.ToLower(text)
	q := strings.ToLower(strings.TrimSpace(query))
	idx := strings.Index(lower, q)
	if idx < 0 {
		return "", false
	}
	if window <= 0 {
		window = 40
	}
	// Work on runes so multibyte content is not sliced mid-character.
	runes := []rune(text)
	// Map byte offset idx to a rune offset.
	start := len([]rune(text[:idx]))
	end := start + len([]rune(text[idx:idx+len(q)]))

	from := start - window
	if from < 0 {
		from = 0
	}
	to := end + window
	if to > len(runes) {
		to = len(runes)
	}

	var b strings.Builder
	if from > 0 {
		b.WriteString("…")
	}
	b.WriteString(string(runes[from:start]))
	b.WriteString("«")
	b.WriteString(string(runes[start:end]))
	b.WriteString("»")
	b.WriteString(string(runes[end:to]))
	if to < len(runes) {
		b.WriteString("…")
	}
	return b.String(), true
}
