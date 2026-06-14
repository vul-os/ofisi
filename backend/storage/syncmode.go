// syncmode.go — OfficeSyncMode constants used by the storage backend resolver.
// The former sync.go (which imported the now-deleted crdt package) has been
// removed; only the mode type that resolve.go needs is retained here.
package storage

// OfficeSyncMode selects how an office box converges with the rest of its org.
type OfficeSyncMode string

const (
	// OfficeSyncDirect is the default: object-store-direct, no peer sync.
	OfficeSyncDirect OfficeSyncMode = "direct"

	// OfficeSyncLocalMinio opts into CRDT peer sync across the org's boxes.
	OfficeSyncLocalMinio OfficeSyncMode = "local-minio-sync"
)
