package storage

// backend_contract_test.go — dual-backend Storage interface contract tests.
//
// TestLocalStorageContract runs against the JSON-file local backend (always).
// TestPostgresStorageContract runs against a real Postgres instance when
// VULOS_TEST_POSTGRES_DSN is set; it is skipped otherwise so the default
// go test ./... path (no external services) still passes cleanly.
//
// Both tests exercise the same testStorageContract helper, ensuring that the
// Storage interface contract holds identically for both backends.

import (
	"os"
	"testing"

	"vulos-office/backend/config"
	"vulos-office/backend/models"
)

// testStorageContract is a backend-agnostic verification of the core Storage
// interface: create, get, update, list, delete a file; version history is
// created automatically on update and can be listed and restored.
func testStorageContract(t *testing.T, store Storage) {
	t.Helper()

	// ── File CRUD ────────────────────────────────────────────────────────────
	f := &models.File{
		ID:      "contract-test-file-1",
		Name:    "Contract Test",
		Type:    "doc",
		Content: map[string]any{"type": "doc", "content": []any{}},
	}

	// Create
	if err := store.CreateFile(f); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}

	// Get
	got, err := store.GetFile(f.ID)
	if err != nil {
		t.Fatalf("GetFile: %v", err)
	}
	if got.Name != f.Name {
		t.Fatalf("GetFile name: got %q, want %q", got.Name, f.Name)
	}
	if got.Type != f.Type {
		t.Fatalf("GetFile type: got %q, want %q", got.Type, f.Type)
	}

	// Update (also creates a version snapshot automatically in postgres backend)
	f.Name = "Contract Test Updated"
	if err := store.UpdateFile(f); err != nil {
		t.Fatalf("UpdateFile: %v", err)
	}
	got2, err := store.GetFile(f.ID)
	if err != nil {
		t.Fatalf("GetFile after update: %v", err)
	}
	if got2.Name != "Contract Test Updated" {
		t.Fatalf("UpdateFile name: got %q, want %q", got2.Name, "Contract Test Updated")
	}

	// List — the file must appear
	files, err := store.ListFiles()
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	found := false
	for _, ff := range files {
		if ff.ID == f.ID {
			found = true
			if ff.Name != "Contract Test Updated" {
				t.Fatalf("ListFiles stale name: got %q", ff.Name)
			}
			break
		}
	}
	if !found {
		t.Fatalf("ListFiles: file %q not found among %d results", f.ID, len(files))
	}

	// ── Version history ───────────────────────────────────────────────────────
	// Create an explicit named version.
	v := &models.FileVersion{
		ID:     "v-contract-1",
		FileID: f.ID,
		Name:   "Named snapshot",
		Label:  "v1-label",
	}
	if err := store.CreateVersion(v); err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}

	versions, err := store.ListVersions(f.ID)
	if err != nil {
		t.Fatalf("ListVersions: %v", err)
	}
	foundVer := false
	for _, vv := range versions {
		if vv.ID == "v-contract-1" {
			foundVer = true
		}
	}
	if !foundVer {
		t.Fatalf("ListVersions: version v-contract-1 not found")
	}

	// GetVersion by ID
	if _, err := store.GetVersion(f.ID, "v-contract-1"); err != nil {
		t.Fatalf("GetVersion: %v", err)
	}

	// LabelVersion
	if err := store.LabelVersion(f.ID, "v-contract-1", "release-1"); err != nil {
		t.Fatalf("LabelVersion: %v", err)
	}

	// PruneVersions (cap=0 → removes all, idempotent)
	if err := store.PruneVersions(f.ID, 0); err != nil {
		t.Fatalf("PruneVersions: %v", err)
	}

	// ── Suggestions (OFFICE-27) ───────────────────────────────────────────────
	sg := &models.Suggestion{
		ID:       "sg-contract-1",
		FileID:   f.ID,
		Kind:     models.SuggestionKind("insert"),
		State:    models.SuggestionState("pending"),
		AuthorID: "alice",
		From:     0,
		To:       5,
		Text:     "Hello",
	}
	if err := store.CreateSuggestion(sg); err != nil {
		t.Fatalf("CreateSuggestion: %v", err)
	}
	sgs, err := store.ListSuggestions(f.ID)
	if err != nil {
		t.Fatalf("ListSuggestions: %v", err)
	}
	if len(sgs) == 0 {
		t.Fatal("ListSuggestions: expected at least 1")
	}
	sg.State = models.SuggestionState("accepted")
	sg.ReviewerID = "bob"
	if err := store.UpdateSuggestion(sg); err != nil {
		t.Fatalf("UpdateSuggestion: %v", err)
	}
	if err := store.DeleteSuggestion(f.ID, sg.ID); err != nil {
		t.Fatalf("DeleteSuggestion: %v", err)
	}

	// ── Delete ────────────────────────────────────────────────────────────────
	if err := store.DeleteFile(f.ID); err != nil {
		t.Fatalf("DeleteFile: %v", err)
	}
	if _, err := store.GetFile(f.ID); err == nil {
		t.Fatal("GetFile after DeleteFile: expected error, got nil")
	}
}

// TestLocalStorageContract runs the contract test against the JSON-file backend.
// No external services required — always runs.
func TestLocalStorageContract(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.Server.DataDir = dir
	store, err := NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	testStorageContract(t, store)
}

// TestPostgresStorageContract runs the contract test against a live Postgres
// instance. Skipped when VULOS_TEST_POSTGRES_DSN is unset (standard CI path).
// Set VULOS_TEST_POSTGRES_DSN to a throwaway database URL to run it.
//
// The test uses the "office" Postgres schema, matching production.
func TestPostgresStorageContract(t *testing.T) {
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres storage contract test")
	}

	// Use databaseURL override path to exercise the env-var-driven backend
	// selection (same code path as production when DATABASE_URL is set).
	t.Setenv("DATABASE_URL", dsn)

	cfg := config.Default()
	store, err := New(cfg)
	if err != nil {
		t.Fatalf("New (postgres via DATABASE_URL): %v", err)
	}

	// Ensure clean state: remove any leftover row from a previous interrupted run.
	pg := store.(*PostgresStorage)
	_, _ = pg.pool.Exec(t.Context(), `DELETE FROM files WHERE id = 'contract-test-file-1'`)

	testStorageContract(t, store)
}
