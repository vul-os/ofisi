package storage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeGateway captures the presign request and returns a grant pointing at a
// fake S3 server, so we can assert the full presign→object-IO path end to end.
// It also serves /api/storage/delete, simulating the gateway's server-mediated
// delete (no presign grant for DELETE — see presign.go): it composes the same
// "<userID>/office/<relKey>" key and deletes directly from the fake S3 store.
type fakeGateway struct {
	mu         sync.Mutex
	appID      string
	method     string
	key        string
	cookie     string
	objectSrv  *httptest.Server
	forceLocal bool

	deleteAppID string
	deleteKey   string
	deleteStore map[string][]byte // shared with the fake S3 server's object map
	deleteHits  int
}

func (g *fakeGateway) handler(w http.ResponseWriter, r *http.Request) {
	var raw map[string]string
	_ = json.NewDecoder(r.Body).Decode(&raw)

	if r.URL.Path == "/api/storage/delete" {
		g.mu.Lock()
		g.deleteAppID = raw["app_id"]
		g.deleteKey = raw["key"]
		g.deleteHits++
		if g.deleteStore != nil {
			fullKey := "/bucket/user-alice/office/" + raw["key"]
			delete(g.deleteStore, fullKey)
		}
		g.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}

	req := struct{ AppID, Method, Key string }{raw["app_id"], raw["method"], raw["key"]}

	g.mu.Lock()
	g.appID = req.AppID
	g.method = req.Method
	g.key = req.Key
	if ck, err := r.Cookie("vc_session"); err == nil {
		g.cookie = ck.Value
	}
	forceLocal := g.forceLocal
	g.mu.Unlock()

	if forceLocal {
		_ = json.NewEncoder(w).Encode(objectGrant{Type: grantLocal, Method: req.Method})
		return
	}

	// The gateway composes the full key "<userID>/office/<relKey>"; simulate that.
	fullKey := "user-alice/office/" + req.Key
	// Point the presigned URL at the fake S3 server, embedding the full key.
	url := g.objectSrv.URL + "/bucket/" + fullKey + "?X-Amz-Signature=fake"
	_ = json.NewEncoder(w).Encode(objectGrant{
		Type:      grantPresigned,
		Method:    req.Method,
		Bucket:    "vulos-alice",
		Key:       fullKey,
		URL:       url,
		ExpiresAt: time.Now().Add(5 * time.Minute),
	})
}

func TestPresignClient_PutGetRoundTrip(t *testing.T) {
	// Fake S3: stores PUT bodies by path, serves them back on GET.
	var s3mu sync.Mutex
	objects := map[string][]byte{}
	var putPaths []string
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s3mu.Lock()
		defer s3mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = b
			putPaths = append(putPaths, r.URL.Path)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			if b, ok := objects[r.URL.Path]; ok {
				_, _ = w.Write(b)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer s3.Close()

	gw := &fakeGateway{objectSrv: s3, deleteStore: objects}
	gws := httptest.NewServer(http.HandlerFunc(gw.handler))
	defer gws.Close()

	pc := NewPresignClient(gws.URL)
	if pc == nil {
		t.Fatal("NewPresignClient returned nil for a non-empty URL")
	}

	stored, err := pc.Put(context.Background(), "sess-token-123", "file/doc1", []byte("hello"), "application/json")
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if !stored {
		t.Fatalf("Put stored=false, want true")
	}

	// Gateway must have received app_id="office" + the relative key + the cookie.
	gw.mu.Lock()
	if gw.appID != "office" {
		t.Errorf("gateway app_id = %q, want office", gw.appID)
	}
	if gw.key != "file/doc1" {
		t.Errorf("gateway key = %q, want file/doc1 (relative, no user/app prefix)", gw.key)
	}
	if gw.cookie != "sess-token-123" {
		t.Errorf("gateway cookie = %q, want sess-token-123 (forwarded session)", gw.cookie)
	}
	gw.mu.Unlock()

	// The object landed under the gateway-composed <userID>/office/ prefix.
	s3mu.Lock()
	if len(putPaths) != 1 || !strings.Contains(putPaths[0], "/user-alice/office/file/doc1") {
		t.Errorf("PUT path = %v, want …/user-alice/office/file/doc1", putPaths)
	}
	s3mu.Unlock()

	data, stored, err := pc.Get(context.Background(), "sess-token-123", "file/doc1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !stored || string(data) != "hello" {
		t.Fatalf("Get = (%q, stored=%v), want (hello, true)", data, stored)
	}

	// Delete round-trip: put → delete → get must now report "not stored".
	if err := pc.Delete(context.Background(), "sess-token-123", "file/doc1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	gw.mu.Lock()
	if gw.deleteAppID != "office" {
		t.Errorf("gateway delete app_id = %q, want office", gw.deleteAppID)
	}
	if gw.deleteKey != "file/doc1" {
		t.Errorf("gateway delete key = %q, want file/doc1 (relative, no user/app prefix)", gw.deleteKey)
	}
	gw.mu.Unlock()

	// After delete the presigned GET 404s: data is nil (matching the presigned
	// grant contract — see Get's doc comment: "stored" reflects only whether a
	// local-grant fallback applies, not object presence; callers key off data).
	data, _, err = pc.Get(context.Background(), "sess-token-123", "file/doc1")
	if err != nil {
		t.Fatalf("Get after delete: %v", err)
	}
	if data != nil {
		t.Fatalf("Get after delete = %q, want nil (object removed)", data)
	}
}

// TestPresignClient_Delete_IdempotentOnAlreadyGone asserts a second delete of
// an object the gateway no longer has (404) is treated as success, matching
// OfficeS3Client.Delete's idempotent-on-404 behaviour.
func TestPresignClient_Delete_IdempotentOnAlreadyGone(t *testing.T) {
	gws := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer gws.Close()

	pc := NewPresignClient(gws.URL)
	if err := pc.Delete(context.Background(), "s", "file/gone"); err != nil {
		t.Fatalf("Delete on already-absent object should be nil (idempotent), got %v", err)
	}
}

// TestPresignClient_Delete_GatewayError_Propagates mirrors
// TestPresignClient_GatewayError_Propagates for the delete path.
func TestPresignClient_Delete_GatewayError_Propagates(t *testing.T) {
	gws := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden) // e.g. key outside app's own prefix
	}))
	defer gws.Close()
	pc := NewPresignClient(gws.URL)
	if err := pc.Delete(context.Background(), "s", "file/x"); err == nil {
		t.Fatalf("expected an error when the gateway returns 403")
	}
}

