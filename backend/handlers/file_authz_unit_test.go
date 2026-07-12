package handlers

// file_authz_unit_test.go — WAVE32 coverage. Direct unit tests for the FileAuthz
// predicates that the HTTP-level pentests don't reach:
//
//   - CanAccessAs / RecordOwnerAs — the NON-HTTP Apps & Bots adapter path
//     (0% covered), where an installed app acts as its installing owner. A bug
//     here would let one tenant's app read another tenant's document.
//   - requireOwner / requireEditor role-denial branches (403 for viewer/
//     commenter) and the GetRole storage-error branch (500, fail closed).
//   - canAccessEnvelopeACL fallback to the envelope id.

import (
	"net/http/httptest"
	"testing"

	"vulos-office/backend/fileacl"
	"vulos-office/backend/middleware"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// ctxFor builds a gin context carrying a verified identity (and optional admin).
func ctxFor(user string, admin bool) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set(middleware.CtxAuthenticated, true)
	c.Set(middleware.CtxUserID, user)
	if admin {
		c.Set(middleware.CtxIsAdmin, true)
	}
	return c
}

// errStore is a fileacl.Store whose reads fail, to exercise the fail-closed
// storage-error branches of the authorizer.
type errStore struct{ fileacl.Store }

func (errStore) CanAccess(string, string) (bool, bool, error) {
	return false, false, assertErr
}
func (errStore) GetRole(string, string) (fileacl.Role, bool, error) {
	return fileacl.RoleNone, false, assertErr
}

var assertErr = &fakeErr{}

type fakeErr struct{}

func (*fakeErr) Error() string { return "boom" }

// --- CanAccessAs / RecordOwnerAs (non-HTTP adapter path) -------------------

func TestCanAccessAs_MultiTenant(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true) // auth enabled → strict isolation

	// Record owner via the non-HTTP path.
	if err := az.RecordOwnerAs("doc", "alice"); err != nil {
		t.Fatalf("RecordOwnerAs: %v", err)
	}

	if !az.CanAccessAs("doc", "alice") {
		t.Error("owner should access own doc via CanAccessAs")
	}
	// Cross-tenant: another account must be denied on a recorded file.
	if az.CanAccessAs("doc", "mallory") {
		t.Error("non-owner must be denied via CanAccessAs in multi-tenant mode")
	}
	// Unowned/legacy file: in multi-tenant mode NOT globally readable (recorded=false).
	if az.CanAccessAs("unowned-file", "anyone") {
		t.Error("unowned file must NOT be readable by a non-owner under auth")
	}
}

func TestCanAccessAs_SingleUserFailOpen(t *testing.T) {
	// auth disabled → unowned file fails OPEN (single-user / OSS local mode).
	az := NewFileAuthz(fileacl.NewNullStore()) // authEnabled=false
	if !az.CanAccessAs("unowned", "self") {
		t.Error("single-user mode: unowned file should be accessible")
	}
}

func TestCanAccessAs_DegradedStore(t *testing.T) {
	// Nil ACL store: multi-tenant denies, single-user allows.
	degradedAuth := &FileAuthz{acl: nil, authEnabled: true}
	if degradedAuth.CanAccessAs("f", "a") {
		t.Error("degraded store under auth must fail closed")
	}
	degradedNoAuth := &FileAuthz{acl: nil, authEnabled: false}
	if !degradedNoAuth.CanAccessAs("f", "a") {
		t.Error("degraded store without auth should fail open (single-user)")
	}
}

func TestCanAccessAs_StorageError(t *testing.T) {
	az := NewFileAuthzWithAuth(errStore{}, true)
	if az.CanAccessAs("f", "a") {
		t.Error("CanAccessAs must fail closed on a storage error")
	}
}

func TestRecordOwnerAs_NilStoreIsNoop(t *testing.T) {
	az := &FileAuthz{acl: nil}
	if err := az.RecordOwnerAs("f", "a"); err != nil {
		t.Errorf("RecordOwnerAs on nil store should be a no-op, got %v", err)
	}
}

// --- requireOwner / requireEditor role branches ---------------------------

func TestRequireOwner_DeniesNonOwnerCollaborator(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "bob", fileacl.RoleEditor) // editor, not owner

	// bob has access (so no 404) but is not the owner → 403.
	c := ctxFor("bob", false)
	c.Params = gin.Params{{Key: "id", Value: "doc"}}
	if az.requireOwner(c, "doc") {
		t.Error("editor must NOT pass requireOwner")
	}
	if got := c.Writer.Status(); got != 403 {
		t.Errorf("requireOwner denial status = %d; want 403", got)
	}
}

