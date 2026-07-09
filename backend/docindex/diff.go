package docindex

import "fmt"

// DiffOp is one operation in a line diff.
type DiffOp string

const (
	DiffEqual  DiffOp = "equal"
	DiffInsert DiffOp = "insert"
	DiffDelete DiffOp = "delete"
)

// DiffLine is a single line of a rendered diff.
type DiffLine struct {
	Op   DiffOp `json:"op"`
	Text string `json:"text"`
}

// Diff is the result of comparing two document contents.
type Diff struct {
	// Kind is "line" for a readable line-level diff (Docs) or "summary" for the
	// coarse structural summary used for Sheets/Slides.
	Kind string `json:"kind"`
	// Lines is the line-level diff (present when Kind == "line").
	Lines []DiffLine `json:"lines,omitempty"`
	// Summary is a human-readable coarse description (present when Kind ==
	// "summary", and also always populated as a headline stat).
	Summary string `json:"summary"`
	// Added / Removed are line counts, useful for a compact UI badge.
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// DiffContent compares two decoded document contents and returns a diff.
//
// fileType selects the presentation:
//   - "doc"                → readable line-level LCS diff over extracted paragraphs.
//   - "sheet" / "slide"    → coarser: still a line-level diff over extracted
//     cell/element text, but callers may prefer the summary headline. We keep the
//     line diff too so the UI can show detail if it wants; it is inherently
//     coarser because a spreadsheet flattens to cell text.
func DiffContent(fileType string, oldContent, newContent interface{}) Diff {
	oldLines := ExtractLines(oldContent)
	newLines := ExtractLines(newContent)
	lines := diffLines(oldLines, newLines)

	added, removed := 0, 0
	for _, l := range lines {
		switch l.Op {
		case DiffInsert:
			added++
		case DiffDelete:
			removed++
		}
	}

	kind := "line"
	if fileType == "sheet" || fileType == "slide" {
		kind = "summary"
	}

	summary := diffSummary(fileType, added, removed)
	return Diff{Kind: kind, Lines: lines, Summary: summary, Added: added, Removed: removed}
}

func diffSummary(fileType string, added, removed int) string {
	unit := "line"
	switch fileType {
	case "sheet":
		unit = "cell/row"
	case "slide":
		unit = "element"
	}
	if added == 0 && removed == 0 {
		return "No textual changes"
	}
	plural := func(n int) string {
		if n == 1 {
			return ""
		}
		return "s"
	}
	return fmt.Sprintf("%d %s%s added, %d %s%s removed",
		added, unit, plural(added), removed, unit, plural(removed))
}

// diffLines computes a line-level diff via the classic LCS dynamic-programming
// algorithm, then walks the DP table to emit equal/insert/delete ops in order.
func diffLines(a, b []string) []DiffLine {
	n, m := len(a), len(b)
	// LCS length table.
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var out []DiffLine
	i, j := 0, 0
	for i < n && j < m {
		if a[i] == b[j] {
			out = append(out, DiffLine{Op: DiffEqual, Text: a[i]})
			i++
			j++
		} else if lcs[i+1][j] >= lcs[i][j+1] {
			out = append(out, DiffLine{Op: DiffDelete, Text: a[i]})
			i++
		} else {
			out = append(out, DiffLine{Op: DiffInsert, Text: b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, DiffLine{Op: DiffDelete, Text: a[i]})
	}
	for ; j < m; j++ {
		out = append(out, DiffLine{Op: DiffInsert, Text: b[j]})
	}
	return out
}
