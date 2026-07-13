package handlers

// docsync.go — the server-mediated real-time collaboration transport (WAVE37).
//
//	GET  /v1/documents/:id/collab/stream   → text/event-stream (subscribe, VIEWER+)
//	GET  /v1/documents/:id/collab/state    → JSON late-joiner bootstrap (VIEWER+)
//	POST /v1/documents/:id/collab/ops       → publish CRDT ops (EDITOR+), persist + fan out
//	POST /v1/documents/:id/collab/presence  → publish live presence/cursor (VIEWER+), fan out (ephemeral)
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
//   - PRESENCE (cursor/roster) requires READ — a read-only viewer legitimately
//     shows a caret and appears in the roster, so presence is VIEWER+ (unlike op
//     ingest). The producer's identity is STAMPED SERVER-SIDE from the verified
//     session (requesterID) and is NOT trusted from the request body, so one
//     collaborator cannot spoof another account's name/avatar in the roster.
//     Presence is EPHEMERAL: it is fanned out through the hub but never persisted
//     (a stale cursor is meaningless after the tab closes).
//   - There is no cross-doc leakage: the hub fans out strictly per doc id, and
//     every id is ACL-checked in the handler before Subscribe/Publish/Presence.

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

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

	// recheckInterval is how often an OPEN SSE stream re-authorizes the reader
	// against the live per-document ACL (see Stream). 0 means the default
	// (defaultStreamRecheckInterval). It is a field (not a const) only so tests
	// can drive the re-check cadence deterministically without real waits.
	recheckInterval time.Duration

	// maxOpsPerDoc is the per-document op-log growth ceiling (see Publish). 0
	// means the default (defaultMaxOpsPerDoc). It is a field only so tests can
	// exercise the ceiling with a small bound.
	maxOpsPerDoc int
}

