package directory

// directory_fromenv_test.go — WAVE32 coverage. FromEnv (0%) and the remaining
// LookupEmail branches (empty email, transport failure, non-2xx status, the
// empty-principal → fail-closed ErrNotFound, and X-Relay-Auth propagation).
// Email→principal resolution is a security seam: a 200 with an empty principal
// MUST NOT be treated as a co-cloud grant.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFromEnv(t *testing.T) {
	// No control plane configured → nil resolver (self-host fallback).
	t.Setenv(envCPBaseURL, "")
	if r := FromEnv(); r != nil {
		t.Fatalf("FromEnv with no base URL should be nil, got %+v", r)
	}

	// Base URL set, cell server unset → LocalServer defaults to the base host.
	t.Setenv(envCPBaseURL, "https://cp.vulos.org/")
	t.Setenv(envCPToken, "secret-token")
	t.Setenv(envCellServer, "")
	r := FromEnv()
	if r == nil {
		t.Fatal("FromEnv with base URL should return a resolver")
	}
	if r.BaseURL != "https://cp.vulos.org" { // trailing slash trimmed
		t.Errorf("BaseURL = %q; want trailing slash trimmed", r.BaseURL)
	}
	if r.Token != "secret-token" {
		t.Errorf("Token = %q; want secret-token", r.Token)
	}
	if r.LocalServer != "cp.vulos.org" {
		t.Errorf("LocalServer = %q; want defaulted to base host", r.LocalServer)
	}

	// Explicit cell server overrides the default.
	t.Setenv(envCellServer, "cell-eu-1.vulos.org")
	if r := FromEnv(); r.LocalServer != "cell-eu-1.vulos.org" {
		t.Errorf("explicit LocalServer = %q; want cell-eu-1.vulos.org", r.LocalServer)
	}
}

func TestLookupEmail_EmptyEmail(t *testing.T) {
	r := &CPResolver{BaseURL: "https://cp.example"}
	if _, err := r.LookupEmail(context.Background(), "   "); err == nil {
		t.Fatal("empty email should error")
	}
	// Must NOT be a not-found/unavailable sentinel — it's a caller bug.
	if _, err := r.LookupEmail(context.Background(), ""); errors.Is(err, ErrNotFound) || errors.Is(err, ErrUnavailable) {
		t.Fatal("empty email should be a plain error, not ErrNotFound/ErrUnavailable")
	}
}

func TestLookupEmail_TransportFailure(t *testing.T) {
	// Point at a server that is immediately closed → dial error.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()

	r := &CPResolver{BaseURL: url}
	_, err := r.LookupEmail(context.Background(), "x@y.z")
	if err == nil {
		t.Fatal("transport failure should error")
	}
	if errors.Is(err, ErrNotFound) {
		t.Fatal("transport failure must not be reported as ErrNotFound")
	}
}

func TestLookupEmail_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	r := &CPResolver{BaseURL: srv.URL, http: srv.Client()}
	if _, err := r.LookupEmail(context.Background(), "x@y.z"); err == nil {
		t.Fatal("5xx should surface an error")
	} else if errors.Is(err, ErrNotFound) {
		t.Fatal("5xx must not be ErrNotFound")
	}
}

// TestLookupEmail_EmptyPrincipalFailsClosed proves a 200 with an empty
// principal is treated as ErrNotFound, never a silent co-cloud grant.
func TestLookupEmail_EmptyPrincipalFailsClosed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"vula_id":"","server":""}`))
	}))
	defer srv.Close()

	r := &CPResolver{BaseURL: srv.URL, http: srv.Client()}
	if _, err := r.LookupEmail(context.Background(), "x@y.z"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty principal should be ErrNotFound, got %v", err)
	}
}

// TestLookupEmail_SendsAuthHeader proves the shared X-Relay-Auth secret is
// forwarded so the cell directory authorizes the office lookup.
func TestLookupEmail_SendsAuthHeader(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get(headerRelayAuth)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"vula_id":"vula:z","server":"cell"}`))
	}))
	defer srv.Close()

	r := &CPResolver{BaseURL: srv.URL, Token: "abc123", http: srv.Client()}
	if _, err := r.LookupEmail(context.Background(), "z@y.z"); err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if gotAuth != "abc123" {
		t.Errorf("X-Relay-Auth = %q; want abc123", gotAuth)
	}
}
