package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func decodeJSON(r *http.Request, v interface{}) error {
	return json.NewDecoder(r.Body).Decode(v)
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	_ = json.NewEncoder(w).Encode(v)
}

// newTestServer returns an httptest server implementing the introspection
// contract from a supplied handler, plus a counter of how many times it was hit.
func newTestServer(t *testing.T, handler func(body introspectRequest) Result) (*cpIntrospector, *int64) {
	t.Helper()
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		if r.URL.Path != "/api/session/introspect" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get(HeaderRelayAuth) != "shared-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body introspectRequest
		_ = decodeJSON(r, &body)
		res := handler(body)
		w.Header().Set("Content-Type", "application/json")
		writeJSON(w, res)
	}))
	t.Cleanup(srv.Close)
	cfg := Config{IdentityURL: srv.URL, Token: "shared-secret"}
	return NewIntrospectorWithClient(cfg, srv.Client()), &hits
}

func TestIntrospect_ValidSession(t *testing.T) {
	intro, _ := newTestServer(t, func(b introspectRequest) Result {
		if b.Session != "cookie-abc" {
			return Result{Valid: false}
		}
		return Result{Valid: true, UserID: "alice@vulos.org", TenantID: "acct_1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	})
	res, err := intro.Introspect(context.Background(), "cookie-abc")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.Valid || res.UserID != "alice@vulos.org" || res.TenantID != "acct_1" {
		t.Fatalf("bad result: %+v", res)
	}
}

func TestIntrospect_InvalidSession(t *testing.T) {
	intro, _ := newTestServer(t, func(b introspectRequest) Result {
		return Result{Valid: false}
	})
	res, err := intro.Introspect(context.Background(), "bad")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.Valid {
		t.Fatalf("expected invalid, got %+v", res)
	}
}

func TestIntrospect_ProviderUnreachable_Errors(t *testing.T) {
	// Point at a URL that refuses connections; a transport error MUST surface so
	// the caller fails closed.
	cfg := Config{IdentityURL: "http://127.0.0.1:0", Token: "x"}
	intro := NewIntrospectorWithClient(cfg, &http.Client{Timeout: 100 * time.Millisecond})
	_, err := intro.Introspect(context.Background(), "anything")
	if err == nil {
		t.Fatalf("expected transport error (fail-closed), got nil")
	}
}

func TestIntrospect_Non200_Errors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	intro := NewIntrospectorWithClient(Config{IdentityURL: srv.URL}, srv.Client())
	if _, err := intro.Introspect(context.Background(), "s"); err == nil {
		t.Fatalf("expected error on non-200")
	}
}

func TestIntrospect_CacheAvoidsSecondCall(t *testing.T) {
	intro, hits := newTestServer(t, func(b introspectRequest) Result {
		return Result{Valid: true, UserID: "u", TenantID: "t", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	})
	for i := 0; i < 5; i++ {
		if _, err := intro.Introspect(context.Background(), "same-session"); err != nil {
			t.Fatalf("err: %v", err)
		}
	}
	if got := *hits; got != 1 {
		t.Fatalf("expected exactly 1 provider hit (cache), got %d", got)
	}
}

func TestIntrospect_CacheExpiresAfterTTL(t *testing.T) {
	intro, hits := newTestServer(t, func(b introspectRequest) Result {
		return Result{Valid: true, UserID: "u", TenantID: "t", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	})
	// Freeze/advance the clock to force cache expiry without sleeping.
	base := time.Now()
	cur := base
	intro.now = func() time.Time { return cur }

	if _, err := intro.Introspect(context.Background(), "s"); err != nil {
		t.Fatal(err)
	}
	cur = base.Add(cacheMaxTTL + time.Second) // past the cache TTL
	if _, err := intro.Introspect(context.Background(), "s"); err != nil {
		t.Fatal(err)
	}
	if got := *hits; got != 2 {
		t.Fatalf("expected 2 hits after TTL expiry, got %d", got)
	}
}

func TestIntrospect_CacheBoundedByExpiresAt(t *testing.T) {
	// A session that expires in 10s must NOT be cached for the full cacheMaxTTL.
	intro, hits := newTestServer(t, func(b introspectRequest) Result {
		return Result{Valid: true, UserID: "u", TenantID: "t", ExpiresAt: time.Now().Add(10 * time.Second).Unix()}
	})
	base := time.Now()
	cur := base
	intro.now = func() time.Time { return cur }

	if _, err := intro.Introspect(context.Background(), "s"); err != nil {
		t.Fatal(err)
	}
	// Advance 12s: still within cacheMaxTTL (45s) but PAST the session's own
	// 10s expiry, so the cache entry must have lapsed and the provider re-hit.
	cur = base.Add(12 * time.Second)
	if _, err := intro.Introspect(context.Background(), "s"); err != nil {
		t.Fatal(err)
	}
	if got := *hits; got != 2 {
		t.Fatalf("expected re-introspect after session expiry (2 hits), got %d", got)
	}
}

func TestIntrospect_StaleValidDowngradedToInvalid(t *testing.T) {
	// Provider returns valid:true but with a past expiresAt → treated as invalid.
	intro, _ := newTestServer(t, func(b introspectRequest) Result {
		return Result{Valid: true, UserID: "u", TenantID: "t", ExpiresAt: time.Now().Add(-time.Minute).Unix()}
	})
	res, err := intro.Introspect(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if res.Valid {
		t.Fatalf("expired-but-valid session must be downgraded to invalid: %+v", res)
	}
}

func TestIntrospect_ValidWithoutUserIDIsInvalid(t *testing.T) {
	intro, _ := newTestServer(t, func(b introspectRequest) Result {
		return Result{Valid: true, UserID: "", TenantID: "t", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	})
	res, err := intro.Introspect(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	if res.Valid {
		t.Fatalf("valid result without a userId must be invalid: %+v", res)
	}
}

func TestFromEnv_And_Enabled(t *testing.T) {
	t.Setenv(EnvIdentityURL, "https://cp.vulos.org/")
	t.Setenv(EnvSharedSecret, "sekret")
	cfg := FromEnv()
	if cfg.IdentityURL != "https://cp.vulos.org" { // trailing slash trimmed
		t.Fatalf("IdentityURL = %q", cfg.IdentityURL)
	}
	if cfg.Token != "sekret" {
		t.Fatalf("Token = %q", cfg.Token)
	}
	if !cfg.Enabled() {
		t.Fatalf("expected Enabled")
	}
	if NewIntrospector(Config{}) != nil {
		t.Fatalf("empty config must yield a nil introspector (local mode)")
	}
}
