package storage

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// capture records the path + headers the fake S3 endpoint received.
type capture struct {
	mu     sync.Mutex
	method string
	path   string
	token  string
	body   []byte
}

func newFakeS3(t *testing.T, cap *capture) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.mu.Lock()
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.token = r.Header.Get("X-Amz-Security-Token")
		cap.body, _ = io.ReadAll(r.Body)
		cap.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
}

func TestSeamS3Client_AbsentSeamReturnsNil(t *testing.T) {
	cl, err := SeamS3Client(SeamStorageConfig{})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cl != nil {
		t.Fatalf("expected nil client when seam absent, got %#v", cl)
	}
}

func TestSeamS3Client_PrefixNamespacesUnderOffice(t *testing.T) {
	cap := &capture{}
	srv := newFakeS3(t, cap)
	defer srv.Close()

	cl, err := SeamS3Client(SeamStorageConfig{
		Endpoint:  srv.URL,
		Bucket:    "shared-user-bucket",
		Prefix:    "users/u-123",
		Region:    "auto",
		AccessKey: "AK",
		SecretKey: "SK",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if cl == nil {
		t.Fatal("expected non-nil client")
	}

	// Mimic the handler key: OrgScopedKey(account, "file/"+id).
	key := OrgScopedKey("acct-9", "file/doc-1")
	if err := cl.Put(key, []byte("hello")); err != nil {
		t.Fatalf("put: %v", err)
	}

	cap.mu.Lock()
	defer cap.mu.Unlock()
	want := "/shared-user-bucket/users/u-123/office/" + key
	if cap.path != want {
		t.Fatalf("object path = %q, want %q", cap.path, want)
	}
	if cap.method != http.MethodPut {
		t.Fatalf("method = %q, want PUT", cap.method)
	}
	if string(cap.body) != "hello" {
		t.Fatalf("body = %q, want hello", cap.body)
	}
}

func TestSeamS3Client_NoPrefixStillNamespacesOffice(t *testing.T) {
	cap := &capture{}
	srv := newFakeS3(t, cap)
	defer srv.Close()

	cl, _ := SeamS3Client(SeamStorageConfig{
		Endpoint:  srv.URL,
		Bucket:    "b",
		AccessKey: "AK",
		SecretKey: "SK",
	})
	if err := cl.Put("k", nil); err != nil {
		t.Fatalf("put: %v", err)
	}
	cap.mu.Lock()
	defer cap.mu.Unlock()
	if cap.path != "/b/office/k" {
		t.Fatalf("path = %q, want /b/office/k", cap.path)
	}
}

func TestSeamS3Client_SessionTokenSignedAndSent(t *testing.T) {
	cap := &capture{}
	srv := newFakeS3(t, cap)
	defer srv.Close()

	cl, _ := SeamS3Client(SeamStorageConfig{
		Endpoint:     srv.URL,
		Bucket:       "b",
		Prefix:       "p",
		AccessKey:    "AK",
		SecretKey:    "SK",
		SessionToken: "TEMP-TOKEN-XYZ",
	})
	if err := cl.Put("k", []byte("x")); err != nil {
		t.Fatalf("put: %v", err)
	}
	cap.mu.Lock()
	defer cap.mu.Unlock()
	if cap.token != "TEMP-TOKEN-XYZ" {
		t.Fatalf("security token header = %q, want TEMP-TOKEN-XYZ", cap.token)
	}
}

func TestSeamS3Client_CachedByFingerprint(t *testing.T) {
	cfg := SeamStorageConfig{
		Endpoint:  "https://example.com",
		Bucket:    "b",
		Prefix:    "p",
		AccessKey: "AK",
		SecretKey: "SK",
	}
	a, _ := SeamS3Client(cfg)
	b, _ := SeamS3Client(cfg)
	if a != b {
		t.Fatal("expected identical cached client for identical config")
	}
	cfg2 := cfg
	cfg2.SecretKey = "DIFFERENT"
	d, _ := SeamS3Client(cfg2)
	if d == a {
		t.Fatal("expected distinct client for different credentials")
	}
}

func TestSeamStorageConfig_OfficePrefix(t *testing.T) {
	cases := map[string]string{
		"":           "office",
		"/":          "office",
		"users/u1":   "users/u1/office",
		"/users/u1/": "users/u1/office",
		"a/b/c":      "a/b/c/office",
	}
	for in, want := range cases {
		got := SeamStorageConfig{Prefix: in}.officePrefix()
		if got != want {
			t.Errorf("officePrefix(%q) = %q, want %q", in, got, want)
		}
	}
}
