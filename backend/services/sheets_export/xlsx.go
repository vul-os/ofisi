// Package sheets_export converts between Fortune Sheet JSON and XLSX using
// github.com/xuri/excelize — pure Go, no CGO required.
package sheets_export

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

// ─── Fortune Sheet types ─────────────────────────────────────────────────────

// CellStyle mirrors the relevant fields of Fortune Sheet's Cell type.
type CellStyle struct {
	Bold      int    `json:"bl"`
	Italic    int    `json:"it"`
	FontSize  int    `json:"fs"`
	FontColor string `json:"fc"`
	BgColor   string `json:"bg"`
	Underline int    `json:"un"`
}

// CellData is a single cell entry in Fortune Sheet's celldata array.
type CellData struct {
	R int             `json:"r"`
	C int             `json:"c"`
	V json.RawMessage `json:"v"` // may be a number, string, or object
}

// Sheet is a single Fortune Sheet tab.
type Sheet struct {
	Name     string     `json:"name"`
	CellData []CellData `json:"celldata"`
	Config   struct {
		Merge map[string]struct {
			R  int `json:"r"`
			C  int `json:"c"`
			RS int `json:"rs"`
			CS int `json:"cs"`
		} `json:"merge"`
		Rowlen    map[string]float64 `json:"rowlen"`
		Columnlen map[string]float64 `json:"columnlen"`
	} `json:"config"`

	// Charts the content model persists alongside the cells (see charts.js).
	// These used to be absent from this struct entirely, which is exactly why the
	// server export silently dropped every one of them — see charts.go.
	Charts []Chart `json:"charts,omitempty"`
	// Pivots are LIVE pivot descriptors. Excel has no equivalent, so they are not
	// exported — but they are counted here so the caller can be TOLD (pivotWarning)
	// instead of quietly receiving a workbook without them.
	Pivots []json.RawMessage `json:"pivots,omitempty"`
}

// Workbook is the top-level structure stored in the file's Content field.
type Workbook []Sheet

// ─── cellValue decoding ──────────────────────────────────────────────────────

// cellObject is the rich-cell form Fortune Sheet uses most of the time.
type cellObject struct {
	V         *json.RawMessage `json:"v"` // raw value
	M         *string          `json:"m"` // display string
	F         *string          `json:"f"` // formula
	BgColor   string           `json:"bg"`
	FontColor string           `json:"fc"`
	Bold      int              `json:"bl"`
	Italic    int              `json:"it"`
	Underline int              `json:"un"`
	FontSize  int              `json:"fs"`
}

type decodedCell struct {
	raw     string
	numVal  float64
	isNum   bool
	formula string
	style   cellObject
}

func decodeCell(raw json.RawMessage) (decodedCell, error) {
	var dc decodedCell

	// Try number first.
	var num float64
	if err := json.Unmarshal(raw, &num); err == nil {
		dc.raw = strconv.FormatFloat(num, 'f', -1, 64)
		dc.numVal = num
		dc.isNum = true
		return dc, nil
	}

	// Try plain string.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		dc.raw = s
		return dc, nil
	}

	// Try rich-cell object.
	var obj cellObject
	if err := json.Unmarshal(raw, &obj); err != nil {
		return dc, fmt.Errorf("unsupported cell value: %s", raw)
	}
	dc.style = obj

	if obj.F != nil {
		dc.formula = *obj.F
	}

	if obj.M != nil {
		dc.raw = *obj.M
	}

	if obj.V != nil {
		var inner float64
		if err := json.Unmarshal(*obj.V, &inner); err == nil {
			dc.numVal = inner
			dc.isNum = true
			if dc.raw == "" {
				dc.raw = strconv.FormatFloat(inner, 'f', -1, 64)
			}
		} else {
			var innerStr string
			if err2 := json.Unmarshal(*obj.V, &innerStr); err2 == nil {
				if dc.raw == "" {
					dc.raw = innerStr
				}
			}
		}
	}
	return dc, nil
}

// ─── Export (Fortune Sheet → XLSX) ──────────────────────────────────────────

