package handlers

// docsync.go — the server-mediated real-time collaboration transport (WAVE37).
//
//	GET  /v1/documents/:id/collab/stream   → text/event-stream (subscribe, VIEWER+)
//	GET  /v1/documents/:id/collab/state    → JSON late-joiner bootstrap (VIEWER+)
//	POST /v1/documents/:id/collab/ops       → publish CRDT ops (EDITOR+), persist + fan out
//
// This is the CLOUD / account collaboration path. It complements the existing
// peer-to-peer fabric (E2E-encrypted, room-gated — wave-25) rather than
// replacing it: when no p2p peer is reachable (no relay, no WebRTC), two editors
// on the account path still converge and the document stays saved, because their
// CRDT ops flow through this server hub, are persisted authoritatively (see
// backend/docsync), and are relayed to the other authorized editors. A late
// joiner GETs /collab/state to catch up to current state from the server.
//
// The p2p path is E2E-encrypted and is deliberately NOT routed through this
// readable server — only the account/cloud path uses the hub. See the client
// wiring in src/apps/docs/useServerCollab.js.
//
// Transport: Server-Sent Events (server→client push) + authenticated REST POST
// (client→server op ingest). Same rationale as Vulos Talk's WAVE36 stream — no
// new dependency (gin-contrib/sse already present), rides the same /v1 auth
// (session cookie or vk_ API key), one-directional per leg.
//
// AuthZ (mirrors the wave-14 editor-gated writes / viewer<editor<owner ACL):
//   - SUBSCRIBE (SSE) and STATE (bootstrap) require READ access — a viewer may
//     receive ops but not push them (read-only collaboration).
//   - PUBLISH (op ingest) requires EDITOR — reuses FileAuthz.requireEditor, the
//     SAME gate that guards PATCH /v1/documents/:id. A viewer/commenter POSTing
//     an op is rejected 403, exactly as the wave-14 requireEditor gate demands.
//   - There is no cross-doc leakage: the hub fans out strictly per doc id, and
//     every id is ACL-checked in the handler before Subscribe/Publish.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"vulos-office/backend/docsync"
	"vulos-office/backend/realtime"
	"vulos-office/backend/storage"

	"github.com/gin-gonic/gin"
)

// DocSyncHandler owns the realtime hub + the authoritative op-log store for the
// server-mediated collaboration path. It shares the same FileAuthz + Storage as
// the /v1 document handlers so the ACL and the document lifecycle stay in sync.
type DocSyncHandler struct {
	store storage.Storage
	authz *FileAuthz
	ops   docsync.Store
	hub   *realtime.Hub
}

// NewDocSyncHandler builds the handler over the shared storage + authorizer, a
// durable op-log store, and a fresh realtime hub. When ops is nil an in-memory
// NullStore is used (degraded: relay still works, op log does not persist across
// restart) so the app always boots.
func NewDocSyncHandler(store storage.Storage, ops docsync.Store) *DocSyncHandler {
	if ops == nil {
		ops = docsync.NewNullStore()
	}
	return &DocSyncHandler{
		store: store,
		authz: SharedFileAuthz(),
		ops:   ops,
		hub:   realtime.NewHub(),
	}
}

// NewDocSyncHandlerWithDeps builds a handler over caller-supplied deps (tests).
func NewDocSyncHandlerWithDeps(store storage.Storage, authz *FileAuthz, ops docsync.Store, hub *realtime.Hub) *DocSyncHandler {
	if ops == nil {
		ops = docsync.NewNullStore()
	}
	if hub == nil {
		hub = realtime.NewHub()
	}
	return &DocSyncHandler{store: store, authz: authz, ops: ops, hub: hub}
}

// Hub exposes the realtime broker (tests / metrics).
func (h *DocSyncHandler) Hub() *realtime.Hub { return h.hub }

// Store exposes the op-log store (tests / the /v1 delete path so a deleted
// document's op log is cleaned up).
func (h *DocSyncHandler) Store() docsync.Store { return h.ops }

