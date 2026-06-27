package handlers

// file_authz.go — per-file authorization shared by every file-scoped handler
// (files, versions, activity, comments, suggestions, exports). This closes the
// P0 hole where Get/Update/Delete ignored the authenticated identity and List
// returned all files globally.
//
// The verified identity comes from requesterID(c) (JWT sub), and a denied request
// returns 404 — NOT 403 — so the response never leaks whether a file the caller
// cannot see actually exists.

import (
	"log"
	"net/http"
	"os"
	"sync"

	"vulos-office/backend/fileacl"
	"vulos-office/backend/middleware"
	"vulos-office/backend/storage"

	"github.com/gin-gonic/gin"
)

// FileAuthz wraps a fileacl.Store and provides gin-aware access enforcement.
//
// authEnabled mirrors cfg.Auth.Enabled. It changes the fail-safe posture:
//
//   - auth DISABLED (OSS single-user / local mode): a degraded/nil store or an
//     unowned/legacy file fails OPEN so the operator is never locked out of
//     pre-existing documents.
//   - auth ENABLED (multi-tenant): NO fail-open. A nil/degraded store denies,
//     and an unowned file is NOT globally readable (it is denied for non-owners)
//     so a missing owner record can never leak another tenant's document.
type FileAuthz struct {
	acl         fileacl.Store
	authEnabled bool
}

// fileACLDBPath resolves the ACL SQLite DSN from env, defaulting to a durable
// file under the data dir.
func fileACLDBPath() string {
	if v := os.Getenv("VULOS_FILEACL_DB"); v != "" {
		return v
	}
	return "./data/fileacl.db"
}

var (
	defaultFileAuthz *FileAuthz
	fileAuthzOnce    sync.Once
)

// SharedFileAuthz returns a process-wide FileAuthz backed by durable SQLite.
// If the DB cannot be opened it falls back to an in-memory NullStore so the app
// still boots (degraded: ACLs do not persist) rather than crashing.
func SharedFileAuthz() *FileAuthz {
	fileAuthzOnce.Do(func() {
		if st, err := fileacl.NewSQLiteStore(fileACLDBPath()); err == nil {
			defaultFileAuthz = &FileAuthz{acl: st}
		} else {
			defaultFileAuthz = &FileAuthz{acl: fileacl.NewNullStore()}
		}
	})
	return defaultFileAuthz
}

// InitFileAuthz wires the process-wide FileAuthz to the ACL store that travels
// with the active storage backend. When the backend implements
// storage.ACLProvider (Postgres), its co-located ACL store is used so ownership
// is in the SAME database (transactional + replicated) as the files. Otherwise
// (sqlite/local backend) the separate sqlite ACL store is used. Call ONCE from
// main() before constructing the file handlers; it pins the sync.Once so later
// SharedFileAuthz() calls return the same authorizer.
//
// authEnabled MUST reflect cfg.Auth.Enabled. When auth is enabled the ACL store
// is load-bearing for multi-tenant isolation, so a failure to open it is FATAL
// (we refuse to boot in a degraded, fail-open posture). When auth is disabled
// (OSS single-user) a degraded in-memory NullStore is acceptable.
func InitFileAuthz(store storage.Storage, authEnabled bool) *FileAuthz {
	fileAuthzOnce.Do(func() {
		if p, ok := store.(storage.ACLProvider); ok {
			defaultFileAuthz = &FileAuthz{acl: p.ACLStore(), authEnabled: authEnabled}
			return
		}
		if st, err := fileacl.NewSQLiteStore(fileACLDBPath()); err == nil {
			defaultFileAuthz = &FileAuthz{acl: st, authEnabled: authEnabled}
		} else if authEnabled {
			// Multi-tenant mode: never run with a degraded, fail-open ACL store.
			log.Fatalf("file ACL store open failed (%s) with auth enabled: %v "+
				"(refusing to boot without per-file isolation)", fileACLDBPath(), err)
		} else {
			defaultFileAuthz = &FileAuthz{acl: fileacl.NewNullStore(), authEnabled: false}
		}
	})
	return defaultFileAuthz
}

// NewFileAuthz builds a FileAuthz over a caller-supplied store (tests).
func NewFileAuthz(acl fileacl.Store) *FileAuthz {
	return &FileAuthz{acl: acl}
}

// NewFileAuthzWithAuth builds a FileAuthz over a caller-supplied store with an
// explicit auth posture (tests that exercise the multi-tenant fail-closed path).
func NewFileAuthzWithAuth(acl fileacl.Store, authEnabled bool) *FileAuthz {
	return &FileAuthz{acl: acl, authEnabled: authEnabled}
}

