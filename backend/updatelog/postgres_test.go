package updatelog

// postgres_test.go — mirrors the LocalStore unit tests against a REAL Postgres
// instance so the transactional append/prune/stale-snapshot semantics are
// validated on the production backend, not only the filesystem mirror. Skipped
// unless VULOS_TEST_POSTGRES_DSN points at a throwaway database (same gate as
// backend/storage/postgres_optlock_test.go).

import (
	"bytes"
	"context"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newPostgresStore opens a pool against the throwaway DSN, pins search_path to
// "office", and returns a store scoped to a unique file-id prefix so parallel
// runs / reruns never collide. Each returned file id is cleaned up.
func newPostgresStore(t *testing.T) (*PostgresStore, func(fileID string)) {
	t.Helper()
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres update-log tests")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "office"
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	s, err := NewPostgresStore(pool)
	if err != nil {
		t.Fatalf("NewPostgresStore: %v", err)
	}
	cleanup := func(fileID string) {
		_, _ = pool.Exec(context.Background(), `DELETE FROM file_updates WHERE file_id = $1`, fileID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM file_update_snapshots WHERE file_id = $1`, fileID)
	}
	return s, cleanup
}

func TestPostgresAppendAssignsMonotonicSeq(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const f1, f2 = "pg-ul-mono-1", "pg-ul-mono-2"
	cleanup(f1)
	cleanup(f2)
	t.Cleanup(func() { cleanup(f1); cleanup(f2) })

	for i := int64(1); i <= 5; i++ {
		f, err := s.Append(f1, FrameKindUpdate, []byte{byte(i)}, "peerA", 0)
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		if f.Seq != i {
			t.Fatalf("append %d: seq = %d, want %d", i, f.Seq, i)
		}
	}
	head, err := s.Head(f1)
	if err != nil || head != 5 {
		t.Fatalf("Head = %d, %v; want 5", head, err)
	}
	// A different file has its own independent sequence.
	f, _ := s.Append(f2, FrameKindUpdate, []byte{9}, "peerB", 0)
	if f.Seq != 1 {
		t.Fatalf("second file first seq = %d, want 1", f.Seq)
	}
}

func TestPostgresLoadFullAndIncremental(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const id = "pg-ul-load-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	payloads := [][]byte{[]byte("a"), []byte("b"), []byte("c")}
	for _, p := range payloads {
		if _, err := s.Append(id, FrameKindUpdate, p, "p", 0); err != nil {
			t.Fatal(err)
		}
	}
	full, err := s.Load(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	if full.Head != 3 || len(full.Frames) != 3 || full.Snapshot != nil {
		t.Fatalf("full load: head=%d frames=%d snap=%v", full.Head, len(full.Frames), full.Snapshot)
	}
	for i, f := range full.Frames {
		got, _ := DecodeFrame(f)
		if !bytes.Equal(got, payloads[i]) {
			t.Fatalf("frame %d data = %q, want %q", i, got, payloads[i])
		}
		if f.Seq != int64(i+1) {
			t.Fatalf("frame %d seq = %d", i, f.Seq)
		}
	}
	inc, err := s.Load(id, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(inc.Frames) != 1 || inc.Frames[0].Seq != 3 {
		t.Fatalf("incremental load = %+v", inc.Frames)
	}
}

func TestPostgresSnapshotCompactionPrunesFloorAndKeepsAbove(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const id = "pg-ul-compact-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	for i := 0; i < 4; i++ { // seqs 1..4
		if _, err := s.Append(id, FrameKindUpdate, []byte{byte(i)}, "p", 0); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := s.Append(id, FrameKindSnapshot, []byte("STATE"), "p", 3) // seq 5, floor 3
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snap.Seq != 5 || snap.Floor != 3 {
		t.Fatalf("snapshot seq=%d floor=%d, want 5/3", snap.Seq, snap.Floor)
	}

	full, err := s.Load(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	if full.Snapshot == nil {
		t.Fatal("expected snapshot in full load")
	}
	if got, _ := DecodeFrame(full.Snapshot); string(got) != "STATE" {
		t.Fatalf("snapshot data = %q", got)
	}
	if len(full.Frames) != 1 || full.Frames[0].Seq != 4 {
		t.Fatalf("post-compaction frames = %+v, want just seq 4", full.Frames)
	}
	if full.Head != 5 {
		t.Fatalf("head = %d, want 5", full.Head)
	}
	// New appends continue past the snapshot seq.
	next, _ := s.Append(id, FrameKindUpdate, []byte("z"), "p", 0)
	if next.Seq != 6 {
		t.Fatalf("post-snapshot append seq = %d, want 6", next.Seq)
	}
}

func TestPostgresLoadPastFloorSkipsSnapshot(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const id = "pg-ul-pastfloor-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	for i := 0; i < 3; i++ {
		s.Append(id, FrameKindUpdate, []byte{byte(i)}, "p", 0)
	}
	s.Append(id, FrameKindSnapshot, []byte("S"), "p", 3) // seq 4, floor 3
	s.Append(id, FrameKindUpdate, []byte("x"), "p", 0)   // seq 5

	inc, err := s.Load(id, 4)
	if err != nil {
		t.Fatal(err)
	}
	if inc.Snapshot != nil {
		t.Fatal("caller past the floor should not be re-sent the snapshot")
	}
	if len(inc.Frames) != 1 || inc.Frames[0].Seq != 5 {
		t.Fatalf("frames = %+v, want just seq 5", inc.Frames)
	}
}

func TestPostgresStaleSnapshotRejected(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const id = "pg-ul-stale-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	for i := 0; i < 4; i++ {
		s.Append(id, FrameKindUpdate, []byte{byte(i)}, "p", 0)
	}
	if _, err := s.Append(id, FrameKindSnapshot, []byte("S1"), "p", 4); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(id, FrameKindSnapshot, []byte("S0"), "p", 2); err == nil {
		t.Fatal("expected stale-snapshot rejection")
	}
}

func TestPostgresPendingCountsUncompactedTail(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const id = "pg-ul-pending-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	if n, _ := s.Pending(id); n != 0 {
		t.Fatalf("empty Pending = %d, want 0", n)
	}
	for i := 0; i < 5; i++ {
		s.Append(id, FrameKindUpdate, []byte{byte(i)}, "p", 0)
	}
	if n, _ := s.Pending(id); n != 5 {
		t.Fatalf("Pending after 5 appends = %d, want 5", n)
	}
	s.Append(id, FrameKindSnapshot, []byte("S"), "p", 3)
	if n, _ := s.Pending(id); n != 2 {
		t.Fatalf("Pending after snapshot(floor=3) = %d, want 2", n)
	}
}

// TestPostgresConcurrentAppendMonotonic is the payoff of a real database: N
// goroutines append to the SAME file at once; the per-file advisory lock must
// serialise them so every seq from 1..N is assigned exactly once (no dup, no
// gap) — the cross-process analogue of LocalStore's per-file mutex.
func TestPostgresConcurrentAppendMonotonic(t *testing.T) {
	s, cleanup := newPostgresStore(t)
	const id = "pg-ul-race-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	const n = 24
	var wg sync.WaitGroup
	var mu sync.Mutex
	seqs := map[int64]int{}
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(k int) {
			defer wg.Done()
			<-start
			f, err := s.Append(id, FrameKindUpdate, []byte{byte(k)}, "p", 0)
			if err != nil {
				t.Errorf("append: %v", err)
				return
			}
			mu.Lock()
			seqs[f.Seq]++
			mu.Unlock()
		}(i)
	}
	close(start)
	wg.Wait()

	if len(seqs) != n {
		t.Fatalf("expected %d distinct seqs, got %d", n, len(seqs))
	}
	for i := int64(1); i <= n; i++ {
		if seqs[i] != 1 {
			t.Fatalf("seq %d assigned %d times, want exactly 1", i, seqs[i])
		}
	}
	head, _ := s.Head(id)
	if head != n {
		t.Fatalf("head = %d, want %d", head, n)
	}
}