// defaultStreamRecheckInterval bounds how often an open collab SSE stream
// re-checks the per-document READ ACL. The connect-time check (Stream) is not
// enough on its own: a share can be REVOKED while a stream is held open, and
// heartbeats would otherwise keep the now-unauthorized reader receiving every
// op/snapshot/presence frame forever. We re-authorize on this cadence (aligned
// with the heartbeat interval so it is a natural, non-hot tick) and drop the
// stream the moment access is no longer granted. Kept coarse so the ACL store
// is not hammered — the confidentiality window is bounded to one interval.
const defaultStreamRecheckInterval = realtime.HeartbeatInterval

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

	sub := h.hub.Subscribe(requesterID(c), []string{id})
	if sub == nil {
		// Resource cap hit (too many concurrent streams for this account, or the
		// process-wide ceiling). Fail closed with 429 rather than open the stream
		// and let one account exhaust goroutines/memory. The client falls back to
		// /collab/state polling. Mirrors Talk's wave-38 fix.
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many concurrent collab streams"})
		return
	}
	defer sub.Cancel()

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	c.Writer.Flush()

	ctx := c.Request.Context()
	// Periodically RE-AUTHORIZE the open stream: the connect-time ACL check
	// above is a point-in-time grant, but a share can be REVOKED mid-stream.
	// Without this a reader whose access is removed keeps receiving every frame
	// for the life of the connection (heartbeats keep it alive). We re-check on
	// a coarse cadence and drop the stream (unsubscribe via the deferred Cancel
	// + close the SSE) the moment access is no longer granted. Fail CLOSED.
	recheck := time.NewTicker(h.streamRecheckInterval())
	defer recheck.Stop()
	c.Stream(func(w io.Writer) bool {
		select {
		case <-ctx.Done():
			return false
		case <-recheck.C:
			if !h.streamStillAuthorized(c, id) {
				return false // access revoked/errored → terminate the stream
			}
			return true
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

// streamRecheckInterval is the effective cadence for the open-stream ACL
// re-check (see Stream). Tests may set h.recheckInterval to a small value to
// drive the re-check deterministically; production uses the coarse default.
func (h *DocSyncHandler) streamRecheckInterval() time.Duration {
	if h.recheckInterval > 0 {
		return h.recheckInterval
	}
	return defaultStreamRecheckInterval
}

// streamStillAuthorized re-evaluates the per-document READ ACL for an already
// open SSE stream. It returns true only while the requester still has read
// access to the document. It uses canAccess directly (NOT require) because the
// SSE response is already committed with a 200 + event-stream body, so it must
// NOT write a 404 — the caller simply ends the stream when this returns false.
// Fails CLOSED: canAccess already returns false on an ACL-store error, so a
// transient store failure drops the stream rather than leaving a revoked reader
// subscribed. This is the exact same predicate that gated the connect.
func (h *DocSyncHandler) streamStillAuthorized(c *gin.Context, id string) bool {
	return h.authz.canAccess(c, id)
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
	// Hand the joiner its OWN server-verified identity (never persisted, never from
	// the body) so it can identify its own relayed op echoes by matching BOTH the
	// same-tab origin AND this trustworthy author — closing the origin-spoof echo
	// drop even for a pure viewer that never publishes an op. See State docs.
	st.You = requesterID(c)
	c.JSON(http.StatusOK, st)
}

// docSyncOpsRequest is the body for POST /v1/documents/:id/collab/ops.
//
// A batch of CRDT ops (RGA TextOps, wire shape {k,id,p,v,t}) and/or a full CRDT
// snapshot, both opaque to the server. origin is the producing replica/tab id,
// echoed back in the fan-out so the producer can drop its own echo. When snap is
// present it is recorded as the new compaction base (late-joiner bootstrap).
//
// origin is a SAME-TAB self-echo hint ONLY and is NEVER trusted as identity: the
// authoritative producer identity is the SERVER-STAMPED author (= requesterID),
// attached to the relayed op frame (see Publish + realtime.Event.Author). This is
// what prevents an editor who spoofs a victim tab's origin from making the victim
// drop the op as a false echo (targeted-divergence defense) — origin alone can no
// longer be used as an authority claim.
type docSyncOpsRequest struct {
	Origin string            `json:"origin"`
	Ops    []json.RawMessage `json:"ops"`
	Snap   json.RawMessage   `json:"snap,omitempty"`
}

// Maximum ops accepted in a single ingest call — bounds the work one request can
// enqueue (backpressure at the ingest boundary, complementing the hub's
// per-connection drop-slow-consumer).
const maxOpsPerIngest = 512

// Size/growth bounds on the op-ingest path. Before these existed the only bound
// was maxOpsPerIngest (an op COUNT, not a size): each op is an opaque
// json.RawMessage with no per-op byte limit, the snapshot had no limit, and
// there was no request body limit anywhere — so one authenticated editor (every
// user is editor of their own doc) could POST 512 multi-MB ops or a giant
// snapshot (persisted to SQLite and AMPLIFIED to every subscriber) and could
// AppendOp forever (unbounded disk). All three gaps are closed here, fail-closed
// with a clear 413/409.
const (
	// maxCollabBodyBytes caps the whole request body on the op + snapshot
	// endpoint (via http.MaxBytesReader, before JSON decode) so a single request
	// cannot stream an unbounded body into memory. Comfortably fits a legit batch
	// of ops plus a compaction snapshot.
	maxCollabBodyBytes = 4 << 20 // 4 MiB

	// maxOpBytes caps a SINGLE CRDT op's raw bytes. A real RGA TextOp
	// ({k,id,p,v,t}) is tiny; this ceiling is generous while stopping a multi-MB
	// blob from being persisted and fanned out to every subscriber.
	maxOpBytes = 256 << 10 // 256 KiB

	// maxSnapBytes caps a single CRDT snapshot's raw bytes. A snapshot is the
	// compacted whole-document state, so it is larger than one op but must still
	// fit within the request body cap.
	maxSnapBytes = 2 << 20 // 2 MiB

	// defaultMaxOpsPerDoc is the per-document ceiling on the number of ops
	// CURRENTLY in the op log (i.e. after the latest compaction). When the log
	// reaches it, further op ingest is refused with 409 until the client sends a
	// snapshot (which compacts the log), so a doc cannot grow unbounded on disk.
	// A snapshot-only request is always accepted — it is the remedy.
	defaultMaxOpsPerDoc = 20000
)

// maxOpsForDoc is the effective per-document op-log ceiling (see Publish). Tests
// may set h.maxOpsPerDoc to a small value to exercise the ceiling.
func (h *DocSyncHandler) maxOpsForDoc() int {
	if h.maxOpsPerDoc > 0 {
		return h.maxOpsPerDoc
	}
	return defaultMaxOpsPerDoc
}

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

	// Body cap (fail closed): bound the whole request body BEFORE decoding so a
	// single request cannot stream an unbounded body into memory. MaxBytesReader
	// makes the decode fail with *http.MaxBytesError once the cap is exceeded.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxCollabBodyBytes)

	var req docSyncOpsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.Ops) > maxOpsPerIngest {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "too many ops in one request"})
		return
	}

	// Size + growth validation, done in a PRE-PASS so nothing is persisted or
	// fanned out if any bound is exceeded (no partial-persist on an oversize
	// batch). Count only non-empty ops (empty ones are skipped on append).
	nOps := 0
	for _, op := range req.Ops {
		if len(op) == 0 {
			continue
		}
		if len(op) > maxOpBytes {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "op exceeds maximum size"})
			return
		}
		nOps++
	}
	if len(req.Snap) > maxSnapBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "snapshot exceeds maximum size"})
		return
	}
	// Per-document growth ceiling: refuse to append past the op-log bound so a
	// doc cannot grow unbounded on disk. A snapshot-only request (nOps == 0) is
	// always allowed — it is the compaction remedy the client must send. The
	// client should react to this 409 by snapshotting + retrying.
	if nOps > 0 {
		cur, err := h.ops.OpCount(id)
		if err != nil {
			log.Printf("[docsync] op count doc=%s: %v", id, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check op log size"})
			return
		}
		if cur+nOps > h.maxOpsForDoc() {
			c.JSON(http.StatusConflict, gin.H{"error": "op log full — snapshot required"})
			return
		}
	}

	origin := req.Origin
	// author is the SERVER-derived identity of the producer, taken from the
	// verified session and NEVER from the request body (mirrors how Presence
	// stamps account_id). It is the trustworthy authorship carried on every
	// relayed op: origin above is only a same-tab echo hint the client cannot be
	// allowed to weaponize (an editor who spoofs a victim tab's origin still
	// cannot forge who published the op, so the victim will not drop it as a false
	// self-echo). See realtime.Event.Author.
	author := requesterID(c)

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
			Author:  author,
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

// presenceRequest is the body for POST /v1/documents/:id/collab/presence.
//
// It carries the sender's live cursor/selection and a display label so other
// collaborators can render "who is here" (avatars) and "where they are"
// (carets/selection). The identity is display-only and is re-derived from the
// verified session on the server; the client-supplied accountId is ignored for
// authority (it is only echoed for the sender's OWN tab colour stability).
type presenceRequest struct {
	Origin      string          `json:"origin"`                 // sending tab/replica id (self-echo filter)
	DisplayName string          `json:"display_name,omitempty"` // human label shown in the roster
	Color       string          `json:"color,omitempty"`        // caret/avatar colour (cosmetic)
	Cursor      json.RawMessage `json:"cursor,omitempty"`       // opaque {type,from,to,slideId?} — client-shaped
	Gone        bool            `json:"gone,omitempty"`         // true when the sender is leaving (roster removal)
}

// maxPresenceLabelLen bounds the display name so a peer cannot inject a huge
// label into every other collaborator's roster (a light abuse/DoS bound; the
// label is also sanitized/escaped client-side before render).
const maxPresenceLabelLen = 80

// Presence relays a collaborator's live cursor/selection + roster identity to
// the other authorized viewers of a document. It requires READ access only —
// a read-only viewer legitimately shows a caret and appears in the roster (this
// is the deliberate difference from Publish, which is EDITOR-gated). Presence is
// EPHEMERAL: it is fanned out through the hub but never written to the op log,
// so nothing about a transient cursor position is persisted.
//
// The producing account id is STAMPED from the verified session — the request
// body cannot set it — so a collaborator cannot impersonate another account in
// the roster. Only the cosmetic label/colour/cursor come from the body.
func (h *DocSyncHandler) Presence(c *gin.Context) {
	id := c.Param("id")
	// READ gate: 404 on no access (no existence leak), same as the SSE stream.
	// A viewer is allowed — read-only collaborators still show presence.
	if !h.authz.require(c, id) {
		return
	}
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}

	var req presenceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	label := req.DisplayName
	if len(label) > maxPresenceLabelLen {
		label = label[:maxPresenceLabelLen]
	}

	// Cursor payload is opaque but bounded — a peer must not be able to push an
	// unbounded blob into every other collaborator's memory via the roster.
	cursor := req.Cursor
	if len(cursor) > maxPresenceCursorLen {
		cursor = nil
	}

	// Server-authoritative identity: the roster key is the VERIFIED account id,
	// never a client-supplied one, so a peer cannot claim another account's
	// presence slot. The label/colour are cosmetic and come from the body — the
	// colour is validated to a safe CSS-colour shape (defense in depth: it is
	// rendered into an inline `background` style on the peer's caret, and a raw
	// value like `url(...)` must never reach that sink).
	h.hub.Publish(realtime.Event{
		Type:   "presence",
		DocID:  id,
		Origin: req.Origin,
		Payload: gin.H{
			"account_id":   requesterID(c),
			"display_name": label,
			"color":        safeCSSColor(req.Color),
			"cursor":       cursor,
			"gone":         req.Gone,
		},
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// maxPresenceCursorLen bounds the opaque cursor payload (a small {type,from,to}
// object in practice) so a peer cannot broadcast a huge blob to every viewer.
const maxPresenceCursorLen = 512

// safeCSSColor returns c only if it matches a conservative CSS-colour shape:
// #rgb / #rrggbb / #rrggbbaa hex, or an hsl()/hsla()/rgb()/rgba() functional
// form, or a short bare name (letters only). Anything else — notably a value
// containing url(), parentheses in the wrong place, semicolons, or other CSS
// injection vectors — is dropped to "" so the client falls back to its default
// colour. Cosmetic field; failing closed costs nothing.
func safeCSSColor(c string) string {
	if c == "" || len(c) > 40 {
		return ""
	}
	if presenceColorRe.MatchString(c) {
		return c
	}
	return ""
}

var presenceColorRe = regexp.MustCompile(`^(#[0-9a-fA-F]{3,8}|(?:hsl|hsla|rgb|rgba)\([0-9,.%\s]+\)|[a-zA-Z]{1,20})$`)
