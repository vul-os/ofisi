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
type fakeGateway struct {
	mu         sync.Mutex
	appID      string
	method     string
	key        string
	cookie     string
	objectSrv  *httptest.Server
	forceLocal bool
}

func (g *fakeGateway) handler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AppID  string `json:"app_id"`
		Method string `json:"method"`
		Key    string `json:"key"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

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

	gw := &fakeGateway{objectSrv: s3}
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
