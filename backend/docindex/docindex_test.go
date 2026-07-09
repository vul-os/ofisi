package docindex

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, s string) interface{} {
	t.Helper()
	var v interface{}
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	return v
}

func TestExtractText_Doc(t *testing.T) {
	// TipTap doc: text is under nested content[].text; type keys must be skipped.
	doc := mustJSON(t, `{
		"type":"doc",
		"content":[
			{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Quarterly Report"}]},
			{"type":"paragraph","content":[{"type":"text","text":"Revenue grew by 20 percent."}]}
		]
	}`)
	got := ExtractText(doc)
	if !strings.Contains(got, "Quarterly Report") || !strings.Contains(got, "Revenue grew by 20 percent") {
		t.Fatalf("doc text not extracted: %q", got)
	}
	// The structural "type":"doc"/"paragraph" must NOT leak into the text.
	if strings.Contains(got, "paragraph") || strings.Contains(strings.ToLower(got), "heading") {
		t.Fatalf("structural keys leaked into extracted text: %q", got)
	}
}

func TestExtractText_Sheet(t *testing.T) {
	// Fortune Sheet: cell display text under data[].celldata[].v.m
	sheet := mustJSON(t, `[
		{"name":"Sheet1","celldata":[
			{"r":0,"c":0,"v":{"v":"Budget","m":"Budget","ct":{"t":"s"}}},
			{"r":0,"c":1,"v":{"v":1234,"m":"1234"}}
		]}
	]`)
	got := ExtractText(sheet)
	if !strings.Contains(got, "Budget") {
		t.Fatalf("sheet cell text not extracted: %q", got)
	}
}

func TestExtractText_Slide(t *testing.T) {
	slide := mustJSON(t, `{"slides":[{"elements":[{"type":"text","text":"Welcome to Vulos"}]}]}`)
	got := ExtractText(slide)
	if !strings.Contains(got, "Welcome to Vulos") {
		t.Fatalf("slide text not extracted: %q", got)
	}
}

func TestMatch_SnippetAndCaseInsensitive(t *testing.T) {
	text := "The quick brown fox jumps over the lazy dog near the river bank."
	snip, ok := Match(text, "BROWN FOX", 10)
	if !ok {
		t.Fatal("expected a match")
	}
	if !strings.Contains(snip, "«") || !strings.Contains(snip, "»") {
		t.Fatalf("snippet should highlight the match: %q", snip)
	}
	if !strings.Contains(strings.ToLower(snip), "brown fox") {
		t.Fatalf("snippet should contain the matched phrase: %q", snip)
	}
	if _, ok := Match(text, "elephant", 10); ok {
		t.Fatal("did not expect a match for absent term")
	}
	if _, ok := Match(text, "", 10); ok {
		t.Fatal("empty query must never match")
	}
}

func TestDiff_Doc_Readable(t *testing.T) {
	oldDoc := mustJSON(t, `{"type":"doc","content":[
		{"type":"paragraph","content":[{"type":"text","text":"line one"}]},
		{"type":"paragraph","content":[{"type":"text","text":"line two"}]}
	]}`)
	newDoc := mustJSON(t, `{"type":"doc","content":[
		{"type":"paragraph","content":[{"type":"text","text":"line one"}]},
		{"type":"paragraph","content":[{"type":"text","text":"line two changed"}]},
		{"type":"paragraph","content":[{"type":"text","text":"line three"}]}
	]}`)
	d := DiffContent("doc", oldDoc, newDoc)
	if d.Kind != "line" {
		t.Fatalf("docs diff should be line-kind, got %q", d.Kind)
	}
	// "line one" equal; "line two" removed; "line two changed" + "line three" added.
	var equal, insert, del int
	for _, l := range d.Lines {
		switch l.Op {
		case DiffEqual:
			equal++
		case DiffInsert:
			insert++
		case DiffDelete:
			del++
		}
	}
	if equal != 1 {
		t.Fatalf("expected 1 equal line, got %d (%+v)", equal, d.Lines)
	}
	if insert != 2 || del != 1 {
		t.Fatalf("expected 2 inserts / 1 delete, got %d/%d (%+v)", insert, del, d.Lines)
	}
	if d.Added != 2 || d.Removed != 1 {
		t.Fatalf("diff counts wrong: added=%d removed=%d", d.Added, d.Removed)
	}
}

func TestDiff_Sheet_Summary(t *testing.T) {
	oldS := mustJSON(t, `[{"name":"S","celldata":[{"r":0,"c":0,"v":{"m":"a"}}]}]`)
	newS := mustJSON(t, `[{"name":"S","celldata":[{"r":0,"c":0,"v":{"m":"a"}},{"r":1,"c":0,"v":{"m":"b"}}]}]`)
	d := DiffContent("sheet", oldS, newS)
	if d.Kind != "summary" {
		t.Fatalf("sheet diff should be summary-kind, got %q", d.Kind)
	}
	if d.Added != 1 {
		t.Fatalf("expected 1 cell added, got %d", d.Added)
	}
	if d.Summary == "" || !strings.Contains(d.Summary, "cell") {
		t.Fatalf("expected a cell summary, got %q", d.Summary)
	}
}

func TestDiff_NoChange(t *testing.T) {
	same := mustJSON(t, `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"identical"}]}]}`)
	d := DiffContent("doc", same, same)
	if d.Added != 0 || d.Removed != 0 {
		t.Fatalf("identical content should show no changes, got +%d -%d", d.Added, d.Removed)
	}
}
