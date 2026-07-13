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
	r.POST("/v1/documents/:id/collab/presence", h.Presence)
	return r
}

func postPresence(r *gin.Engine, id string, req presenceRequest) *httptest.ResponseRecorder {
	return doReq(r, http.MethodPost, "/v1/documents/"+id+"/collab/presence", req)
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

// --- Op authorship is server-stamped (origin is not an authority claim) ---
//
// The op's PRODUCER IDENTITY must be server-derived (requesterID), never taken
// from the client body — mirroring how presence stamps account_id. The relayed
// op carries a trustworthy `author`; the client-supplied `origin` is only a
// same-tab echo hint. This is the defense against a malicious editor who spoofs
// a victim tab's origin to make the victim drop the op as a false self-echo
// (targeted divergence): even under a spoofed origin, author reveals the true
// producer, and the victim's client keys self-echo on origin AND author.

func TestDocSync_OpAuthorStampedServerSide(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "bob", fileacl.RoleEditor); err != nil {
		t.Fatal(err)
	}

	// Alice subscribes so she receives bob's relayed op frame.
	events, cleanup := startSSE(t, h, "alice", "doc1")
	defer cleanup()
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("doc1") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	// Bob publishes an op but SPOOFS alice's tab origin in the body. Authorship
	// must still be stamped to bob's verified session regardless of the body.
	bob := docSyncRouter(h, "bob", false)
	if w := postOps(bob, "doc1", docSyncOpsRequest{
		Origin: "alice-tab", // spoofed victim origin
		Ops:    []json.RawMessage{insertOp("bob", 1, "x")},
	}); w.Code != http.StatusOK {
		t.Fatalf("bob publish: %d (%s)", w.Code, w.Body.String())
	}

	select {
	case ev := <-events:
		if ev.Type == "ping" {
			ev = <-events
		}
		if ev.Type != "op" || ev.DocID != "doc1" {
			t.Fatalf("unexpected relayed event: %+v", ev)
		}
		// Authorship is SERVER-stamped to the true producer, not the body.
		if ev.Author != "bob" {
			t.Fatalf("op author not server-stamped: got %q, want bob", ev.Author)
		}
		// The spoofed origin is echoed verbatim (a same-tab echo hint only) — it is
		// NOT the authority. A victim keying self-echo on (origin AND author) will
		// see author=bob != its own account and therefore NOT drop this op.
		if ev.Origin != "alice-tab" {
			t.Fatalf("origin should be echoed raw: got %q", ev.Origin)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("alice never received bob's relayed op")
	}
}

// Two different accounts publishing with the SAME client origin still produce
// DISTINCT server authors — a client cannot make its op's identity collide with
// another user's by copying their origin.
func TestDocSync_OpAuthorNoCrossUserCollision(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "bob", fileacl.RoleEditor); err != nil {
		t.Fatal(err)
	}

	// A neutral third editor subscribes to observe both relayed frames.
	if err := acl.ShareWithRole("doc1", "carol", fileacl.RoleEditor); err != nil {
		t.Fatal(err)
	}
	events, cleanup := startSSE(t, h, "carol", "doc1")
	defer cleanup()
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("doc1") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	const sharedOrigin = "shared-tab"
	alice := docSyncRouter(h, "alice", false)
	bob := docSyncRouter(h, "bob", false)
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: sharedOrigin, Ops: []json.RawMessage{insertOp("alice", 1, "a")}}); w.Code != http.StatusOK {
		t.Fatalf("alice publish: %d", w.Code)
	}
	if w := postOps(bob, "doc1", docSyncOpsRequest{Origin: sharedOrigin, Ops: []json.RawMessage{insertOp("bob", 1, "b")}}); w.Code != http.StatusOK {
		t.Fatalf("bob publish: %d", w.Code)
	}

	authors := map[string]bool{}
	waited := time.After(3 * time.Second)
	for len(authors) < 2 {
		select {
		case ev := <-events:
			if ev.Type != "op" {
				continue
			}
			if ev.Origin != sharedOrigin {
				t.Fatalf("origin should be echoed raw: got %q", ev.Origin)
			}
			authors[ev.Author] = true
		case <-waited:
			t.Fatalf("did not observe both authors; got %v", authors)
		}
	}
	if !authors["alice"] || !authors["bob"] {
		t.Fatalf("authors must be the distinct verified producers, got %v", authors)
	}
}

