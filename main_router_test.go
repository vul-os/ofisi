package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// newTestRouter builds a router shaped like the real one: a couple of API routes
// under /api and /v1, then the static/SPA mount on top of an in-memory dist.
func newTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.HandleMethodNotAllowed = true

	api := r.Group("/api")
	api.POST("/auth/login", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	api.GET("/auth/status", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	v1 := r.Group("/v1")
	v1.GET("/documents", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	mountStatic(r, fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>office</title>")},
		"assets/app.js": {Data: []byte("console.log('app')")},
	})
	return r
}

func do(t *testing.T, r *gin.Engine, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

// An unmatched /api route must be an honest JSON 404, never a 200 text/html SPA
// page — clients treat a 200 as success, so an HTML fallback turns every
// missing or mistyped endpoint into a silent fail-open.
func TestAPINotFoundIsJSON404(t *testing.T) {
	r := newTestRouter()

	for _, path := range []string{"/api/auth/me", "/api/does-not-exist", "/v1/nope", "/api", "/v1"} {
		w := do(t, r, http.MethodGet, path)
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404 (body: %s)", path, w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("GET %s: Content-Type = %q, want JSON", path, ct)
		}
	}
}

// A method mismatch on a REAL API route must be a JSON 405, not the SPA page.
func TestAPIMethodMismatchIsJSON405(t *testing.T) {
	r := newTestRouter()

	w := do(t, r, http.MethodPost, "/api/auth/status")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /api/auth/status: status = %d, want 405 (body: %s)", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("POST /api/auth/status: Content-Type = %q, want JSON", ct)
	}

	w = do(t, r, http.MethodDelete, "/v1/documents")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE /v1/documents: status = %d, want 405", w.Code)
	}
}

// Registered API routes still work.
func TestAPIRoutesStillServed(t *testing.T) {
	r := newTestRouter()

	if w := do(t, r, http.MethodGet, "/api/auth/status"); w.Code != http.StatusOK {
		t.Errorf("GET /api/auth/status: status = %d, want 200", w.Code)
	}
	if w := do(t, r, http.MethodPost, "/api/auth/login"); w.Code != http.StatusOK {
		t.Errorf("POST /api/auth/login: status = %d, want 200", w.Code)
	}
}

// The SPA fallback is untouched for front-end paths: client-router deep links
// get index.html, real assets get themselves.
func TestSPAFallbackServesFrontend(t *testing.T) {
	r := newTestRouter()

	w := do(t, r, http.MethodGet, "/docs/abc123")
	if w.Code != http.StatusOK {
		t.Fatalf("GET /docs/abc123: status = %d, want 200", w.Code)
	}
	if body := w.Body.String(); body != "<!doctype html><title>office</title>" {
		t.Errorf("GET /docs/abc123: body = %q, want index.html", body)
	}

	w = do(t, r, http.MethodGet, "/assets/app.js")
	if w.Code != http.StatusOK {
		t.Fatalf("GET /assets/app.js: status = %d, want 200", w.Code)
	}
	if body := w.Body.String(); body != "console.log('app')" {
		t.Errorf("GET /assets/app.js: body = %q, want the asset", body)
	}

	if w := do(t, r, http.MethodGet, "/"); w.Code != http.StatusOK {
		t.Errorf("GET /: status = %d, want 200", w.Code)
	}
}

func TestIsJSONAPIPath(t *testing.T) {
	api := []string{"/api", "/api/", "/api/auth/me", "/v1", "/v1/documents/x/export"}
	spa := []string{"/", "/docs", "/apiary", "/v10/things", "/assets/app.js", "/mcp", "/healthz"}

	for _, p := range api {
		if !isJSONAPIPath(p) {
			t.Errorf("isJSONAPIPath(%q) = false, want true", p)
		}
	}
	for _, p := range spa {
		if isJSONAPIPath(p) {
			t.Errorf("isJSONAPIPath(%q) = true, want false", p)
		}
	}
}

// HandleMethodNotAllowed must not eat CORS preflight: gin runs the global
// middleware chain ahead of the NoMethod handler, so cors still answers OPTIONS
// on a POST-only route.
func TestCORSPreflightSurvivesMethodNotAllowed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.HandleMethodNotAllowed = true
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"https://app.vulos.org"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		AllowCredentials: true,
	}))
	r.POST("/api/auth/login", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	mountStatic(r, fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}})

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/api/auth/login", nil)
	req.Header.Set("Origin", "https://app.vulos.org")
	req.Header.Set("Access-Control-Request-Method", "POST")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS preflight: status = %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://app.vulos.org" {
		t.Errorf("Access-Control-Allow-Origin = %q, want the allowed origin", got)
	}
}