// ExportXLSX converts a Fortune Sheet JSON workbook ([]Sheet) into an XLSX file
// written to w, INCLUDING every chart as a real, cell-linked OOXML chart part.
//
// It returns a *Report describing what the file actually carries. The report is
// not optional decoration: a caller that receives warnings MUST surface them (the
// HTTP handlers put them on the response), because an export that quietly loses a
// chart is the bug this signature exists to prevent. The Report is non-nil even
// on error paths that still produced a file.
func ExportXLSX(jsonData []byte, w io.Writer) (*Report, error) {
	rep := &Report{}
	var wb Workbook
	if err := json.Unmarshal(jsonData, &wb); err != nil {
		return rep, fmt.Errorf("parse workbook: %w", err)
	}

	f := excelize.NewFile()
	defer f.Close()

	createdSheets := map[string]bool{}
	// Charts are anchored on the sheet they belong to; the values that are OURS
	// (histogram bins, header-less series labels) accumulate into one hidden data
	// sheet, so its column cursor is shared across every sheet.
	aux := &auxSheet{f: f}
	type pendingCharts struct {
		sheetName string
		sheet     Sheet
	}
	var pending []pendingCharts
	var allCharts []Chart

	for sheetIdx, sheet := range wb {
		sheetName := sheet.Name
		if sheetName == "" {
			sheetName = fmt.Sprintf("Sheet%d", sheetIdx+1)
		}

		var idx int
		if sheetIdx == 0 {
			// excelize always starts with "Sheet1" — rename it.
			idx, _ = f.GetSheetIndex("Sheet1")
			if err := f.SetSheetName("Sheet1", sheetName); err != nil {
				return rep, fmt.Errorf("rename sheet: %w", err)
			}
		} else {
			var err error
			idx, err = f.NewSheet(sheetName)
			if err != nil {
				return rep, fmt.Errorf("new sheet %s: %w", sheetName, err)
			}
		}
		createdSheets[sheetName] = true
		_ = idx

		if len(sheet.Charts) > 0 {
			pending = append(pending, pendingCharts{sheetName: sheetName, sheet: sheet})
			allCharts = append(allCharts, sheet.Charts...)
		}

		// Write cells.
		styleCache := map[string]int{}
		for _, cd := range sheet.CellData {
			if cd.V == nil {
				continue
			}
			dc, err := decodeCell(cd.V)
			if err != nil {
				continue
			}

			cellAddr, err := excelize.CoordinatesToCellName(cd.C+1, cd.R+1)
			if err != nil {
				continue
			}

			if dc.formula != "" {
				formula := strings.TrimPrefix(dc.formula, "=")
				if err2 := f.SetCellFormula(sheetName, cellAddr, formula); err2 != nil {
					_ = f.SetCellStr(sheetName, cellAddr, dc.raw)
				}
			} else if dc.isNum {
				_ = f.SetCellFloat(sheetName, cellAddr, dc.numVal, -1, 64)
			} else {
				_ = f.SetCellStr(sheetName, cellAddr, dc.raw)
			}

			// Apply cell style.
			styleKey := fmt.Sprintf("%v|%v|%v|%v|%v|%v",
				dc.style.Bold, dc.style.Italic, dc.style.Underline,
				dc.style.FontSize, dc.style.FontColor, dc.style.BgColor)

			if styleKey != "0|0|0|0||" {
				if _, exists := styleCache[styleKey]; !exists {
					style := &excelize.Style{
						Font: &excelize.Font{},
						Fill: excelize.Fill{},
					}
					if dc.style.Bold == 1 {
						style.Font.Bold = true
					}
					if dc.style.Italic == 1 {
						style.Font.Italic = true
					}
					if dc.style.Underline == 1 {
						style.Font.Underline = "single"
					}
					if dc.style.FontSize > 0 {
						style.Font.Size = float64(dc.style.FontSize)
					}
					if dc.style.FontColor != "" {
						style.Font.Color = strings.TrimPrefix(dc.style.FontColor, "#")
					}
					if dc.style.BgColor != "" {
						style.Fill = excelize.Fill{
							Type:    "pattern",
							Pattern: 1,
							Color:   []string{strings.TrimPrefix(dc.style.BgColor, "#")},
						}
					}
					sid, err2 := f.NewStyle(style)
					if err2 == nil {
						styleCache[styleKey] = sid
					}
				}
				if sid, ok := styleCache[styleKey]; ok {
					_ = f.SetCellStyle(sheetName, cellAddr, cellAddr, sid)
				}
			}
		}

		// Merged cells.
		if sheet.Config.Merge != nil {
			for _, m := range sheet.Config.Merge {
				if m.RS <= 0 {
					m.RS = 1
				}
				if m.CS <= 0 {
					m.CS = 1
				}
				topLeft, _ := excelize.CoordinatesToCellName(m.C+1, m.R+1)
				botRight, _ := excelize.CoordinatesToCellName(m.C+m.CS, m.R+m.RS)
				_ = f.MergeCell(sheetName, topLeft, botRight)
			}
		}

		// Column widths.
		if sheet.Config.Columnlen != nil {
			for colStr, px := range sheet.Config.Columnlen {
				colIdx, err := strconv.Atoi(colStr)
				if err != nil {
					continue
				}
				colName, _ := excelize.ColumnNumberToName(colIdx + 1)
				// Approximate pt: 1 px ≈ 0.75 pt; XLSX column width in chars ≈ pt/7.
				_ = f.SetColWidth(sheetName, colName, colName, px*0.75/7)
			}
		}

		// Row heights.
		if sheet.Config.Rowlen != nil {
			for rowStr, px := range sheet.Config.Rowlen {
				rowIdx, err := strconv.Atoi(rowStr)
				if err != nil {
					continue
				}
				_ = f.SetRowHeight(sheetName, rowIdx+1, px*0.75)
			}
		}
	}

	// Charts LAST: every worksheet a chart's series can reference now exists, and
	// the hidden bookkeeping sheets land after the user's tabs rather than between
	// them.
	for _, p := range pending {
		if err := addCharts(f, p.sheetName, p.sheet, indexCells(p.sheet), rep, aux); err != nil {
			return rep, fmt.Errorf("write charts for %s: %w", p.sheetName, err)
		}
	}
	// The definition sheet is written for EVERY chart — embedded or skipped — so a
	// re-import into Vulos restores the workbook exactly either way.
	if err := writeChartMetaSheet(f, allCharts); err != nil {
		return rep, fmt.Errorf("write chart definitions: %w", err)
	}
	pivotWarning(wb, rep)

	if _, err := f.WriteTo(w); err != nil {
		return rep, fmt.Errorf("write xlsx: %w", err)
	}
	return rep, nil
}