// The /collab/state bootstrap hands the joiner its OWN server-verified identity
// (`you`) so a client can recognize its own op echoes by author (not just the
// forgeable origin). It is the verified session id, never the body.
func TestDocSync_StateIncludesRequesterIdentity(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)
	sw := doReq(alice, http.MethodGet, "/v1/documents/doc1/collab/state", nil)
	if sw.Code != http.StatusOK {
		t.Fatalf("state: expected 200, got %d", sw.Code)
	}
	var resp struct {
		You string `json:"you"`
	}
	if err := json.Unmarshal(sw.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if resp.You != "alice" {
		t.Fatalf("state must carry the requester's verified identity: got %q, want alice", resp.You)
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

// ─── Stream re-authorization: revoked access terminates an OPEN stream ───────
//
// The connect-time ACL check is point-in-time; a share can be REVOKED while the
// SSE stream is held open. Without a periodic re-check the reader keeps every
// op/snapshot/presence frame for the life of the connection (heartbeats keep it
// alive). These tests cover the re-check decision (deterministic, no time) and
// the loop wiring (short injected interval).

// The core decision helper: while access is granted it returns true; once the
// share is un-shared it returns false; and it fails CLOSED on a store error.
// Fully deterministic — no timers, no goroutines.
func TestDocSync_StreamStillAuthorized_Decision(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "vic", fileacl.RoleViewer); err != nil {
		t.Fatal(err)
	}

	// Build a gin context carrying vic's verified identity (no real request).
	ctxFor := func(user string) *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		return c
	}

	// While shared as a viewer, the stream stays authorized.
	if !h.streamStillAuthorized(ctxFor("vic"), "doc1") {
		t.Fatal("viewer with an active share must remain authorized")
	}
	// Revoke vic's share — the next re-check must deny.
	if err := acl.Unshare("doc1", "vic"); err != nil {
		t.Fatal(err)
	}
	if h.streamStillAuthorized(ctxFor("vic"), "doc1") {
		t.Fatal("revoked viewer must NOT remain authorized (confidentiality leak)")
	}
	// A stranger who never had access is likewise denied.
	if h.streamStillAuthorized(ctxFor("mallory"), "doc1") {
		t.Fatal("stranger must not be authorized")
	}
	// The still-authorized owner is unaffected.
	if !h.streamStillAuthorized(ctxFor("alice"), "doc1") {
		t.Fatal("owner must remain authorized")
	}
}

// End-to-end over the real SSE write pump: a subscriber whose access is REVOKED
// mid-stream has its stream terminated on the next re-check tick, while a
// still-authorized subscriber is unaffected. Driven by a short injected
// re-check interval so no real ACL cadence is waited on.
func TestDocSync_RevokedSubscriberStreamTerminated(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	// Drive the re-check fast + deterministically (no real 25s wait).
	h.recheckInterval = 15 * time.Millisecond
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "vic", fileacl.RoleViewer); err != nil {
		t.Fatal(err)
	}

	// vic (viewer) and alice (owner) both hold an open stream on doc1.
	vicEvents, vicCleanup := startSSE(t, h, "vic", "doc1")
	defer vicCleanup()
	aliceEvents, aliceCleanup := startSSE(t, h, "alice", "doc1")
	defer aliceCleanup()

	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("doc1") < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.hub.SubscriberCount("doc1") < 2 {
		t.Fatalf("both streams should be registered, got %d", h.hub.SubscriberCount("doc1"))
	}

	// Revoke vic's share while the stream is open.
	if err := acl.Unshare("doc1", "vic"); err != nil {
		t.Fatal(err)
	}

	// vic's event channel must CLOSE (stream terminated by the re-check) — and
	// alice's must survive. Drain vic until closed (skip any in-flight pings).
	vicClosed := false
	drainDeadline := time.After(3 * time.Second)
	for !vicClosed {
		select {
		case _, open := <-vicEvents:
			if !open {
				vicClosed = true
			}
		case <-drainDeadline:
			t.Fatal("revoked subscriber's stream was NOT terminated on the re-check tick")
		}
	}

	// The still-authorized owner keeps her stream: an op published now reaches her.
	alice := docSyncRouter(h, "alice", false)
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice-tab", Ops: []json.RawMessage{insertOp("alice", 1, "A")}}); w.Code != http.StatusOK {
		t.Fatalf("alice publish: %d (%s)", w.Code, w.Body.String())
	}
	got := false
	waitOp := time.After(3 * time.Second)
	for !got {
		select {
		case ev, open := <-aliceEvents:
			if !open {
				t.Fatal("still-authorized owner's stream was wrongly terminated")
			}
			if ev.Type == "op" && ev.DocID == "doc1" {
				got = true
			}
		case <-waitOp:
			t.Fatal("owner never received the op — her stream was disrupted")
		}
	}
}

