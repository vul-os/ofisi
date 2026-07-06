package handlers

// docsync_test.go — WAVE37 server-mediated collaboration tests.
//
// Covers: viewer cannot publish (403); editor may publish (persist + relay);
// two editors converge via the server op log; a late joiner gets current state
// from /collab/state; ACL gating (non-collaborator 404, no cross-doc leakage);
// dedup (server assigns monotonic seq; re-relayed ops carry their id so the
// client CRDT dedups); graceful degrade (NullStore still relays + persists in
// memory). The SSE stream itself is exercised over the hub in hub_test.go; here
// the handler paths that gate + persist + fan out are exercised via /ops and
// /state, which is where the authz + persistence semantics live.

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vulos-office/backend/docsync"
	"vulos-office/backend/fileacl"
	"vulos-office/backend/middleware"
	"vulos-office/backend/models"
	"vulos-office/backend/realtime"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// docSyncFixture builds a DocSyncHandler over in-memory storage + a multi-tenant
// (auth-enabled) ACL store so the viewer<editor<owner roles are enforced.
func docSyncFixture(t *testing.T) (*DocSyncHandler, *memStorage, fileacl.Store, docsync.Store) {
	t.Helper()
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthzWithAuth(acl, true) // multi-tenant: enforce roles
	ops := docsync.NewNullStore()
	h := NewDocSyncHandlerWithDeps(st, authz, ops, realtime.NewHub())
	return h, st, acl, ops
}

// docSyncRouter wires the collab routes with a verified identity injected,
// mirroring the real /v1 registration (reads then ops).
func docSyncRouter(h *DocSyncHandler, user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.GET("/v1/documents/:id/collab/stream", h.Stream)
	r.GET("/v1/documents/:id/collab/state", h.State)
	r.POST("/v1/documents/:id/collab/ops", h.Publish)
	return r
}

// seedDoc creates a document owned by `owner` in storage + ACL.
func seedDoc(t *testing.T, st *memStorage, acl fileacl.Store, id, owner string) {
	t.Helper()
	if err := st.CreateFile(&models.File{ID: id, Name: "doc", Type: models.FileTypeDoc}); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if err := acl.SetOwner(id, owner); err != nil {
		t.Fatalf("seed owner: %v", err)
	}
}

// insertOp builds an RGA-style TextOp payload (opaque to the server).
func insertOp(replica string, counter int, ch string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"k":  1,
		"id": map[string]any{"r": replica, "c": counter},
		"p":  map[string]any{"r": "", "c": 0},
		"v":  int([]rune(ch)[0]),
	})
	return b
}

func postOps(r *gin.Engine, id string, req docSyncOpsRequest) *httptest.ResponseRecorder {
	return doReq(r, http.MethodPost, "/v1/documents/"+id+"/collab/ops", req)
}

// --- ACL: viewer cannot publish ------------------------------------------

func TestDocSync_ViewerCannotPublishOps(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "vic", fileacl.RoleViewer); err != nil {
		t.Fatal(err)
	}

	vic := docSyncRouter(h, "vic", false)
	w := postOps(vic, "doc1", docSyncOpsRequest{Origin: "vic-tab", Ops: []json.RawMessage{insertOp("vic", 1, "x")}})
	if w.Code != http.StatusForbidden {
		t.Fatalf("viewer publish: expected 403, got %d (%s)", w.Code, w.Body.String())
	}
	// The rejected op must NOT have been persisted.
	stState, _ := h.ops.Load("doc1")
	if stState.Seq != 0 || len(stState.Ops) != 0 {
		t.Fatalf("viewer's rejected op leaked into the op log: seq=%d ops=%d", stState.Seq, len(stState.Ops))
	}
}

func TestDocSync_CommenterCannotPublishOps(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "carl", fileacl.RoleCommenter); err != nil {
		t.Fatal(err)
	}
	carl := docSyncRouter(h, "carl", false)
	w := postOps(carl, "doc1", docSyncOpsRequest{Origin: "carl", Ops: []json.RawMessage{insertOp("carl", 1, "y")}})
	if w.Code != http.StatusForbidden {
		t.Fatalf("commenter publish: expected 403, got %d (%s)", w.Code, w.Body.String())
	}
}

// --- ACL: non-collaborator gets 404 (no existence leak) ------------------

func TestDocSync_StrangerGets404(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")

	mallory := docSyncRouter(h, "mallory", false)
	// State (read) → 404, not 403, no existence leak.
	if w := doReq(mallory, http.MethodGet, "/v1/documents/doc1/collab/state", nil); w.Code != http.StatusNotFound {
		t.Fatalf("stranger state: expected 404, got %d", w.Code)
	}
	// Publish → 404 (require inside requireEditor denies at the access layer first).
	if w := postOps(mallory, "doc1", docSyncOpsRequest{Ops: []json.RawMessage{insertOp("m", 1, "z")}}); w.Code != http.StatusNotFound {
		t.Fatalf("stranger publish: expected 404, got %d", w.Code)
	}
}