// ─── Import (XLSX → Fortune Sheet) ──────────────────────────────────────────

// ImportXLSX reads an XLSX file from r and returns Fortune Sheet JSON ([]Sheet).
func ImportXLSX(r io.Reader) ([]byte, error) {
	f, err := excelize.OpenReader(r)
	if err != nil {
		return nil, fmt.Errorf("open xlsx: %w", err)
	}
	defer f.Close()

	var wb Workbook

	for _, sheetName := range f.GetSheetList() {
		// Our own bookkeeping sheets are not user data: the definitions sheet comes
		// back as CHARTS (below) and the histogram bins are re-derived on export.
		// Importing them as grids would leak our plumbing into the user's workbook.
		if sheetName == chartMetaSheet || sheetName == chartDataSheet {
			continue
		}
		rows, err := f.GetRows(sheetName)
		if err != nil {
			continue
		}

		var celldata []CellData
		for ri, row := range rows {
			for ci, val := range row {
				if val == "" {
					continue
				}

				// Try formula.
				cellAddr, _ := excelize.CoordinatesToCellName(ci+1, ri+1)
				formula, _ := f.GetCellFormula(sheetName, cellAddr)

				var rawVal json.RawMessage
				if formula != "" {
					obj := map[string]interface{}{
						"f": "=" + formula,
						"m": val,
						"v": val,
					}
					b, _ := json.Marshal(obj)
					rawVal = b
				} else {
					// Try number.
					if n, err2 := strconv.ParseFloat(val, 64); err2 == nil {
						obj := map[string]interface{}{
							"v":  n,
							"m":  val,
							"ct": map[string]string{"fa": "General", "t": "n"},
						}
						b, _ := json.Marshal(obj)
						rawVal = b
					} else {
						obj := map[string]interface{}{
							"v":  val,
							"m":  val,
							"ct": map[string]string{"fa": "General", "t": "s"},
						}
						b, _ := json.Marshal(obj)
						rawVal = b
					}
				}

				celldata = append(celldata, CellData{R: ri, C: ci, V: rawVal})
			}
		}

		// Merge cells.
		merges, _ := f.GetMergeCells(sheetName)
		mergeMap := map[string]struct {
			R  int `json:"r"`
			C  int `json:"c"`
			RS int `json:"rs"`
			CS int `json:"cs"`
		}{}
		for _, mc := range merges {
			startCol, startRow, _ := excelize.CellNameToCoordinates(mc.GetStartAxis())
			endCol, endRow, _ := excelize.CellNameToCoordinates(mc.GetEndAxis())
			key := fmt.Sprintf("%d_%d", startRow-1, startCol-1)
			mergeMap[key] = struct {
				R  int `json:"r"`
				C  int `json:"c"`
				RS int `json:"rs"`
				CS int `json:"cs"`
			}{
				R:  startRow - 1,
				C:  startCol - 1,
				RS: endRow - startRow + 1,
				CS: endCol - startCol + 1,
			}
		}

		sheet := Sheet{
			Name:     sheetName,
			CellData: celldata,
		}
		if len(mergeMap) > 0 {
			b, _ := json.Marshal(map[string]interface{}{"merge": mergeMap})
			_ = json.Unmarshal(b, &sheet.Config)
		}
		wb = append(wb, sheet)
	}

	if wb == nil {
		wb = Workbook{{Name: "Sheet1", CellData: []CellData{}}}
	}

	// Close the round trip: charts we exported come back as live descriptors on the
	// first sheet (where the content model keeps them), not as a mystery grid.
	if charts := readChartMetaSheet(f); len(charts) > 0 {
		wb[0].Charts = charts
	}

	out, err := json.Marshal(wb)
	if err != nil {
		return nil, fmt.Errorf("marshal workbook: %w", err)
	}
	return out, nil
}