// ─── DoS bounds on the op-ingest path (byte caps + per-doc growth ceiling) ───
//
// Before these bounds the only limit was maxOpsPerIngest (an op COUNT). Each op
// was an opaque json.RawMessage with no per-op byte limit, the snapshot had no
// limit, and there was no request-body limit — so one authenticated editor could
// POST multi-MB ops / a giant snapshot (persisted + amplified to every
// subscriber) and could AppendOp forever (unbounded disk).

// An oversized REQUEST BODY is rejected (413) before decode and nothing is
// persisted. Driven with a giant Origin field so the body exceeds the cap.
func TestDocSync_OversizedBodyRejected(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)

	huge := strings.Repeat("a", maxCollabBodyBytes+4096)
	w := postOps(alice, "doc1", docSyncOpsRequest{Origin: huge, Ops: []json.RawMessage{insertOp("alice", 1, "x")}})
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: expected 413, got %d (%s)", w.Code, w.Body.String())
	}
	if state, _ := h.ops.Load("doc1"); state.Seq != 0 || len(state.Ops) != 0 {
		t.Fatalf("oversized body must persist nothing: seq=%d ops=%d", state.Seq, len(state.Ops))
	}
}

// An oversized SINGLE OP is rejected (413) and nothing is persisted (validation
// is a pre-pass, so an oversize op in a batch persists none of the batch).
func TestDocSync_OversizedOpRejected(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)

	bigOp := json.RawMessage(`"` + strings.Repeat("x", maxOpBytes) + `"`) // > maxOpBytes, < body cap
	w := postOps(alice, "doc1", docSyncOpsRequest{
		Origin: "alice",
		// a normal op alongside the oversized one — neither must persist.
		Ops: []json.RawMessage{insertOp("alice", 1, "ok"), bigOp},
	})
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized op: expected 413, got %d (%s)", w.Code, w.Body.String())
	}
	if state, _ := h.ops.Load("doc1"); state.Seq != 0 || len(state.Ops) != 0 {
		t.Fatalf("oversized op must persist nothing (no partial batch): seq=%d ops=%d", state.Seq, len(state.Ops))
	}
}

// An oversized SNAPSHOT is rejected (413) and nothing is persisted.
func TestDocSync_OversizedSnapshotRejected(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)

	bigSnap := json.RawMessage(`"` + strings.Repeat("s", maxSnapBytes) + `"`) // > maxSnapBytes, < body cap
	w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Snap: bigSnap})
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized snapshot: expected 413, got %d (%s)", w.Code, w.Body.String())
	}
	state, _ := h.ops.Load("doc1")
	if len(state.Snap) != 0 {
		t.Fatalf("oversized snapshot must not persist: len(snap)=%d", len(state.Snap))
	}
}

