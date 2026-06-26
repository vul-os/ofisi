package handlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

// fakeSeamServer captures the request the BucketStore makes so we can assert the
// injected-credential path is honored end-to-end (header read → client build →
// prefixed object key).
type seamCapture struct {
	mu     sync.Mutex
	hits   int
	method string
	path   string
}

func ctxWithSeamHeaders(endpoint, bucket, prefix string) *gin.Context {
	req := httptest.NewRequest(http.MethodPost, "/api/files", nil)
	req.Header.Set("X-Vulos-Storage-Endpoint", endpoint)
	req.Header.Set("X-Vulos-Storage-Bucket", bucket)
	req.Header.Set("X-Vulos-Storage-Prefix", prefix)
	req.Header.Set("X-Vulos-Storage-Region", "auto")
	req.Header.Set("X-Vulos-Storage-Access-Key", "AK")
	req.Header.Set("X-Vulos-Storage-Secret-Key", "SK")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = req
	return c
}

func TestBucketStore_SeamHeadersRouteToInjectedBucket(t *testing.T) {
	cap := &seamCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.mu.Lock()
		cap.hits++
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.mu.Unlock()
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := ctxWithSeamHeaders(srv.URL, "user-bucket", "users/alice")
	if err := SharedBucketStore().PutObject(c, "alice", "file/doc1", []byte("data"), "application/json"); err != nil {
		t.Fatalf("PutObject: %v", err)
	}

	cap.mu.Lock()
	defer cap.mu.Unlock()
	if cap.hits != 1 {
		t.Fatalf("expected 1 request to injected endpoint, got %d", cap.hits)
	}
	// OrgScopedKey flattens "file/doc1" to "file_doc1" (no VULOS_ORG_ID in test).
	want := "/user-bucket/users/alice/office/alice/file_doc1"
	if cap.path != want {
		t.Fatalf("object path = %q, want %q", cap.path, want)
	}
	if cap.method != http.MethodPut {
		t.Fatalf("method = %q, want PUT", cap.method)
	}
}

func TestBucketStore_NoSeamHeadersIsNoOp(t *testing.T) {
	// No headers + no process-wide OrgBucketClient configured ⇒ silent no-op.
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/files", nil)

	if err := SharedBucketStore().PutObject(c, "bob", "file/doc2", []byte("x"), "application/json"); err != nil {
		t.Fatalf("expected no-op nil error, got %v", err)
	}
	if data, err := SharedBucketStore().GetObject(c, "bob", "file/doc2"); err != nil || data != nil {
		t.Fatalf("expected (nil,nil) no-op, got (%v,%v)", data, err)
	}
	if err := SharedBucketStore().DeleteObject(c, "bob", "file/doc2"); err != nil {
		t.Fatalf("expected no-op nil error, got %v", err)
	}
}
