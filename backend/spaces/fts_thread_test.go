package spaces_test

import (
	"path/filepath"
	"testing"

	"vulos-office/backend/models"
	"vulos-office/backend/spaces"
)

// newSQLiteStore opens a fresh durable store for FTS/threading tests.
func newSQLiteStore(t *testing.T) *spaces.SpacesStore {
	t.Helper()
	p, err := spaces.NewSQLitePersister(filepath.Join(t.TempDir(), "spaces.db"))
	if err != nil {
		t.Fatalf("open persister: %v", err)
	}
	s, err := spaces.Open("node-fts", p)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return s
}

// TestFTSSearchFindsAndPrefixMatches proves the FTS5 index returns matching
// message ids (incl. prefix matches) and excludes non-matches + tombstones.
func TestFTSSearchFindsAndPrefixMatches(t *testing.T) {
	s := newSQLiteStore(t)
	ch, _ := s.CreateChannel("eng", models.ChannelTypePublic, "alice")
	_, _ = s.AddMember(ch.ID, "alice")

	m1, _ := s.SendMessage(ch.ID, "alice", "the deployment pipeline is green", "")
	_, _ = s.SendMessage(ch.ID, "alice", "lunch at noon", "")
	m3, _ := s.SendMessage(ch.ID, "alice", "rolling back the deploy now", "")

	// "deploy" should prefix-match both "deployment" and "deploy".
	ids, ok := s.SearchIndexed(ch.ID, []string{"deploy"})
	if !ok {
		t.Fatal("expected FTS-capable persister (SearchIndexed ok=false)")
	}
	found := map[string]bool{}
	for _, id := range ids {
		found[id] = true
	}
	if !found[m1.ID] || !found[m3.ID] {
		t.Fatalf("FTS missed expected hits: ids=%v", ids)
	}
	if len(ids) != 2 {
		t.Fatalf("expected exactly 2 hits, got %d (%v)", len(ids), ids)
	}

	// Delete m3 → it must drop out of the index.
	if err := s.DeleteMessage(ch.ID, m3.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	ids, _ = s.SearchIndexed(ch.ID, []string{"deploy"})
	for _, id := range ids {
		if id == m3.ID {
			t.Fatal("tombstoned message still appears in FTS results")
		}
	}
}

// TestFTSEditReindexes proves an edited body is reflected in the index.
func TestFTSEditReindexes(t *testing.T) {
	s := newSQLiteStore(t)
	ch, _ := s.CreateChannel("eng", models.ChannelTypePublic, "alice")
	m, _ := s.SendMessage(ch.ID, "alice", "original keyword apple", "")

	if ids, _ := s.SearchIndexed(ch.ID, []string{"apple"}); len(ids) != 1 {
		t.Fatalf("pre-edit: expected 1 hit for apple, got %d", len(ids))
	}
	if _, err := s.EditMessage(ch.ID, m.ID, "now mentions banana instead"); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if ids, _ := s.SearchIndexed(ch.ID, []string{"apple"}); len(ids) != 0 {
		t.Fatalf("post-edit: apple should no longer match, got %d", len(ids))
	}
	if ids, _ := s.SearchIndexed(ch.ID, []string{"banana"}); len(ids) != 1 {
		t.Fatalf("post-edit: banana should match, got %d", len(ids))
	}
}

// TestThreadReplies proves replies are grouped under their parent in order and
// non-replies are excluded.
func TestThreadReplies(t *testing.T) {
	s := newSQLiteStore(t)
	ch, _ := s.CreateChannel("eng", models.ChannelTypePublic, "alice")
	parent, _ := s.SendMessage(ch.ID, "alice", "thread root", "")
	r1, _ := s.SendMessage(ch.ID, "bob", "first reply", parent.ID)
	r2, _ := s.SendMessage(ch.ID, "carol", "second reply", parent.ID)
	_, _ = s.SendMessage(ch.ID, "dave", "unrelated top-level", "")

	replies := s.ThreadReplies(ch.ID, parent.ID)
	if len(replies) != 2 {
		t.Fatalf("expected 2 replies, got %d", len(replies))
	}
	if replies[0].ID != r1.ID || replies[1].ID != r2.ID {
		t.Fatalf("replies out of order: %v", []string{replies[0].ID, replies[1].ID})
	}
}

// TestFTSMatchInjectionIsNeutralised proves FTS operators in user input cannot
// break out of the term match (no error / no over-broad results).
func TestFTSMatchInjectionIsNeutralised(t *testing.T) {
	s := newSQLiteStore(t)
	ch, _ := s.CreateChannel("eng", models.ChannelTypePublic, "alice")
	_, _ = s.SendMessage(ch.ID, "alice", "safe content here", "")

	// A would-be injection: FTS5 column/operator syntax. Must not error or match.
	ids, ok := s.SearchIndexed(ch.ID, []string{`body:"x" OR body:"y"`})
	if !ok {
		t.Fatal("SearchIndexed should be supported")
	}
	if len(ids) != 0 {
		t.Fatalf("injection-like token matched %d rows (expected 0)", len(ids))
	}
}
