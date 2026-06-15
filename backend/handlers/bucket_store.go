package handlers

// bucket_store.go — FIX-OFFICE-STORE-WIRE-01: thin wrapper around the org-bucket
// S3 client so file-CRUD and seal handlers can push blobs without importing the
// storage package's internal client directly.
//
// All methods nil-check OrgBucketClient() on every call — when no S3 backend is
// configured (OSS mode / no TIGRIS_*/VULOS_MINIO_* env vars) they return gracefully
// so callers can skip the S3 path without extra guard code.

import (
	"io"
	"log"

	"vulos-office/backend/storage"
)

// BucketStore is a thin convenience wrapper around the process-wide org-bucket
// S3 client. Create instances via SharedBucketStore().
type BucketStore struct{}

// sharedBucketStore is the process-wide singleton (always non-nil).
var sharedBucketStore = &BucketStore{}

// SharedBucketStore returns the process-wide BucketStore singleton.
// The BucketStore itself is always non-nil; the underlying S3 client may be nil
// when no S3 backend is configured, in which case every method is a no-op.
func SharedBucketStore() *BucketStore {
	return sharedBucketStore
}

// PutObject uploads data to the org-scoped key "<accountID>/<name>".
// When the S3 client is not configured (nil), it logs once and returns nil
// so callers can ignore the error and treat SQLite as the sole source.
// The contentType argument is informational — the underlying OfficeS3Client
// does not forward Content-Type headers in this iteration, but the parameter
// is kept for future use and API compatibility.
func (b *BucketStore) PutObject(accountID, name string, data []byte, _ string) error {
	client := storage.OrgBucketClient()
	if client == nil {
		return nil // S3 not configured — silent no-op
	}
	key := storage.OrgScopedKey(accountID, name)
	if err := client.Put(key, data); err != nil {
		log.Printf("[bucket_store] PutObject key=%q: %v", key, err)
		return err
	}
	return nil
}

// GetObject downloads the object at the org-scoped key "<accountID>/<name>".
// Returns (nil, nil) when the S3 client is not configured so callers can skip
// the S3 path cleanly.
func (b *BucketStore) GetObject(accountID, name string) ([]byte, error) {
	client := storage.OrgBucketClient()
	if client == nil {
		return nil, nil // S3 not configured — signal "no object, not an error"
	}
	key := storage.OrgScopedKey(accountID, name)
	rc, err := client.Get(key)
	if err != nil {
		log.Printf("[bucket_store] GetObject key=%q: %v", key, err)
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(rc)
	if err != nil {
		return nil, err
	}
	return data, nil
}

// DeleteObject removes the object at the org-scoped key "<accountID>/<name>".
// Silent no-op when S3 is not configured.
func (b *BucketStore) DeleteObject(accountID, name string) error {
	client := storage.OrgBucketClient()
	if client == nil {
		return nil // S3 not configured — no-op
	}
	key := storage.OrgScopedKey(accountID, name)
	if err := client.Delete(key); err != nil {
		log.Printf("[bucket_store] DeleteObject key=%q: %v", key, err)
		return err
	}
	return nil
}
