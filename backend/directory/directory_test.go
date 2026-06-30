package directory

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDecodeDiscovery_Dialects(t *testing.T) {
	cases := []string{
		`{"vula_id":"vula:x","server":"cell-1","display_name":"Bob"}`,
		`{"vulaId":"vula:x","server":"cell-1","displayName":"Bob"}`,
		`{"VulaID":"vula:x","Server":"cell-1","DisplayName":"Bob"}`,
	}
	for i, body := range cases {
		got, err := decodeDiscovery([]byte(body))
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if got.VulaID != "vula:x" || got.Server != "cell-1" || got.DisplayName != "Bob" {
			t.Fatalf("case %d: got %+v", i, got)
		}
	}
}

func TestCoCloud(t *testing.T) {
	tests := []struct {
		server, local string
		want          bool
	}{
		{"", "cell-1", true},                    // empty server → local
		{"cell-1", "cell-1", true},              // exact host
		{"https://cell-1", "cell-1", true},      // scheme tolerated
		{"cell-1:443", "cell-1:443", true},      // port included both sides
		{"other-cell.example", "cell-1", false}, // different host → remote
		{"other-cell.example", "", false},       // unknown local → fail safe remote
	}
	for _, tc := range tests {
		if got := CoCloud(DiscoveryResult{Server: tc.server}, tc.local); got != tc.want {
			t.Fatalf("CoCloud(server=%q, local=%q)=%v want %v", tc.server, tc.local, got, tc.want)
		}
	}
}

func TestLookupEmail_NotFoundAndOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("email") == "bob@example.com" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"vula_id":"vula:bob","server":""}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	r := &CPResolver{BaseURL: srv.URL, http: srv.Client()}

	got, err := r.LookupEmail(context.Background(), "bob@example.com")
	if err != nil || got.VulaID != "vula:bob" {
		t.Fatalf("ok lookup: got %+v err %v", got, err)
	}

	if _, err := r.LookupEmail(context.Background(), "ghost@example.com"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestLookupEmail_Unavailable(t *testing.T) {
	var r *CPResolver
	if _, err := r.LookupEmail(context.Background(), "x@y.z"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
}
