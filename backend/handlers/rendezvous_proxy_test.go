package handlers

// rendezvous_proxy_test.go — the safety contract of the same-origin rendezvous
// pass-through (rendezvous_proxy.go). These are the guards that make an
// operator-configured proxy safe to expose unauthenticated: fixed upstream,
// allow-listed protocol paths, no traversal, no credential forwarding, no
// redirect-following, and "unset config ⇒ no route at all".

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// newProxyRouter mounts the proxy exactly as main.go does.
func newProxyRouter(t *testing.T, upstream string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewRendezvousProxyHandler(upstream)
	if h == nil {
		t.Fatalf("expected a proxy handler for upstream %q", upstream)
	}
	api := r.Group("/api")
	api.Any(RendezvousProxyPrefix+"/*path", h.Proxy)
	return r
}

func TestRendezvousProxy_NotConfiguredMeansNoHandler(t *testing.T) {
	// The honesty contract: an unset (or unusable) rendezvous URL must yield a
	// nil handler so main.go mounts nothing and collab stays local-only.
	for _, bad := range []string{"", "   ", "not a url", "ftp://relay.example.org", "/relative/only"} {
		if h := NewRendezvousProxyHandler(bad); h != nil {
			t.Errorf("NewRendezvousProxyHandler(%q) = %v, want nil", bad, h)
		}
	}
	if h := NewRendezvousProxyHandler("http://relay.example.org/"); h == nil {
		t.Fatal("a valid http upstream must yield a handler")
	} else if got := h.Upstream(); got != "http://relay.example.org" {
		t.Errorf("Upstream() = %q, want trailing slash trimmed", got)
	}
}

func TestRendezvousProxy_ForwardsToUpstreamRendezvousPrefix(t *testing.T) {
	var gotPath, gotQuery, gotMethod, gotBody, gotCookie, gotAuth string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotMethod = r.URL.Path, r.URL.RawQuery, r.Method
		gotCookie = r.Header.Get("Cookie")
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer up.Close()

	r := newProxyRouter(t, up.URL)
	req := httptest.NewRequest(http.MethodPost, "/api/rendezvous/signal/abc/poll?wait=20", strings.NewReader(`{"sig":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	// Credentials that must NOT reach the relay.
	req.Header.Set("Cookie", "vulos_office_session=super-secret")
	req.Header.Set("Authorization", "Bearer super-secret")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if gotPath != "/rendezvous/signal/abc/poll" {
		t.Errorf("upstream path = %q, want /rendezvous/signal/abc/poll", gotPath)
	}
	if gotQuery != "wait=20" {
		t.Errorf("upstream query = %q, want wait=20", gotQuery)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("upstream method = %q, want POST", gotMethod)
	}
	if gotBody != `{"sig":"x"}` {
		t.Errorf("upstream body = %q, want the request body byte-identical", gotBody)
	}
	if gotCookie != "" || gotAuth != "" {
		t.Errorf("credentials leaked upstream: cookie=%q auth=%q — the rendezvous protocol is Ed25519 self-authenticating and must receive neither", gotCookie, gotAuth)
	}
	if w.Body.String() != `{"ok":true}` {
		t.Errorf("body = %q, want the upstream body passed through", w.Body.String())
	}
}

func TestRendezvousProxy_RejectsNonProtocolPathsAndTraversal(t *testing.T) {
	hit := false
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer up.Close()
	r := newProxyRouter(t, up.URL)

	// Anything that is not an allow-listed rendezvous verb, or that tries to
	// climb out of the prefix, must 404 WITHOUT touching the upstream.
	for _, p := range []string{
		"/api/rendezvous/",
		"/api/rendezvous/admin",
		"/api/rendezvous/metrics",
		"/api/rendezvous/../../etc/passwd",
		"/api/rendezvous/announce/../../admin",
		"/api/rendezvous/signal/a/b/c/d",
	} {
		hit = false
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", p, w.Code)
		}
		if hit {
			t.Errorf("%s: reached the upstream — the allow-list failed open", p)
		}
	}
}

func TestRendezvousProxy_DoesNotFollowRedirects(t *testing.T) {
	// A redirect-following proxy would be a "fetch anything" primitive for
	// whoever controls (or can impersonate) the relay. The 3xx must come back
	// verbatim instead.
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("SHOULD-NEVER-BE-FETCHED"))
	}))
	defer elsewhere.Close()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/secret", http.StatusFound)
	}))
	defer up.Close()

	r := newProxyRouter(t, up.URL)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/rendezvous/ice", nil))

	if w.Code != http.StatusFound {
		t.Errorf("status = %d, want the 302 passed through unfollowed", w.Code)
	}
	if strings.Contains(w.Body.String(), "SHOULD-NEVER-BE-FETCHED") {
		t.Error("the proxy followed a redirect — SSRF pivot")
	}
}

func TestRendezvousProxy_UpstreamDownFailsClosed(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	upURL := up.URL
	up.Close() // nothing is listening now

	r := newProxyRouter(t, upURL)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/rendezvous/healthz", nil))

	if w.Code != http.StatusBadGateway && w.Code != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want 502/504 — an unreachable relay must be reported, never masked as success", w.Code)
	}
}

func TestSanitizeRendezvousPath(t *testing.T) {
	ok := map[string]string{
		"/announce":        "/announce",
		"announce":         "/announce",
		"/resolve/abc":     "/resolve/abc",
		"/signal/abc/poll": "/signal/abc/poll",
		"/mailbox/abc/ack": "/mailbox/abc/ack",
		"/ice":             "/ice",
		"/healthz":         "/healthz",
		"/withdraw":        "/withdraw",
		"/signal/a%2Fb":    "/signal/a%2Fb", // already-decoded by gin in practice
	}
	for in, want := range ok {
		got, valid := sanitizeRendezvousPath(in)
		if !valid || got != want {
			t.Errorf("sanitizeRendezvousPath(%q) = (%q,%v), want (%q,true)", in, got, valid, want)
		}
	}
	for _, in := range []string{"", "/", "/nope", "/announce/../x", "//evil.example", "/signal//poll", "/a\\b"} {
		if got, valid := sanitizeRendezvousPath(in); valid {
			t.Errorf("sanitizeRendezvousPath(%q) = (%q,true), want rejected", in, got)
		}
	}
}
