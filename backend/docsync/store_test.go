package docsync

import (
	"encoding/json"
	"testing"
)

func op(r string, c int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"k": 1, "id": map[string]any{"r": r, "c": c}})
	return b
}

// runStoreContract exercises the Store contract against any implementation so
// the SQLite and Null stores stay behaviourally identical.
func runStoreContract(t *testing.T, mk func() Store) {
	t.Helper()

	t.Run("append assigns monotonic seq", func(t *testing.T) {
		s := mk()
		defer s.Close()
		s1, err := s.AppendOp("d", "alice", op("alice", 1))
		if err != nil {
			t.Fatal(err)
		}
		s2, _ := s.AppendOp("d", "alice", op("alice", 2))
		if s1 != 1 || s2 != 2 {
			t.Fatalf("expected seq 1,2 got %d,%d", s1, s2)
		}
		if m, _ := s.MaxSeq("d"); m != 2 {
			t.Fatalf("MaxSeq expected 2, got %d", m)
		}
	})

	t.Run("load returns ops in order", func(t *testing.T) {
		s := mk()
		defer s.Close()
		s.AppendOp("d", "a", op("a", 1))
		s.AppendOp("d", "b", op("b", 1))
		st, err := s.Load("d")
		if err != nil {
			t.Fatal(err)
		}
		if len(st.Ops) != 2 || st.Ops[0].Seq != 1 || st.Ops[1].Seq != 2 {
			t.Fatalf("bad load: %+v", st)
		}
		if st.Ops[0].Origin != "a" || st.Ops[1].Origin != "b" {
			t.Fatalf("origins not preserved: %+v", st.Ops)
		}
	})

	t.Run("snapshot compacts folded ops", func(t *testing.T) {
		s := mk()
		defer s.Close()
		s.AppendOp("d", "a", op("a", 1))
		s.AppendOp("d", "a", op("a", 2))
		snap := json.RawMessage(`{"nodes":[]}`)
		base, err := s.SaveSnapshot("d", "a", snap)
		if err != nil {
			t.Fatal(err)
		}
		if base != 2 {
			t.Fatalf("snapshot base expected 2, got %d", base)
		}
		s.AppendOp("d", "a", op("a", 3))
		st, _ := s.Load("d")
		if len(st.Snap) == 0 {
			t.Fatal("snapshot not returned")
		}
		if len(st.Ops) != 1 || st.Ops[0].Seq != 3 {
			t.Fatalf("compaction failed, expected only seq=3: %+v", st.Ops)
		}
		if st.Seq != 3 {
			t.Fatalf("Seq should track max across snapshot+ops, got %d", st.Seq)
		}
	})

	t.Run("snapshot never regresses base", func(t *testing.T) {
		s := mk()
		defer s.Close()
		s.AppendOp("d", "a", op("a", 1))
		s.AppendOp("d", "a", op("a", 2))
		s.SaveSnapshot("d", "a", json.RawMessage(`{"n":2}`))
		// A stale snapshot at the same/older point must not overwrite.
		again, _ := s.SaveSnapshot("d", "a", json.RawMessage(`{"stale":true}`))
		if again != 2 {
			t.Fatalf("expected base to stay at 2, got %d", again)
		}
	})

	t.Run("delete purges state", func(t *testing.T) {
		s := mk()
		defer s.Close()
		s.AppendOp("d", "a", op("a", 1))
		if err := s.Delete("d"); err != nil {
			t.Fatal(err)
		}
		st, _ := s.Load("d")
		if st.Seq != 0 || len(st.Ops) != 0 || len(st.Snap) != 0 {
			t.Fatalf("delete left state: %+v", st)
		}
	})

	t.Run("op count tracks live log and drops on compaction", func(t *testing.T) {
		s := mk()
		defer s.Close()
		if n, err := s.OpCount("d"); err != nil || n != 0 {
			t.Fatalf("empty doc OpCount: got %d err=%v", n, err)
		}
		s.AppendOp("d", "a", op("a", 1))
		s.AppendOp("d", "a", op("a", 2))
		if n, _ := s.OpCount("d"); n != 2 {
			t.Fatalf("OpCount after 2 appends: got %d, want 2", n)
		}
		// A snapshot compacts the folded ops away — the live count drops.
		s.SaveSnapshot("d", "a", json.RawMessage(`{"nodes":[]}`))
		if n, _ := s.OpCount("d"); n != 0 {
			t.Fatalf("OpCount after compaction: got %d, want 0", n)
		}
		// A trailing op after the snapshot is counted; MaxSeq keeps climbing.
		s.AppendOp("d", "a", op("a", 3))
		if n, _ := s.OpCount("d"); n != 1 {
			t.Fatalf("OpCount after post-snapshot op: got %d, want 1", n)
		}
		if m, _ := s.MaxSeq("d"); m != 3 {
			t.Fatalf("MaxSeq should stay monotonic at 3, got %d", m)
		}
	})

	t.Run("empty doc id rejected", func(t *testing.T) {
		s := mk()
		defer s.Close()
		if _, err := s.AppendOp("", "a", op("a", 1)); err != ErrEmptyDocID {
			t.Fatalf("expected ErrEmptyDocID, got %v", err)
		}
	})

	t.Run("docs are isolated", func(t *testing.T) {
		s := mk()
		defer s.Close()
		s.AppendOp("d1", "a", op("a", 1))
		s.AppendOp("d2", "b", op("b", 1))
		if m, _ := s.MaxSeq("d1"); m != 1 {
			t.Fatalf("d1 seq: %d", m)
		}
		st2, _ := s.Load("d2")
		if len(st2.Ops) != 1 || st2.Ops[0].Origin != "b" {
			t.Fatalf("d2 leaked/lost: %+v", st2)
		}
	})
}

func TestSQLiteStore_Contract(t *testing.T) {
	runStoreContract(t, func() Store {
		s, err := NewSQLiteStore(":memory:")
		if err != nil {
			t.Fatalf("open sqlite: %v", err)
		}
		return s
	})
}

func TestNullStore_Contract(t *testing.T) {
	runStoreContract(t, func() Store { return NewNullStore() })
}
