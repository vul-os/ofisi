package handlers

// spaces_thread_search_test.go — threading endpoints (thread-scoped authz) +
// FTS-backed search through the handler layer.

import (
	"net/http"
	"path/filepath"
	"testing"

	"vulos-office/backend/middleware"
	"vulos-office/backend/models"
	"vulos-office/backend/spaces"

	"github.com/gin-gonic/gin"
)

// sqliteHandler builds a SpacesHandlerExt over a durable SQLite persister (so
// the FTS5 index is active), wired to a verified identity.
func sqliteHandler(t *testing.T) *SpacesHandlerExt {
	t.Helper()
	p, err := spaces.NewSQLitePersister(filepath.Join(t.TempDir(), "spaces.db"))
	if err != nil {
		t.Fatalf("persister: %v", err)
	}
	base := NewSpacesHandlerWithPersister(p)
	return &SpacesHandlerExt{SpacesHandler: base, ext: newSpacesExt(p)}
}

func threadRouter(h *SpacesHandlerExt, user string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.POST("/spaces/channels/:channelId/messages", h.SendMessage)
	r.GET("/spaces/channels/:channelId/threads/:parentId", h.ListThread)
	r.POST("/spaces/channels/:channelId/threads/:parentId/reply", h.ReplyThread)
	r.GET("/spaces/channels/:channelId/search", h.SearchMessages)
	return r
}

// TestThreadReplyAndList — a reply is bound to the path parent; the thread list
// returns the parent + ordered replies.
func TestThreadReplyAndList(t *testing.T) {
	h := sqliteHandler(t)
	alice := threadRouter(h, "alice", false)

	// Post a parent message in the seeded "general" channel.
	w := doReq(alice, http.MethodPost, "/spaces/channels/general/messages",
		models.SendMessageRequest{Body: "thread root"})
	if w.Code != http.StatusCreated {
		t.Fatalf("send parent: %d (%s)", w.Code, w.Body.String())
	}
	var parent models.Message
	mustDecode(t, w, &parent)

	// Reply via the thread endpoint; thread_parent must be bound to the path.
	w = doReq(alice, http.MethodPost, "/spaces/channels/general/threads/"+parent.ID+"/reply",
		models.SendMessageRequest{Body: "a reply", ThreadParent: "forged-other-parent"})
	if w.Code != http.StatusCreated {
		t.Fatalf("reply: %d (%s)", w.Code, w.Body.String())
	}
	var reply models.Message
	mustDecode(t, w, &reply)
	if reply.ThreadParent != parent.ID {
		t.Fatalf("VULN: reply thread_parent=%q (want %q — body value should be ignored)", reply.ThreadParent, parent.ID)
	}

	// Thread list returns parent + reply.
	w = doReq(alice, http.MethodGet, "/spaces/channels/general/threads/"+parent.ID, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list thread: %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		Replies []models.Message `json:"replies"`
	}
	mustDecode(t, w, &resp)
	if len(resp.Replies) != 1 || resp.Replies[0].ID != reply.ID {
		t.Fatalf("thread replies wrong: %+v", resp.Replies)
	}
}

// TestThreadReplyDeniedForNonMember — a non-member of a PRIVATE channel cannot
// reply into its thread (thread-scoped authz uses channel membership).
func TestThreadReplyDeniedForNonMember(t *testing.T) {
	h := sqliteHandler(t)

	// alice creates a private channel and posts a parent message.
	ch, err := h.store.CreateChannel("secret", models.ChannelTypePrivate, "alice")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if _, err := h.store.AddMember(ch.ID, "alice"); err != nil {
		t.Fatalf("add member: %v", err)
	}
	parent, err := h.store.SendMessage(ch.ID, "alice", "private root", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// mallory (non-member) tries to reply → forbidden, and the thread stays empty.
	mallory := threadRouter(h, "mallory", false)
	w := doReq(mallory, http.MethodPost, "/spaces/channels/"+ch.ID+"/threads/"+parent.ID+"/reply",
		models.SendMessageRequest{Body: "intrusion"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: non-member reply returned %d (want 403)", w.Code)
	}
	if replies := h.store.ThreadReplies(ch.ID, parent.ID); len(replies) != 0 {
		t.Fatalf("VULN: non-member reply was persisted (%d replies)", len(replies))
	}

	// mallory also cannot read the private thread.
	w = doReq(mallory, http.MethodGet, "/spaces/channels/"+ch.ID+"/threads/"+parent.ID, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("VULN: non-member thread read returned %d (want 403)", w.Code)
	}
}

// TestSearchUsesFTS — search through the handler returns FTS hits and applies
// the from: operator filter on top.
func TestSearchUsesFTS(t *testing.T) {
	h := sqliteHandler(t)
	if _, err := h.store.AddMember("general", "alice"); err != nil {
		t.Fatalf("add member: %v", err)
	}
	if _, err := h.store.SendMessage("general", "alice", "deployment finished cleanly", ""); err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := h.store.SendMessage("general", "bob", "deployment had an error", ""); err != nil {
		t.Fatalf("send: %v", err)
	}
	if _, err := h.store.SendMessage("general", "alice", "totally unrelated", ""); err != nil {
		t.Fatalf("send: %v", err)
	}

	r := threadRouter(h, "alice", false)
	// Plain term → both deployment messages.
	w := doReq(r, http.MethodGet, "/spaces/channels/general/search?q=deploy", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("search: %d (%s)", w.Code, w.Body.String())
	}
	var hits []models.Message
	mustDecode(t, w, &hits)
	if len(hits) != 2 {
		t.Fatalf("expected 2 FTS hits for 'deploy', got %d", len(hits))
	}

	// from:bob narrows to bob's message only.
	w = doReq(r, http.MethodGet, "/spaces/channels/general/search?q=deploy%20from:bob", nil)
	mustDecode(t, w, &hits)
	if len(hits) != 1 || hits[0].AuthorID != "bob" {
		t.Fatalf("from:bob filter wrong: %+v", hits)
	}
}
