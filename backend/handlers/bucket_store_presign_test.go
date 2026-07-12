package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"vulos-office/backend/deploymode"
	"vulos-office/backend/storage"

	"github.com/gin-gonic/gin"
)

// TestBucketStore_CloudPresignPath proves that when DEPLOY_MODE=cloud installs a
// presign client, BucketStore routes blob IO through the gateway presign
// endpoint (app_id="office", relative key, forwarded session cookie) and never
// through the raw process-wide S3 client.
func TestBucketStore_CloudPresignPath(t *testing.T) {
	var mu sync.Mutex
	var gotAppID, gotKey, gotCookie, gotMethod string
	var gotDeleteAppID, gotDeleteKey string
	objects := map[string][]byte{}

	// Fake S3 target for the presigned URLs.
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPut {
			b, _ := io.ReadAll(r.Body)
			objects[r.URL.Path] = b
			w.WriteHeader(http.StatusOK)
			return
		}
		if b, ok := objects[r.URL.Path]; ok {
			_, _ = w.Write(b)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer s3.Close()

	// Fake OS gateway: presign endpoint mints GET/PUT grants; the delete
	// endpoint is server-mediated (the gateway performs the delete itself,
	// there is no presigned-URL grant for DELETE — see presign.go).
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]string
		_ = json.NewDecoder(r.Body).Decode(&raw)

		if r.URL.Path == "/api/storage/delete" {
			mu.Lock()
			gotDeleteAppID, gotDeleteKey = raw["app_id"], raw["key"]
			full := "user-alice/office/" + raw["key"]
			delete(objects, "/bucket/"+full)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}

		req := struct{ AppID, Method, Key string }{raw["app_id"], raw["method"], raw["key"]}
		mu.Lock()
		gotAppID, gotKey, gotMethod = req.AppID, req.Key, req.Method
		if ck, err := r.Cookie("vc_session"); err == nil {
			gotCookie = ck.Value
		}
		mu.Unlock()
		full := "user-alice/office/" + req.Key
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":   "presigned",
			"method": req.Method,
			"bucket": "vulos-alice",
			"key":    full,
			"url":    s3.URL + "/bucket/" + full + "?sig=x",
		})
	}))
	defer gw.Close()

	// Install the cloud presign client (as ConfigureStorageMode would).
	t.Setenv(storage.EnvPresignURL, gw.URL)
	ConfigureStorageMode(deploymode.Cloud)
	t.Cleanup(func() { storagePresign = nil }) // restore standalone for other tests

	// Build a request carrying the end-user's vc_session cookie.
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	req := httptest.NewRequest(http.MethodPost, "/api/files", nil)
	req.AddCookie(&http.Cookie{Name: "vc_session", Value: "SESSION-XYZ"})
	c.Request = req

	if err := SharedBucketStore().PutObject(c, "alice", "file/doc9", []byte("cloudbytes"), "application/json"); err != nil {
		t.Fatalf("PutObject (cloud presign): %v", err)
	}

	mu.Lock()
	if gotAppID != "office" {
		t.Errorf("presign app_id = %q, want office", gotAppID)
	}
	if gotKey != "file/doc9" {
		t.Errorf("presign key = %q, want file/doc9 (relative; gateway composes the user/app prefix)", gotKey)
	}
	if gotCookie != "SESSION-XYZ" {
		t.Errorf("forwarded cookie = %q, want SESSION-XYZ", gotCookie)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("presign method = %q, want PUT", gotMethod)
	}
	storedUnder := ""
	for k := range objects {
		storedUnder = k
	}
	if !strings.Contains(storedUnder, "/user-alice/office/file/doc9") {
		t.Errorf("object stored at %q, want …/user-alice/office/file/doc9", storedUnder)
	}
	mu.Unlock()

	// Round-trip read.
	data, err := SharedBucketStore().GetObject(c, "alice", "file/doc9")
	if err != nil {
		t.Fatalf("GetObject (cloud presign): %v", err)
	}
	if string(data) != "cloudbytes" {
		t.Fatalf("GetObject = %q, want cloudbytes", data)
	}

	// Delete goes through the gateway's server-mediated delete endpoint (no
	// presign grant — see presign.go) and actually removes the object.
	if err := SharedBucketStore().DeleteObject(c, "alice", "file/doc9"); err != nil {
		t.Fatalf("DeleteObject (cloud presign): %v", err)
	}
	mu.Lock()
	if gotDeleteAppID != "office" {
		t.Errorf("delete app_id = %q, want office", gotDeleteAppID)
	}
	if gotDeleteKey != "file/doc9" {
		t.Errorf("delete key = %q, want file/doc9 (relative)", gotDeleteKey)
	}
	mu.Unlock()

	// The object is actually gone: a subsequent GetObject returns (nil, nil).
	data2, err := SharedBucketStore().GetObject(c, "alice", "file/doc9")
	if err != nil {
		t.Fatalf("GetObject after delete: %v", err)
	}
	if data2 != nil {
		t.Fatalf("GetObject after delete = %q, want nil (object removed)", data2)
	}
}

// TestConfigureStorageMode_NonCloudLeavesPresignNil asserts standalone/os modes
// never install the presign client (they use the header-seam / process client).
func TestConfigureStorageMode_NonCloudLeavesPresignNil(t *testing.T) {
	t.Cleanup(func() { storagePresign = nil })
	storagePresign = nil
	ConfigureStorageMode(deploymode.Standalone)
	if storagePresign != nil {
		t.Errorf("standalone must not install a presign client")
	}
	ConfigureStorageMode(deploymode.OS)
	if storagePresign != nil {
		t.Errorf("os mode must not install a presign client")
	}
}