// The per-document op-log ceiling: appending past the bound is refused (409
// "snapshot required"), a snapshot-only request compacts the log (the remedy),
// and ingest resumes afterward. Normal-sized ops within the bound still succeed.
func TestDocSync_PerDocOpCeilingForcesSnapshot(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	h.maxOpsPerDoc = 3 // small, deterministic ceiling
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)

	// A single batch that exceeds the ceiling is refused whole — nothing persists.
	over := []json.RawMessage{insertOp("alice", 1, "a"), insertOp("alice", 2, "b"), insertOp("alice", 3, "c"), insertOp("alice", 4, "d")}
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: over}); w.Code != http.StatusConflict {
		t.Fatalf("over-ceiling batch: expected 409, got %d (%s)", w.Code, w.Body.String())
	}
	if state, _ := h.ops.Load("doc1"); len(state.Ops) != 0 {
		t.Fatalf("over-ceiling batch must persist nothing: ops=%d", len(state.Ops))
	}

	// Fill exactly to the ceiling (3 ops) — succeeds.
	for i := 1; i <= 3; i++ {
		if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", i, "a")}}); w.Code != http.StatusOK {
			t.Fatalf("op %d within ceiling: expected 200, got %d (%s)", i, w.Code, w.Body.String())
		}
	}
	// The next op crosses the ceiling → refused with the actionable 409.
	w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", 4, "d")}})
	if w.Code != http.StatusConflict {
		t.Fatalf("op past ceiling: expected 409, got %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "snapshot required") {
		t.Fatalf("409 body should name the remedy, got %s", w.Body.String())
	}

	// The remedy: a snapshot-only request is always accepted and compacts the log.
	snap, _ := json.Marshal(map[string]any{"nodes": []any{}})
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Snap: snap}); w.Code != http.StatusOK {
		t.Fatalf("snapshot remedy: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if n, _ := h.ops.OpCount("doc1"); n != 0 {
		t.Fatalf("snapshot should compact the op log to 0, got %d", n)
	}
	// Ingest resumes now that the log is compacted.
	if w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", 5, "e")}}); w.Code != http.StatusOK {
		t.Fatalf("post-compaction op: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

// Normal-sized ops are unaffected by the new bounds (regression guard).
func TestDocSync_NormalOpsUnaffectedByBounds(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	alice := docSyncRouter(h, "alice", false)
	w := postOps(alice, "doc1", docSyncOpsRequest{Origin: "alice", Ops: []json.RawMessage{insertOp("alice", 1, "h"), insertOp("alice", 2, "i")}})
	if w.Code != http.StatusOK {
		t.Fatalf("normal ops: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if state, _ := h.ops.Load("doc1"); state.Seq != 2 || len(state.Ops) != 2 {
		t.Fatalf("normal ops must persist: seq=%d ops=%d", state.Seq, len(state.Ops))
	}
}

// ─── Presence (live cursors + roster) — WAVE-COLLAB-PRESENCE ─────────────────
//
// Presence is the CLOUD-path live-cursor/roster relay. Its security contract:
//   - VIEWER+ (a read-only viewer legitimately shows a caret) — unlike op
//     ingest, which is EDITOR-gated.
//   - A stranger (no access) is refused 404 (no existence leak).
//   - The producing account id is STAMPED SERVER-SIDE — a peer cannot spoof
//     another account's roster identity via the body.
//   - No cross-doc leakage: presence fans out strictly per doc id.
//   - Ephemeral: presence is NEVER persisted to the op log.

// A viewer (read-only) MAY publish presence — this is the deliberate difference
// from op ingest (Publish), which a viewer cannot do.
func TestDocSyncPresence_ViewerMayBroadcast(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "vic", fileacl.RoleViewer); err != nil {
		t.Fatal(err)
	}
	vic := docSyncRouter(h, "vic", false)
	w := postPresence(vic, "doc1", presenceRequest{Origin: "vic-tab", DisplayName: "Vic", Color: "#abc"})
	if w.Code != http.StatusOK {
		t.Fatalf("viewer presence: expected 200 (viewer may show a caret), got %d (%s)", w.Code, w.Body.String())
	}
	// Presence must NOT have been persisted — it is ephemeral.
	state, _ := h.ops.Load("doc1")
	if state.Seq != 0 || len(state.Ops) != 0 {
		t.Fatalf("presence leaked into the op log (must be ephemeral): seq=%d ops=%d", state.Seq, len(state.Ops))
	}
}

// A stranger (no ACL grant) is refused 404 on presence — no existence leak, same
// as every other file-scoped read.
func TestDocSyncPresence_StrangerGets404(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	mallory := docSyncRouter(h, "mallory", false)
	w := postPresence(mallory, "doc1", presenceRequest{Origin: "m", DisplayName: "Mallory"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("stranger presence: expected 404, got %d (%s)", w.Code, w.Body.String())
	}
}

// The account id in the relayed presence frame is the VERIFIED session identity,
// never a client-supplied one — a collaborator cannot occupy another account's
// roster slot even if they try to set account_id in the body.
func TestDocSyncPresence_IdentityStampedServerSide(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	if err := acl.ShareWithRole("doc1", "bob", fileacl.RoleEditor); err != nil {
		t.Fatal(err)
	}

	// Alice subscribes so she receives bob's presence frame.
	events, cleanup := startSSE(t, h, "alice", "doc1")
	defer cleanup()
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("doc1") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	// Bob broadcasts presence. Even if a malicious client crafted an account_id
	// in the body, the handler ignores it and stamps requesterID = "bob".
	bob := docSyncRouter(h, "bob", false)
	if w := postPresence(bob, "doc1", presenceRequest{Origin: "bob-tab", DisplayName: "Bob"}); w.Code != http.StatusOK {
		t.Fatalf("bob presence: %d (%s)", w.Code, w.Body.String())
	}

	select {
	case ev := <-events:
		if ev.Type == "ping" {
			ev = <-events
		}
		if ev.Type != "presence" || ev.DocID != "doc1" {
			t.Fatalf("unexpected relayed event: %+v", ev)
		}
		payload, ok := ev.Payload.(map[string]any)
		if !ok {
			t.Fatalf("presence payload not an object: %T", ev.Payload)
		}
		if payload["account_id"] != "bob" {
			t.Fatalf("presence account_id not server-stamped: got %v, want bob", payload["account_id"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("alice never received bob's presence frame")
	}
}

// Presence for docB must not reach a subscriber of docA.
func TestDocSyncPresence_NoCrossDocLeakage(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "docA", "alice")
	seedDoc(t, st, acl, "docB", "alice")

	events, cleanup := startSSE(t, h, "alice", "docA")
	defer cleanup()
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("docA") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	alice := docSyncRouter(h, "alice", false)
	if w := postPresence(alice, "docB", presenceRequest{Origin: "a", DisplayName: "A"}); w.Code != http.StatusOK {
		t.Fatalf("presence docB: %d", w.Code)
	}
	select {
	case ev := <-events:
		if ev.Type == "presence" && ev.DocID == "docB" {
			t.Fatal("docB presence leaked to a docA subscriber (cross-doc leakage)")
		}
	case <-time.After(400 * time.Millisecond):
		// Good — nothing leaked.
	}
}

// A long display name is truncated so a peer cannot inject an unbounded label
// into every other collaborator's roster.
func TestDocSyncPresence_LabelBounded(t *testing.T) {
	h, st, acl, _ := docSyncFixture(t)
	seedDoc(t, st, acl, "doc1", "alice")
	events, cleanup := startSSE(t, h, "alice", "doc1")
	defer cleanup()
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.SubscriberCount("doc1") == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}

	huge := strings.Repeat("x", 5000)
	// Alice broadcasts from a SECOND tab (different origin) so the frame isn't
	// self-echo-filtered on the client — the server itself does no self-filter,
	// so the subscriber receives it regardless; we just assert the bound.
	alice2 := docSyncRouter(h, "alice", false)
	if w := postPresence(alice2, "doc1", presenceRequest{Origin: "other-tab", DisplayName: huge}); w.Code != http.StatusOK {
		t.Fatalf("presence: %d", w.Code)
	}
	select {
	case ev := <-events:
		if ev.Type == "ping" {
			ev = <-events
		}
		payload, _ := ev.Payload.(map[string]any)
		name, _ := payload["display_name"].(string)
		if len(name) > maxPresenceLabelLen {
			t.Fatalf("display name not bounded: len=%d > %d", len(name), maxPresenceLabelLen)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("never received the presence frame")
	}
}

// A hostile colour value (CSS-injection shape) is dropped server-side before it
// reaches the peer's inline-style caret sink; safe shapes pass through.
func TestDocSyncPresence_ColorSanitized(t *testing.T) {
	cases := []struct{ in, want string }{
		{"#f00", "#f00"},
		{"#aabbcc", "#aabbcc"},
		{"hsl(120,65%,50%)", "hsl(120,65%,50%)"},
		{"rebeccapurple", "rebeccapurple"},
		{"red;position:fixed", ""},        // injection dropped
		{"url(http://evil/x)", ""},        // url() dropped
		{"#f00) ; background:url(x)", ""}, // parenthetical injection dropped
		{"", ""},
	}
	for _, tc := range cases {
		if got := safeCSSColor(tc.in); got != tc.want {
			t.Fatalf("safeCSSColor(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
