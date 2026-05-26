package storage

import (
	"context"
	"os"
	"testing"

	"vulos-office/backend/fileacl"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Compile-time guarantee that the co-located Postgres ACL store satisfies the
// fileacl.Store contract and that PostgresStorage advertises ACLProvider.
var (
	_ fileacl.Store = (*PostgresACLStore)(nil)
	_ ACLProvider   = (*PostgresStorage)(nil)
)

// TestPostgresACLContract exercises the full fileacl.Store contract against a
// real Postgres instance. It is SKIPPED unless VULOS_TEST_POSTGRES_DSN points at
// a throwaway database (CI without Postgres still passes; the logic is shared
// SQL identical in shape to the proven sqlite store).
func TestPostgresACLContract(t *testing.T) {
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres ACL contract test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// The ACL tables FK to files(id); ensure a files table + a seed row exist so
	// SetOwner/Share for "f1" satisfy the foreign key.
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS files (
			id TEXT PRIMARY KEY, name TEXT, type TEXT, content JSONB,
			created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
		);`); err != nil {
		t.Fatalf("files table: %v", err)
	}
	// Clean slate for the test ids.
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_shares WHERE file_id IN ('f1','doc')`)
	_, _ = pool.Exec(ctx, `DELETE FROM file_acl_owners WHERE file_id IN ('f1','doc')`)
	_, _ = pool.Exec(ctx, `INSERT INTO files (id, name, type) VALUES ('f1','f1','doc') ON CONFLICT DO NOTHING`)

	s := &PostgresStorage{pool: pool}
	acl := s.ACLStore()

	// Unknown file → unowned/allowed.
	if a, rec, _ := acl.CanAccess("nope", "anyone"); !a || rec {
		t.Fatalf("unknown file: allowed=%v recorded=%v", a, rec)
	}
	// Owner + non-owner.
	if err := acl.SetOwner("f1", "alice"); err != nil {
		t.Fatalf("SetOwner: %v", err)
	}
	if a, rec, _ := acl.CanAccess("f1", "alice"); !a || !rec {
		t.Fatalf("owner access: allowed=%v recorded=%v", a, rec)
	}
	if a, _, _ := acl.CanAccess("f1", "bob"); a {
		t.Fatal("non-owner should be denied")
	}
	// Share / unshare.
	if err := acl.Share("f1", "bob"); err != nil {
		t.Fatalf("Share: %v", err)
	}
	if a, _, _ := acl.CanAccess("f1", "bob"); !a {
		t.Fatal("shared account should have access")
	}
	ids, _ := acl.AccessibleFileIDs("bob")
	if !ids["f1"] {
		t.Fatal("AccessibleFileIDs should include shared f1 for bob")
	}
	if err := acl.Unshare("f1", "bob"); err != nil {
		t.Fatalf("Unshare: %v", err)
	}
	if a, _, _ := acl.CanAccess("f1", "bob"); a {
		t.Fatal("unshared account should lose access")
	}
	// Deleting the FILE cascades the ACL away (transactional travel-with-files).
	if _, err := pool.Exec(ctx, `DELETE FROM files WHERE id='f1'`); err != nil {
		t.Fatalf("delete file: %v", err)
	}
	if _, ok, _ := acl.Get("f1"); ok {
		t.Fatal("ACL should be cascade-deleted with the file")
	}
}
