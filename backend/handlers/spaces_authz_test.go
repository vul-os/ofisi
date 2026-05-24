package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"vulos-office/backend/middleware"
	"vulos-office/backend/models"
	"vulos-office/backend/spaces"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// testHandler builds a SpacesHandlerExt over an in-memory NullPersister so the
// tests never touch disk.
func testHandler(t *testing.T) *SpacesHandlerExt {
	t.Helper()
	return &SpacesHandlerExt{
		SpacesHandler: NewSpacesHandlerWithPersister(spaces.NewNullPersister()),
		ext:           newSpacesExt(),
	}
}

// ctxWith injects a verified identity (as middleware.Auth would) and optionally
// a forged X-Account-ID header to prove it is ignored.
func newRequest(method, path, account, forgedHeader string, body interface{}) (*http.Request, *httptest.ResponseRecorder) {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if forgedHeader != "" {
		req.Header.Set("X-Account-ID", forgedHeader)
	}
	return req, httptest.NewRecorder()
}

// router builds a gin engine that injects the given verified identity into the
// context before dispatching to the handler routes.
func router(h *SpacesHandlerExt, verifiedUser string, admin bool) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, verifiedUser)
		if admin {
			c.Set(middleware.CtxIsAdmin, true)
		}
		c.Next()
	})
	r.GET("/spaces/channels/:channelId/messages", h.ListMessages)
	r.POST("/spaces/channels/:channelId/messages", h.SendMessage)
	r.POST("/spaces/ops", h.MergeOps)
	return r
}

// TestIdentityFromJWT_HeaderIgnored proves the author of a sent message is the
// verified user, even when a different X-Account-ID header is supplied.
func TestIdentityFromJWT_HeaderIgnored(t *testing.T) {
	h := testHandler(t)
	r := router(h, "alice", false)

	req, w := newRequest(http.MethodPost, "/spaces/channels/general/messages",
		"alice", "mallory", models.SendMessageRequest{Body: "hi"})
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (%s)", w.Code, w.Body.String())
	}

	var msg models.Message
	if err := json.Unmarshal(w.Body.Bytes(), &msg); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.AuthorID != "alice" {
		t.Fatalf("expected author 'alice' (from JWT), got %q — X-Account-ID was trusted!", msg.AuthorID)
	}
}

// TestNonMemberChannelAccessDenied proves a non-member cannot read a private
// channel, while a member can.
func TestNonMemberChannelAccessDenied(t *testing.T) {
	h := testHandler(t)

	// Create a private channel owned by alice; only alice is a member.
	ch, err := h.store.CreateChannel("secret", models.ChannelTypePrivate, "alice")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if _, err := h.store.AddMember(ch.ID, "alice"); err != nil {
		t.Fatalf("add member: %v", err)
	}

	// bob (non-member) is denied.
	rb := router(h, "bob", false)
	req, w := newRequest(http.MethodGet, "/spaces/channels/"+ch.ID+"/messages", "bob", "", nil)
	rb.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-member, got %d (%s)", w.Code, w.Body.String())
	}

	// bob also cannot send.
	req, w = newRequest(http.MethodPost, "/spaces/channels/"+ch.ID+"/messages", "bob", "", models.SendMessageRequest{Body: "intrusion"})
	rb.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 sending as non-member, got %d", w.Code)
	}

	// alice (member) is allowed.
	ra := router(h, "alice", false)
	req, w = newRequest(http.MethodGet, "/spaces/channels/"+ch.ID+"/messages", "alice", "", nil)
	ra.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for member, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestMergeOpsAuthorForgeryRejected proves a peer cannot submit ops authored as
// someone else.
func TestMergeOpsAuthorForgeryRejected(t *testing.T) {
	h := testHandler(t)
	r := router(h, "mallory", false)

	// mallory submits an op claiming to be authored by alice.
	forged := []*models.MessageOp{{
		Op:        models.MessageOpAppend,
		ChannelID: "general",
		Msg: models.Message{
			ID:        "m1",
			ChannelID: "general",
			AuthorID:  "alice", // forged
			Body:      "I am alice",
			State:     models.MessageStateActive,
			SeqClock:  "00000000000000000001-0000000000-x",
		},
	}}
	req, w := newRequest(http.MethodPost, "/spaces/ops", "mallory", "", forged)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for forged author, got %d (%s)", w.Code, w.Body.String())
	}

	// A legitimately-authored op succeeds.
	legit := []*models.MessageOp{{
		Op:        models.MessageOpAppend,
		ChannelID: "general",
		Msg: models.Message{
			ID:        "m2",
			ChannelID: "general",
			AuthorID:  "mallory",
			Body:      "honestly me",
			State:     models.MessageStateActive,
			SeqClock:  "00000000000000000002-0000000000-x",
		},
	}}
	req, w = newRequest(http.MethodPost, "/spaces/ops", "mallory", "", legit)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for own-authored op, got %d (%s)", w.Code, w.Body.String())
	}
}

// TestMergeOpsCannotTombstoneOthersMessage proves a peer cannot tombstone a
// message authored by someone else, even with a correctly-self-authored op
// envelope (the forged op claims the attacker as author but targets another's
// message id).
func TestMergeOpsCannotTombstoneOthersMessage(t *testing.T) {
	h := testHandler(t)

	// alice sends a real message via the store.
	msg, err := h.store.SendMessage("general", "alice", "alice's message", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	// mallory tries to tombstone alice's message id, claiming herself as author.
	r := router(h, "mallory", false)
	forged := []*models.MessageOp{{
		Op:        models.MessageOpTombstone,
		ChannelID: "general",
		Msg: models.Message{
			ID:        msg.ID,
			ChannelID: "general",
			AuthorID:  "mallory",
			State:     models.MessageStateTombed,
			SeqClock:  "99999999999999999999-0000000000-x",
		},
	}}
	req, w := newRequest(http.MethodPost, "/spaces/ops", "mallory", "", forged)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 tombstoning another's message, got %d (%s)", w.Code, w.Body.String())
	}

	// alice's message must still be active.
	got, _ := h.store.GetMessage("general", msg.ID)
	if got == nil || got.State == models.MessageStateTombed {
		t.Fatalf("alice's message was tombstoned by a forged op")
	}
}