func TestRequireOwner_OwnerAndAdminPass(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")

	if !az.requireOwner(ctxFor("alice", false), "doc") {
		t.Error("owner must pass requireOwner")
	}
	// Admin bypasses ownership even on someone else's file.
	if !az.requireOwner(ctxFor("root", true), "doc") {
		t.Error("admin must pass requireOwner")
	}
}

func TestRequireEditor_DeniesViewerAndCommenter(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "vic", fileacl.RoleViewer)
	_ = acl.ShareWithRole("doc", "com", fileacl.RoleCommenter)

	for _, u := range []string{"vic", "com"} {
		c := ctxFor(u, false)
		if az.requireEditor(c, "doc") {
			t.Errorf("%s (read-only role) must NOT pass requireEditor", u)
		}
		if got := c.Writer.Status(); got != 403 {
			t.Errorf("%s requireEditor denial status = %d; want 403", u, got)
		}
	}

	// Editor and owner pass.
	_ = acl.ShareWithRole("doc", "ed", fileacl.RoleEditor)
	if !az.requireEditor(ctxFor("ed", false), "doc") {
		t.Error("editor must pass requireEditor")
	}
	if !az.requireEditor(ctxFor("alice", false), "doc") {
		t.Error("owner must pass requireEditor")
	}
}

func TestRequireEditor_StorageErrorFailsClosed(t *testing.T) {
	// A GetRole storage error must 500 and deny (fail closed), never allow.
	// require() calls CanAccess (also errStore → false), so this actually hits
	// the 404 base-denial path; assert denial regardless of code.
	az := NewFileAuthzWithAuth(errStore{}, true)
	c := ctxFor("x", false)
	if az.requireEditor(c, "doc") {
		t.Error("requireEditor must fail closed on storage error")
	}
}

func TestRequireCommenter_DeniesViewerOnly(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	_ = acl.SetOwner("doc", "alice")
	_ = acl.ShareWithRole("doc", "vic", fileacl.RoleViewer)
	_ = acl.ShareWithRole("doc", "com", fileacl.RoleCommenter)
	_ = acl.ShareWithRole("doc", "ed", fileacl.RoleEditor)

	c := ctxFor("vic", false)
	if az.requireCommenter(c, "doc") {
		t.Error("VULN: viewer must NOT pass requireCommenter")
	}
	if got := c.Writer.Status(); got != 403 {
		t.Errorf("viewer requireCommenter denial status = %d; want 403", got)
	}

	for _, u := range []string{"com", "ed", "alice"} {
		if !az.requireCommenter(ctxFor(u, false), "doc") {
			t.Errorf("%s must pass requireCommenter", u)
		}
	}
	// Admin bypasses role checks entirely.
	if !az.requireCommenter(ctxFor("root", true), "doc") {
		t.Error("admin must pass requireCommenter")
	}
}

func TestRequireCommenter_StorageErrorFailsClosed(t *testing.T) {
	az := NewFileAuthzWithAuth(errStore{}, true)
	c := ctxFor("x", false)
	if az.requireCommenter(c, "doc") {
		t.Error("requireCommenter must fail closed on storage error")
	}
}

func TestRequireCommenter_DisabledAuthIsPermissive(t *testing.T) {
	az := NewFileAuthz(fileacl.NewNullStore()) // authEnabled=false
	if !az.requireCommenter(ctxFor("self", false), "anydoc") {
		t.Error("single-user mode requireCommenter should pass")
	}
}

func TestRequireEditor_DisabledAuthIsPermissive(t *testing.T) {
	// Single-user mode: role enforcement is a no-op beyond base access.
	az := NewFileAuthz(fileacl.NewNullStore()) // authEnabled=false
	if !az.requireEditor(ctxFor("self", false), "anydoc") {
		t.Error("single-user mode requireEditor should pass")
	}
}

// --- canAccessEnvelopeACL fallback ----------------------------------------

func TestCanAccessEnvelopeACL_FallsBackToEnvelopeID(t *testing.T) {
	acl := fileacl.NewNullStore()
	az := NewFileAuthzWithAuth(acl, true)
	// Envelope with an unowned source file, but the envelope id itself is owned.
	_ = acl.SetOwner("env-123", "alice")

	c := ctxFor("alice", false)
	if !az.canAccessEnvelopeACL(c, "" /*no source file*/, "env-123") {
		t.Error("owner of the envelope id must be granted access")
	}
	// A stranger owns neither the source file nor the envelope id → denied.
	if az.canAccessEnvelopeACL(ctxFor("mallory", false), "", "env-123") {
		t.Error("stranger must be denied envelope access")
	}
}
