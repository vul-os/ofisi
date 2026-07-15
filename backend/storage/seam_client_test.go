package storage

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestSeamS3Client_RejectsExternalHTTPEndpoint(t *testing.T) {
	_, err := SeamS3Client(SeamStorageConfig{
		Endpoint:  "http://evil.example.com",
		Bucket:    "b",
		AccessKey: "AK",
		SecretKey: "SK",
	})
	if err == nil {
		t.Fatal("expected error for external http:// endpoint, got nil")
	}
}

func TestValidateSeamEndpoint(t *testing.T) {
	allowed := []string{
		"https://fly.storage.tigris.dev",
		"https://evil.example.com", // https is always fine
		"http://localhost:9000",
		"http://127.0.0.1:9000",
		"http://10.1.2.3:9000",    // private
		"http://192.168.1.5:9000", // private
		"http://minio:9000",       // single-label on-box service name
	}
	for _, e := range allowed {
		if err := ValidateSeamEndpoint(e); err != nil {
			t.Errorf("ValidateSeamEndpoint(%q) = %v, want allowed", e, err)
		}
	}
	rejected := []string{
		"http://evil.example.com",
		"http://203.0.113.7:9000", // public IP
		"ftp://localhost",
		"http://minio.evil.example.com",
	}
	for _, e := range rejected {
		if err := ValidateSeamEndpoint(e); err == nil {
			t.Errorf("ValidateSeamEndpoint(%q) = nil, want rejected", e)
		}
	}
}

func TestSeamStorageConfig_Trusted(t *testing.T) {
	const secret = "broker-secret-123"
	base := SeamStorageConfig{Endpoint: "https://x", BrokerAuth: secret}

	// Gate disabled: env unset ⇒ never trusted, even with a broker-auth header.
	t.Setenv("VULOS_STORAGE_BROKER_SECRET", "")
	if base.Trusted() {
		t.Fatal("Trusted() = true with no broker secret configured")
	}

	t.Setenv("VULOS_STORAGE_BROKER_SECRET", secret)
	if !base.Trusted() {
		t.Fatal("Trusted() = false with matching broker-auth")
	}
	if (SeamStorageConfig{Endpoint: "https://x", BrokerAuth: "wrong"}).Trusted() {
		t.Fatal("Trusted() = true with mismatched broker-auth")
	}
	if (SeamStorageConfig{Endpoint: "https://x"}).Trusted() {
		t.Fatal("Trusted() = true with missing broker-auth header")
	}
	if (SeamStorageConfig{BrokerAuth: secret}).Trusted() {
		t.Fatal("Trusted() = true with no endpoint (seam absent)")
	}
}

// TestSeamStorageConfig_TrustedHashedCompare pins the F5 fix: the broker-secret
// gate compares fixed-width sha256 digests, so a wrong secret of a DIFFERENT
// byte-length than the configured one is still rejected (a raw compare would
// short-circuit on length) while the correct secret — regardless of length — is
// still accepted, and an empty presented secret still fails closed.
func TestSeamStorageConfig_TrustedHashedCompare(t *testing.T) {
	for _, secret := range []string{"s", "broker-secret-123", strings.Repeat("x", 200)} {
		t.Setenv("VULOS_STORAGE_BROKER_SECRET", secret)

		if !(SeamStorageConfig{Endpoint: "https://x", BrokerAuth: secret}).Trusted() {
			t.Fatalf("correct secret (len=%d) not accepted", len(secret))
		}
		// Wrong secret whose length differs from the configured one — a raw
		// ConstantTimeCompare would leak the mismatch via the length short-circuit;
		// the hashed compare must still reject it.
		for _, wrong := range []string{"", "y", "wrong", strings.Repeat("z", 999)} {
			if wrong == secret {
				continue
			}
			if (SeamStorageConfig{Endpoint: "https://x", BrokerAuth: wrong}).Trusted() {
				t.Fatalf("wrong secret %q accepted against configured len=%d", wrong, len(secret))
			}
		}
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