// Store exposes the underlying ACL store for owner-recording on file create
// and share management.
func (a *FileAuthz) Store() fileacl.Store { return a.acl }

// multiTenant reports whether auth is enabled (nil-safe). In multi-tenant mode
// the ACL store is load-bearing and there is NO fail-open.
func (a *FileAuthz) multiTenant() bool { return a != nil && a.authEnabled }

// canAccess reports whether the caller may touch fileID. Admins always pass.
func (a *FileAuthz) canAccess(c *gin.Context, fileID string) bool {
	if a == nil || a.acl == nil {
		// No authorizer wired (degraded). When auth is enabled this MUST fail
		// closed: a degraded ACL store can never grant cross-tenant access. When
		// auth is disabled (single-user) fail open so the operator isn't locked out.
		return !a.multiTenant()
	}
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	allowed, recorded, err := a.acl.CanAccess(fileID, requesterID(c))
	if err != nil {
		// On a storage error, fail closed for safety.
		return false
	}
	// When auth is enabled, an UNOWNED/legacy file (no recorded owner) must NOT
	// be globally readable — that would leak any file whose owner record is
	// missing. Deny non-owners in multi-tenant mode; the fail-safe "unowned ⇒
	// allow" is only for single-user/local (auth-disabled) mode.
	if a.authEnabled && !recorded {
		return false
	}
	return allowed
}

// require enforces access on a file op. On denial it writes a 404 (no existence
// leak) and returns false. Callers should `return` immediately when it is false.
func (a *FileAuthz) require(c *gin.Context, fileID string) bool {
	if a.canAccess(c, fileID) {
		return true
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
	return false
}

// recordOwner stamps the creating identity as the owner of a new file. Called
// from FileHandler.Create. It returns an error so the caller can fail the create
// when ownership could not be recorded: in multi-tenant mode an unowned file is
// NOT globally readable, so a swallowed SetOwner error would otherwise leave the
// new document INACCESSIBLE to its creator (and a regression of the old fail-open
// behaviour would leave it accessible to everyone). Either way the create must
// not silently succeed with no owner.
//
// In single-user / auth-disabled mode a nil store is fine (no isolation needed).
func (a *FileAuthz) recordOwner(c *gin.Context, fileID string) error {
	if a == nil || a.acl == nil {
		return nil
	}
	return a.acl.SetOwner(fileID, requesterID(c))
}

// CanAccessAs reports whether accountID may access fileID, WITHOUT a gin
// context. It mirrors canAccess for non-HTTP callers that act on behalf of a
// specific account and are never admins — notably the Apps & Bots platform
// adapter, where an installed app acts as its installing owner. The same
// fail-safe posture applies: in multi-tenant mode an unowned/legacy file is NOT
// readable by a non-owner, and a degraded store denies.
func (a *FileAuthz) CanAccessAs(fileID, accountID string) bool {
	if a == nil || a.acl == nil {
		return !a.multiTenant()
	}
	allowed, recorded, err := a.acl.CanAccess(fileID, accountID)
	if err != nil {
		return false
	}
	if a.authEnabled && !recorded {
		return false
	}
	return allowed
}

// RecordOwnerAs stamps accountID as the owner of fileID, WITHOUT a gin context.
// Used when the Apps & Bots adapter creates a document on behalf of an app's
// installing owner so the new file is private to that account by default.
func (a *FileAuthz) RecordOwnerAs(fileID, accountID string) error {
	if a == nil || a.acl == nil {
		return nil
	}
	return a.acl.SetOwner(fileID, accountID)
}

// canAccessEnvelopeACL reports whether the caller may touch an envelope. The
// e-signature subsystem ties an envelope to the per-file ACL: access is granted
// when the caller can access the envelope's SourceFileID (the document being
// signed) OR the envelope id itself (recorded as ACL-owned by the creator so
// envelopes with an empty/unowned SourceFileID are still private). Admins pass
// via canAccess. This is the single authorization predicate shared by the
// envelope CRUD, send, seal, and orchestration handlers.
func (a *FileAuthz) canAccessEnvelopeACL(c *gin.Context, sourceFileID, envelopeID string) bool {
	if a == nil || a.acl == nil {
		// Degraded: fail open only in single-user mode; fail closed under auth.
		return !a.multiTenant()
	}
	if sourceFileID != "" && a.canAccess(c, sourceFileID) {
		return true
	}
	return a.canAccess(c, envelopeID)
}