// Stream serves the per-document SSE event stream. Requires READ access to the
// document (viewer or above). A viewer receives relayed ops but may not publish
// (see Publish, which requires editor).
func (h *DocSyncHandler) Stream(c *gin.Context) {
	id := c.Param("id")
	// READ gate: 404 on no access (no existence leak), same as GET content.
	if !h.authz.require(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}

	sub := h.hub.Subscribe([]string{id})
	defer sub.Cancel()

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	c.Writer.Flush()

	ctx := c.Request.Context()
	c.Stream(func(w io.Writer) bool {
		select {
		case <-ctx.Done():
			return false
		case frame, open := <-sub.Frames:
			if !open {
				return false // dropped (slow consumer) or hub closed
			}
			_, _ = w.Write([]byte("data: "))
			_, _ = w.Write(frame)
			_, _ = w.Write([]byte("\n\n"))
			return true
		}
	})
}

// State returns the current authoritative CRDT state (latest snapshot + trailing
// ops) so a late joiner catches up to what the server holds even with zero p2p
// peers. Requires READ access.
func (h *DocSyncHandler) State(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}
	st, err := h.ops.Load(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load collab state"})
		return
	}
	c.JSON(http.StatusOK, st)
}

// docSyncOpsRequest is the body for POST /v1/documents/:id/collab/ops.
//
// A batch of CRDT ops (RGA TextOps, wire shape {k,id,p,v,t}) and/or a full CRDT
// snapshot, both opaque to the server. origin is the producing replica/tab id,
// echoed back in the fan-out so the producer can drop its own echo. When snap is
// present it is recorded as the new compaction base (late-joiner bootstrap).
type docSyncOpsRequest struct {
	Origin string            `json:"origin"`
	Ops    []json.RawMessage `json:"ops"`
	Snap   json.RawMessage   `json:"snap,omitempty"`
}

// Maximum ops accepted in a single ingest call — bounds the work one request can
// enqueue (backpressure at the ingest boundary, complementing the hub's
// per-connection drop-slow-consumer).
const maxOpsPerIngest = 512

// Publish ingests CRDT ops from an editor: it persists each op authoritatively
// (assigning a monotonic per-doc sequence), then relays it to every live
// subscriber of the document via the hub. Requires EDITOR access — the SAME gate
// as PATCH /v1/documents/:id — so a viewer/commenter cannot push ops.
func (h *DocSyncHandler) Publish(c *gin.Context) {
	id := c.Param("id")
	// EDITOR gate: viewers/commenters are read-only (404 no-access / 403 viewer).
	if !h.authz.requireEditor(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}

	var req docSyncOpsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.Ops) > maxOpsPerIngest {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "too many ops in one request"})
		return
	}

	origin := req.Origin

	// Persist + relay each op. Persistence is authoritative: an op is durable
	// before it is relayed, so a late joiner GETting /collab/state always sees
	// what live subscribers saw.
	accepted := 0
	var lastSeq uint64
	for _, op := range req.Ops {
		if len(op) == 0 {
			continue
		}
		seq, err := h.ops.AppendOp(id, origin, op)
		if err != nil {
			log.Printf("[docsync] append op doc=%s: %v", id, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to persist op"})
			return
		}
		lastSeq = seq
		accepted++
		h.hub.Publish(realtime.Event{
			Type:    "op",
			DocID:   id,
			Origin:  origin,
			Seq:     seq,
			Payload: op,
		})
	}

	// Optional snapshot: record as the new compaction base for late joiners.
	if len(req.Snap) > 0 {
		if seq, err := h.ops.SaveSnapshot(id, origin, req.Snap); err != nil {
			log.Printf("[docsync] save snapshot doc=%s: %v (ignoring — ops are primary)", id, err)
		} else if seq > lastSeq {
			lastSeq = seq
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "accepted": accepted, "seq": lastSeq})
}