// --- Editor may publish; state is persisted authoritatively --------------

func TestDocSync_EditorPublishesAndPersists(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")

	alice := docSyncRouter(h, "alice", false)
	w := postOps(alice, "doc1", docSyncOpsRequest{
		Origin: "alice-tab",
		Ops:    []json.RawMessage{insertOp("alice", 1, "h"), insertOp("alice", 2, "i")},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("owner publish: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Accepted int    `json:"accepted"`
		Seq      uint64 `json:"seq"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Accepted != 2 || resp.Seq != 2 {
		t.Fatalf("expected accepted=2 seq=2, got accepted=%d seq=%d", resp.Accepted, resp.Seq)
	}

	// A shared editor GETs current state → sees both ops in sequence order.
	if err := acl.ShareWithRole("doc1", "bob", fileacl.RoleEditor); err != nil {
		t.Fatal(err)
	}
	bob := docSyncRouter(h, "bob", false)
	sw := doReq(bob, http.MethodGet, "/v1/documents/doc1/collab/state", nil)
	if sw.Code != http.StatusOK {
		t.Fatalf("editor state: expected 200, got %d", sw.Code)
	}
	var state docsync.State
	if err := json.Unmarshal(sw.Body.Bytes(), &state); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if state.Seq != 2 || len(state.Ops) != 2 {
		t.Fatalf("late-joiner state: expected seq=2 ops=2, got seq=%d ops=%d", state.Seq, len(state.Ops))
	}
	if state.Ops[0].Seq != 1 || state.Ops[1].Seq != 2 {
		t.Fatalf("ops not in sequence order: %d, %d", state.Ops[0].Seq, state.Ops[1].Seq)
	}
}

// --- Two editors converge via the server relay (SSE fan-out) -------------

// startSSE opens the SSE stream as `user` against an httptest server (exercising
// the real gin c.Stream write pump) and returns a channel of parsed
// realtime.Event frames plus a single cleanup func. Cleanup MUST cancel the
// request context BEFORE closing the server: an open SSE stream keeps the
// handler running (it only returns on ctx.Done), so closing the server first
// would block forever. Cancelling closes the client connection → the server's
// c.Request.Context() is Done → the handler returns → srv.Close() completes.
func startSSE(t *testing.T, h *DocSyncHandler, user, docID string) (<-chan realtime.Event, func()) {
	t.Helper()
	r := docSyncRouter(h, user, false)
	srv := httptest.NewServer(r)

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/v1/documents/"+docID+"/collab/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		srv.Close()
		t.Fatalf("open SSE: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		cancel()
		srv.Close()
		t.Fatalf("SSE status: expected 200, got %d", resp.StatusCode)
	}
	events := make(chan realtime.Event, 32)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer resp.Body.Close()
		defer close(events)
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev realtime.Event
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev); err != nil {
				continue
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	cleanup := func() {
		cancel()    // close the client connection → server handler observes ctx.Done
		<-done      // wait for the reader goroutine to finish (body closed)
		srv.Close() // now safe — no in-flight request holds the server
	}
	return events, cleanup
}

func TestDocSync_TwoEditorsConvergeViaServer(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "bob", fileacl.RoleEditor); err != nil {
		t.Fatal(err)
	}

	// Bob subscribes to the SSE stream.
	events, cleanup := startSSE(t, h, "bob", "doc1")
	defer cleanup()

	// Give the subscription a moment to register on the hub.
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("doc1") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.hub.SubscriberCount("doc1") == 0 {
		t.Fatal("bob's SSE subscription never registered on the hub")
	}

	// Alice publishes an op.
	alice := docSyncRouter(h, "alice", false)
	op := insertOp("alice", 1, "A")
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice-tab", Ops: []json.RawMessage{op}}); w.Code != http.StatusOK {
		t.Fatalf("alice publish: %d (%s)", w.Code, w.Body.String())
	}

	// Bob receives it over the server relay.
	select {
	case ev := <-events:
		// Skip an initial ping if present.
		if ev.Type == "ping" {
			ev = <-events
		}
		if ev.Type != "op" || ev.DocID != "doc1" || ev.Origin != "alice-tab" {
			t.Fatalf("unexpected relayed event: %+v", ev)
		}
		if ev.Seq != 1 {
			t.Fatalf("relayed op seq: expected 1, got %d", ev.Seq)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("bob never received alice's op over the server relay")
	}
}

// --- No cross-doc leakage ------------------------------------------------

func TestDocSync_NoCrossDocLeakage(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "docA", "alice")
	seedDoc(t, st, acl, "docB", "alice")

	// Bob subscribes to docA only.
	events, cleanup := startSSE(t, h, "alice", "docA")
	defer cleanup()
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("docA") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	// Alice publishes to docB — the docA subscriber must NOT receive it.
	alice := docSyncRouter(h, "alice", false)
	if w := postOps(alice, "docB", docSyncOpsRequest{Origin: "a", Ops: []json.RawMessage{insertOp("a", 1, "B")}}); w.Code != http.StatusOK {
		t.Fatalf("publish docB: %d", w.Code)
	}
	select {
	case ev := <-events:
		if ev.Type == "op" && ev.DocID == "docB" {
			t.Fatal("docB op leaked to a docA subscriber (cross-doc leakage)")
		}
	case <-time.After(400 * time.Millisecond):
		// Good — nothing leaked (a ping may or may not arrive; either is fine).
	}
}

// --- DoS: per-user connection cap on the SSE stream (wave-38 parity) ------

// TestDocSync_StreamPerUserCap429 proves the Stream handler fails CLOSED with 429
// once an account is at the hub's per-user connection ceiling (MaxConnsPerUser),
// rather than opening an unbounded number of goroutine/memory-pinning streams.
// The hub is pre-filled to the cap for the requesting account (same owner id the
// handler derives from the session), then a real HTTP GET on /collab/stream must
// be refused. This is the gap Talk closed in wave-38 and that this hub lacked.
func TestDocSync_StreamPerUserCap429(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")

	// Saturate alice's per-user connection budget directly on the hub. The owner
	// id must match what requesterID(c) derives for the "alice" session.
	for i := 0; i < realtime.MaxConnsPerUser; i++ {
		if s := h.hub.Subscribe("alice", []string{"doc1"}); s == nil {
			t.Fatalf("pre-fill Subscribe refused early at %d", i)
		}
	}

	r := docSyncRouter(h, "alice", false)
	srv := httptest.NewServer(r)
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/documents/doc1/collab/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("over-cap stream: expected 429, got %d", resp.StatusCode)
	}
}

// --- Dedup: server assigns monotonic seq; op payload carries its id ------

func TestDocSync_MonotonicSeqAndOpIdentityPreserved(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)

	op1 := insertOp("alice", 1, "a")
	postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{op1}})
	op2 := insertOp("alice", 2, "b")
	postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{op2}})

	state, _ := h.ops.Load("doc1")
	if len(state.Ops) != 2 {
		t.Fatalf("expected 2 persisted ops, got %d", len(state.Ops))
	}
	if state.Ops[0].Seq >= state.Ops[1].Seq {
		t.Fatalf("sequences not monotonic: %d, %d", state.Ops[0].Seq, state.Ops[1].Seq)
	}
	// The op id survives round-trip verbatim, so a client CRDT can dedup by op id
	// (TextCRDT.apply is idempotent on the {r,c} OpID).
	var decoded map[string]any
	_ = json.Unmarshal(state.Ops[0].Op, &decoded)
	idObj, _ := decoded["id"].(map[string]any)
	if idObj == nil || idObj["r"] != "alice" || idObj["c"].(float64) != 1 {
		t.Fatalf("op id not preserved verbatim: %v", decoded)
	}
}

// --- Late joiner gets snapshot + trailing ops; compaction works ----------

func TestDocSync_LateJoinerGetsSnapshotAndTrailingOps(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)

	// Publish some ops, then a snapshot (compaction base), then one more op.
	postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", 1, "a"), insertOp("alice", 2, "b")}})
	snap, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": map[string]any{"r": "alice", "c": 1}, "v": 97}}})
	postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Snap: snap})
	postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", 3, "c")}})

	bob := docSyncRouter(h, "alice", false) // alice re-joins in a new tab
	sw := doReq(bob, http.MethodGet, "/v1/documents/doc1/collab/state", nil)
	var state docsync.State
	_ = json.Unmarshal(sw.Body.Bytes(), &state)
	if len(state.Snap) == 0 {
		t.Fatal("late joiner did not receive a compaction snapshot")
	}
	// Ops folded into the snapshot (seq<=2) are compacted away; only seq=3 remains.
	if len(state.Ops) != 1 || state.Ops[0].Seq != 3 {
		t.Fatalf("expected only the post-snapshot op (seq=3), got %d ops: %+v", len(state.Ops), state.Ops)
	}
}

// --- Graceful degrade: NullStore still relays + persists in memory -------

func TestDocSync_NullStoreDegradesGracefully(t *testing.T) {
	// docSyncFixture already uses a NullStore. Prove a full publish→state cycle
	// works with no SQLite backing (the "no durable store" degraded path).
	h, st, acl, ops := docSyncFixture(t)
	if _, isNull := ops.(*docsync.NullStore); !isNull {
		t.Fatal("fixture should use the in-memory NullStore")
	}
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", 1, "a")}}); w.Code != http.StatusOK {
		t.Fatalf("degraded publish: %d", w.Code)
	}
	state, _ := ops.Load("doc1")
	if state.Seq != 1 || len(state.Ops) != 1 {
		t.Fatalf("degraded persistence failed: seq=%d ops=%d", state.Seq, len(state.Ops))
	}
}
