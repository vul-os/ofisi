package spaces_test

import (
	"path/filepath"
	"testing"

	"vulos-office/backend/models"
	"vulos-office/backend/spaces"
)

// TestSQLitePersistenceRoundtrip proves messages, channels, memberships, and
// read-state survive a "restart" (re-opening the store against the same DB
// file).
func TestSQLitePersistenceRoundtrip(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "spaces.db")

	// --- session 1: write some state, then close ---
	p1, err := spaces.NewSQLitePersister(dbPath)
	if err != nil {
		t.Fatalf("open persister: %v", err)
	}
	s1, err := spaces.Open("node-A", p1)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}

	ch, err := s1.CreateChannel("general", models.ChannelTypePublic, "alice")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	if _, err := s1.AddMember(ch.ID, "alice"); err != nil {
		t.Fatalf("add member: %v", err)
	}
	msg, err := s1.SendMessage(ch.ID, "alice", "persist me", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := s1.MarkRead("alice", ch.ID, msg.SeqClock); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if err := p1.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// --- session 2: re-open the same DB and verify state survived ---
	p2, err := spaces.NewSQLitePersister(dbPath)
	if err != nil {
		t.Fatalf("reopen persister: %v", err)
	}
	defer p2.Close()
	s2, err := spaces.Open("node-A", p2)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}

	chs := s2.ListChannels()
	if len(chs) != 1 {
		t.Fatalf("expected 1 channel after restart, got %d", len(chs))
	}
	if chs[0].ID != ch.ID || chs[0].Name != "general" {
		t.Fatalf("channel mismatch after restart: %+v", chs[0])
	}

	if !s2.IsMember(ch.ID, "alice") {
		t.Fatal("membership did not survive restart")
	}

	msgs := s2.ListMessages(ch.ID)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message after restart, got %d", len(msgs))
	}
	if msgs[0].ID != msg.ID || msgs[0].Body != "persist me" || msgs[0].AuthorID != "alice" {
		t.Fatalf("message mismatch after restart: %+v", msgs[0])
	}

	rs, err := s2.GetReadState("alice", ch.ID)
	if err != nil {
		t.Fatalf("get read state: %v", err)
	}
	if rs.LastReadClock != msg.SeqClock {
		t.Fatalf("read state did not survive: got %q want %q", rs.LastReadClock, msg.SeqClock)
	}

	// Op-log must replay for cold joiners too.
	ops, err := s2.ExportOps(ch.ID, "")
	if err != nil {
		t.Fatalf("export ops: %v", err)
	}
	if len(ops) != 1 {
		t.Fatalf("expected 1 op after restart, got %d", len(ops))
	}
}

// TestMergeOpsAsRejectsForgery is a store-level guard test for author forgery.
func TestMergeOpsAsRejectsForgery(t *testing.T) {
	p := spaces.NewNullPersister()
	s, _ := spaces.Open("node-A", p)

	forged := []*models.MessageOp{{
		Op:        models.MessageOpAppend,
		ChannelID: "c1",
		Msg: models.Message{
			ID:        "x",
			ChannelID: "c1",
			AuthorID:  "alice", // forged; caller is mallory
			SeqClock:  "00000000000000000001-0000000000-z",
			State:     models.MessageStateActive,
		},
	}}
	if err := s.MergeOpsAs("mallory", forged); err == nil {
		t.Fatal("expected MergeOpsAs to reject forged author")
	}

	// Self-authored op is accepted.
	good := []*models.MessageOp{{
		Op:        models.MessageOpAppend,
		ChannelID: "c1",
		Msg: models.Message{
			ID:        "y",
			ChannelID: "c1",
			AuthorID:  "mallory",
			SeqClock:  "00000000000000000002-0000000000-z",
			State:     models.MessageStateActive,
		},
	}}
	if err := s.MergeOpsAs("mallory", good); err != nil {
		t.Fatalf("expected self-authored op to be accepted: %v", err)
	}
}
