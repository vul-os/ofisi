package handlers

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"vulos-office/backend/billing"
	"vulos-office/backend/storage"
	"vulos-office/backend/updatelog"

	"github.com/gin-gonic/gin"
)

// Per-frame ceilings. A single incremental update must fit inside the P2P
// fabric's per-frame cap once base64-inflated (see src/lib/crdt/ydoc.js
// MAX_UPDATE_BYTES = 128 KiB); we allow a little headroom on the REST path. A
// snapshot is the whole compacted document and may be larger.
const (
	maxUpdateFrameBytes   = 256 * 1024
	maxSnapshotFrameBytes = 8 * 1024 * 1024
)

// UpdateLogHandler serves the per-file append-only CRDT update log
// (GET/POST /api/files/:id/updates). It reuses the SAME per-file ACL as the
// document store: read access to GET, editor to POST. Identity is the
// server-verified requester, never a client header.
type UpdateLogHandler struct {
	log   updatelog.Store
	store storage.Storage
	authz *FileAuthz
}

// NewUpdateLogHandler wires the handler to an update-log store + the shared
// file authorizer. The document store is used only to confirm a file exists.
func NewUpdateLogHandler(log updatelog.Store, store storage.Storage) *UpdateLogHandler {
	return &UpdateLogHandler{log: log, store: store, authz: SharedFileAuthz()}
}

// NewUpdateLogHandlerWithAuthz builds the handler over a caller-supplied
// authorizer (tests share one FileAuthz across the file + update-log handlers).
func NewUpdateLogHandlerWithAuthz(log updatelog.Store, store storage.Storage, authz *FileAuthz) *UpdateLogHandler {
	return &UpdateLogHandler{log: log, store: store, authz: authz}
}

// List returns the snapshot + frames a caller is missing.
//
// GET /api/files/:id/updates[?since=<seq>]
func (h *UpdateLogHandler) List(c *gin.Context) {
	id := c.Param("id")
	// Read access is required (a denied/absent file returns 404 — no existence leak).
	if !h.authz.require(c, id) {
		return
	}
	var since int64
	if raw := strings.TrimSpace(c.Query("since")); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "since must be a non-negative integer"})
			return
		}
		since = n
	}
	log, err := h.log.Load(id, since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, log)
}

// Append adds an opaque CRDT frame to a file's log.
//
// POST /api/files/:id/updates { "kind": "update"|"snapshot", "data": "<base64>", "floor": <seq> }
func (h *UpdateLogHandler) Append(c *gin.Context) {
	id := c.Param("id")
	// Only editors/owners may append (viewers/commenters are read-only).
	if !h.authz.requireEditor(c, id) {
		return
	}
	account := requesterID(c)

	// OFFICE ACCESS GATE: a suspended / office-disabled account may not mutate.
	if d := billing.GateOffice(c.Request.Context(), account); !d.Allowed() {
		c.JSON(d.Code, gin.H{"error": d.Reason})
		return
	}

	var req struct {
		Kind  string `json:"kind"`
		Data  string `json:"data" binding:"required"`
		Floor int64  `json:"floor"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	kind := req.Kind
	if kind == "" {
		kind = updatelog.FrameKindUpdate
	}
	if kind != updatelog.FrameKindUpdate && kind != updatelog.FrameKindSnapshot {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be 'update' or 'snapshot'"})
		return
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(req.Data))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "data must be base64"})
		return
	}
	cap := maxUpdateFrameBytes
	if kind == updatelog.FrameKindSnapshot {
		cap = maxSnapshotFrameBytes
	}
	if len(raw) == 0 || len(raw) > cap {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "frame size out of bounds"})
		return
	}

	frame, err := h.log.Append(id, kind, raw, account, req.Floor)
	if err != nil {
		// A stale snapshot (floor regressed) is a client-reconcilable conflict.
		if strings.Contains(err.Error(), "stale snapshot") {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, storage.ErrRevConflict) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"seq": frame.Seq, "kind": frame.Kind, "floor": frame.Floor})
}
