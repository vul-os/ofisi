package handlers

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"vulos-office/backend/fileacl"
	"vulos-office/backend/middleware"
	"vulos-office/backend/updatelog"

	"github.com/gin-gonic/gin"
)

// newUpdateLogSetup builds a FileHandler and an UpdateLogHandler that SHARE one
// ACL store + authorizer, so ownership recorded by creating a file is honoured
// by the update-log routes.
func newUpdateLogSetup(t *testing.T) (*FileHandler, *UpdateLogHandler) {
	t.Helper()
	st := newMemStorage()
	acl := fileacl.NewNullStore()
	authz := NewFileAuthz(acl)
	fh := NewFileHandlerWithAuthz(st, authz)
	ul, err := updatelog.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	uh := NewUpdateLogHandlerWithAuthz(ul, st, authz)
	return fh, uh
}

func updatesRouter(fh *FileHandler, uh *UpdateLogHandler, user string) *gin.Engine {
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, user)
		c.Next()
	})
	r.POST("/files", fh.Create)
	r.GET("/files/:id/updates", uh.List)
	r.POST("/files/:id/updates", uh.Append)
	return r
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestUpdateLogAppendAndList(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	// Append two update frames.
	for i, payload := range []string{"u1", "u2"} {
		w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte(payload))})
		if w.Code != http.StatusOK {
			t.Fatalf("append %d: expected 200, got %d (%s)", i, w.Code, w.Body.String())
		}
		var resp struct {
			Seq int64 `json:"seq"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if resp.Seq != int64(i+1) {
			t.Fatalf("append %d: seq = %d, want %d", i, resp.Seq, i+1)
		}
	}

	// Full load returns both frames.
	w := doReq(r, http.MethodGet, "/files/"+id+"/updates", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var log updatelog.Log
	if err := json.Unmarshal(w.Body.Bytes(), &log); err != nil {
		t.Fatalf("decode log: %v", err)
	}
	if log.Head != 2 || len(log.Frames) != 2 {
		t.Fatalf("list: head=%d frames=%d", log.Head, len(log.Frames))
	}
	got, _ := updatelog.DecodeFrame(log.Frames[0])
	if string(got) != "u1" {
		t.Fatalf("frame 0 data = %q, want u1", got)
	}
}

func TestUpdateLogSnapshotCompaction(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	for _, p := range []string{"a", "b", "c"} {
		doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte(p))})
	}
	// Snapshot up to floor 3.
	w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "snapshot", "data": b64([]byte("STATE")), "floor": 3})
	if w.Code != http.StatusOK {
		t.Fatalf("snapshot: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	w = doReq(r, http.MethodGet, "/files/"+id+"/updates", nil)
	var log updatelog.Log
	_ = json.Unmarshal(w.Body.Bytes(), &log)
	if log.Snapshot == nil {
		t.Fatal("expected a snapshot after compaction")
	}
	if len(log.Frames) != 0 {
		t.Fatalf("expected all frames pruned, got %d", len(log.Frames))
	}
}

// A non-editor (no access) must get 404 on both list and append — no existence leak.
func TestUpdateLogAclEnforced(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	alice := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	bob := updatesRouter(fh, uh, "bob")
	if w := doReq(bob, http.MethodGet, "/files/"+id+"/updates", nil); w.Code != http.StatusNotFound {
		t.Fatalf("list as non-owner: expected 404, got %d", w.Code)
	}
	if w := doReq(bob, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("x"))}); w.Code != http.StatusNotFound {
		t.Fatalf("append as non-owner: expected 404, got %d", w.Code)
	}
	// Sanity: the owner still can.
	if w := doReq(alice, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": b64([]byte("ok"))}); w.Code != http.StatusOK {
		t.Fatalf("append as owner: expected 200, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestUpdateLogRejectsBadInput(t *testing.T) {
	fh, uh := newUpdateLogSetup(t)
	r := updatesRouter(fh, uh, "alice")
	id := createFileAs(t, fh, "alice")

	// Non-base64 data.
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "update", "data": "!!!not base64!!!"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad base64: expected 400, got %d", w.Code)
	}
	// Unknown kind.
	if w := doReq(r, http.MethodPost, "/files/"+id+"/updates", gin.H{"kind": "bogus", "data": b64([]byte("x"))}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad kind: expected 400, got %d", w.Code)
	}
}
