// export_warnings.go — the channel by which a LOSSY export tells the caller.
//
// An export is a binary attachment, so there is no JSON body to put a warning in.
// The channel is therefore the response headers, and every export endpoint sets
// them:
//
//	X-Export-Fidelity: full | degraded
//	X-Export-Warnings: ["…","…"]      (JSON array; present only when degraded)
//
// This exists because all three server exporters used to lose content SILENTLY —
// charts, images, tables, whole slide objects — and return 200 as though nothing
// had happened. The public /v1 developer API is the main consumer of these
// endpoints, and an API that quietly drops your data is worse than one that refuses
// it. If a path cannot carry something, the caller is told.
//
// Header safety: each warning is already single-line and control-stripped at the
// source (see each service's sanitizeWarning), and it is JSON-encoded here — so a
// hostile document's text cannot inject a header (CRLF) or break the value.
package handlers

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	headerFidelity = "X-Export-Fidelity"
	headerWarnings = "X-Export-Warnings"

	// A header value must stay well under any proxy's limit; warnings beyond this
	// are truncated (with a final entry saying so) rather than dropped in silence.
	maxWarningsHeaderBytes = 3500
)

// setExportWarnings puts the fidelity of an export on the response.
//
// warnings == nil (or empty) ⇒ the file carries everything ⇒ "full".
func setExportWarnings(c *gin.Context, warnings []string) {
	if len(warnings) == 0 {
		c.Header(headerFidelity, "full")
		return
	}

	// Defence in depth: strip anything that could split a header, whatever the
	// service handed us.
	clean := make([]string, 0, len(warnings))
	for _, w := range warnings {
		w = strings.Map(func(r rune) rune {
			if r == '\r' || r == '\n' {
				return ' '
			}
			if r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}, w)
		if w = strings.TrimSpace(w); w != "" {
			clean = append(clean, w)
		}
	}
	if len(clean) == 0 {
		c.Header(headerFidelity, "full")
		return
	}

	// Fit the JSON array into the header budget, keeping whole warnings.
	for len(clean) > 0 {
		b, err := json.Marshal(clean)
		if err != nil {
			c.Header(headerFidelity, "degraded")
			return
		}
		if len(b) <= maxWarningsHeaderBytes {
			c.Header(headerFidelity, "degraded")
			c.Header(headerWarnings, string(b))
			return
		}
		clean = clean[:len(clean)-1]
		if len(clean) > 0 {
			clean[len(clean)-1] = "…and further warnings were truncated."
		}
	}
	c.Header(headerFidelity, "degraded")
}