// TestPresignClient_Delete_SendsAppRelativeKey asserts Delete always presents
// app_id="office" plus the RAW relative key (never a pre-composed
// "<userID>/office/…" path) — the gateway is the only party allowed to compose
// the full key, which is what keeps Office from ever deleting outside its own
// per-user/per-app prefix (cross-app/cross-user isolation).
func TestPresignClient_Delete_SendsAppRelativeKey(t *testing.T) {
	var mu sync.Mutex
	var gotAppID, gotKey string
	gws := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]string
		_ = json.NewDecoder(r.Body).Decode(&raw)
		mu.Lock()
		gotAppID, gotKey = raw["app_id"], raw["key"]
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gws.Close()

	pc := NewPresignClient(gws.URL)
	if err := pc.Delete(context.Background(), "s", "file/doc1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotAppID != PresignAppID {
		t.Errorf("delete app_id = %q, want %q", gotAppID, PresignAppID)
	}
	if gotKey != "file/doc1" {
		t.Errorf("delete key = %q, want file/doc1 (relative — gateway composes the user/app prefix, never Office)", gotKey)
	}
}

func TestPresignClient_LocalGrant_MeansNoObjectStore(t *testing.T) {
	gw := &fakeGateway{forceLocal: true}
	gws := httptest.NewServer(http.HandlerFunc(gw.handler))
	defer gws.Close()

	pc := NewPresignClient(gws.URL)
	stored, err := pc.Put(context.Background(), "s", "file/x", []byte("d"), "")
	if err != nil {
		t.Fatalf("Put(local grant): %v", err)
	}
	if stored {
		t.Fatalf("local grant Put stored=true, want false (caller uses local store)")
	}
	data, stored, err := pc.Get(context.Background(), "s", "file/x")
	if err != nil || stored || data != nil {
		t.Fatalf("local grant Get = (%q, stored=%v, err=%v), want (nil, false, nil)", data, stored, err)
	}
}

func TestNewPresignClient_EmptyURL_Nil(t *testing.T) {
	if NewPresignClient("") != nil {
		t.Errorf("NewPresignClient(\"\") should be nil")
	}
	if NewPresignClient("   ") != nil {
		t.Errorf("NewPresignClient(whitespace) should be nil")
	}
}

func TestPresignClient_GatewayError_Propagates(t *testing.T) {
	gws := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden) // e.g. app not permitted storage
	}))
	defer gws.Close()
	pc := NewPresignClient(gws.URL)
	if _, err := pc.Put(context.Background(), "s", "file/x", []byte("d"), ""); err == nil {
		t.Fatalf("expected an error when the gateway returns 403")
	}
}

func TestSanitizePresignRelKey_Isolation(t *testing.T) {
	cases := map[string]string{
		"file/doc1":          "file/doc1",
		"seal/env-1.pdf":     "seal/env-1.pdf",
		"/leading/slash":     "leading/slash",
		"a/../../etc/passwd": "a/etc/passwd", // ".." segments dropped
		"../../secret":       "secret",       // cannot climb out of the prefix
		"a//b":               "a/b",          // empty segments collapsed
		"weird\\back":        "weird_back",   // backslash neutralised
		"nul\x00byte":        "nulbyte",      // NUL stripped
		"./x":                "x",            // "." dropped
	}
	for in, want := range cases {
		if got := SanitizePresignRelKey(in); got != want {
			t.Errorf("SanitizePresignRelKey(%q) = %q, want %q", in, got, want)
		}
	}
	// A key that sanitizes must never contain a traversal segment.
	for _, in := range []string{"../../../a", "x/../../../../y", "..\\..\\z"} {
		got := SanitizePresignRelKey(in)
		for _, seg := range strings.Split(got, "/") {
			if seg == ".." {
				t.Errorf("SanitizePresignRelKey(%q) = %q still contains a %q segment", in, got, "..")
			}
		}
	}
}
