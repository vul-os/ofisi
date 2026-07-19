package updatelog

import (
	"bytes"
	"testing"
)

func newStore(t *testing.T) *LocalStore {
	t.Helper()
	s, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalStore: %v", err)
	}
	return s
}

func TestAppendAssignsMonotonicSeq(t *testing.T) {
	s := newStore(t)
	for i := int64(1); i <= 5; i++ {
		f, err := s.Append("doc1", FrameKindUpdate, []byte{byte(i)}, "peerA", 0)
		if err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		if f.Seq != i {
			t.Fatalf("append %d: seq = %d, want %d", i, f.Seq, i)
		}
	}
	head, err := s.Head("doc1")
	if err != nil || head != 5 {
		t.Fatalf("Head = %d, %v; want 5", head, err)
	}
	// A different file has its own independent sequence.
	f, _ := s.Append("doc2", FrameKindUpdate, []byte{9}, "peerB", 0)
	if f.Seq != 1 {
		t.Fatalf("doc2 first seq = %d, want 1", f.Seq)
	}
}

func TestLoadFullAndIncremental(t *testing.T) {
	s := newStore(t)
	payloads := [][]byte{[]byte("a"), []byte("b"), []byte("c")}
	for _, p := range payloads {
		if _, err := s.Append("d", FrameKindUpdate, p, "p", 0); err != nil {
			t.Fatal(err)
		}
	}
	// Full load returns every frame in ascending seq with byte-preserved data.
	full, err := s.Load("d", 0)
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
	// Incremental load: a caller holding up to seq 2 gets only frame 3.
	inc, err := s.Load("d", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(inc.Frames) != 1 || inc.Frames[0].Seq != 3 {
		t.Fatalf("incremental load = %+v", inc.Frames)
	}
}

func TestSnapshotCompactionPrunesFloorAndKeepsAbove(t *testing.T) {
	s := newStore(t)
	for i := 0; i < 4; i++ { // seqs 1..4
		s.Append("d", FrameKindUpdate, []byte{byte(i)}, "p", 0)
	}
	// Compact incorporating up to seq 3 (floor=3). Snapshot itself is seq 5.
	snap, err := s.Append("d", FrameKindSnapshot, []byte("STATE"), "p", 3)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if snap.Seq != 5 || snap.Floor != 3 {
		t.Fatalf("snapshot seq=%d floor=%d, want 5/3", snap.Seq, snap.Floor)
	}

	// A fresh caller (since=0) gets the snapshot + only frame 4 (above the floor).
	full, err := s.Load("d", 0)
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

	// Frames 1..3 must be physically pruned.
	dir, _ := s.fileDir("d")
	remaining, _ := listFrames(dir)
	for _, f := range remaining {
		if f.Seq <= 3 {
			t.Fatalf("frame seq %d should have been pruned", f.Seq)
		}
	}

	// New appends continue past the snapshot seq.
	next, _ := s.Append("d", FrameKindUpdate, []byte("z"), "p", 0)
	if next.Seq != 6 {
		t.Fatalf("post-snapshot append seq = %d, want 6", next.Seq)
	}
}

// A caller already past the floor gets no snapshot re-sent, only its missing tail.
func TestLoadPastFloorSkipsSnapshot(t *testing.T) {
	s := newStore(t)
	for i := 0; i < 3; i++ {
		s.Append("d", FrameKindUpdate, []byte{byte(i)}, "p", 0)
	}
	s.Append("d", FrameKindSnapshot, []byte("S"), "p", 3) // seq 4, floor 3
	s.Append("d", FrameKindUpdate, []byte("x"), "p", 0)   // seq 5

	inc, err := s.Load("d", 4) // caller already applied through seq 4
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

func TestStaleSnapshotRejected(t *testing.T) {
	s := newStore(t)
	for i := 0; i < 4; i++ {
		s.Append("d", FrameKindUpdate, []byte{byte(i)}, "p", 0)
	}
	if _, err := s.Append("d", FrameKindSnapshot, []byte("S1"), "p", 4); err != nil {
		t.Fatal(err)
	}
	// A snapshot regressing below the current floor is refused.
	if _, err := s.Append("d", FrameKindSnapshot, []byte("S0"), "p", 2); err == nil {
		t.Fatal("expected stale-snapshot rejection")
	}
}

// TestConvergenceFrameSetUnion is the storage-level analogue of the frontend
// "two clients diverge offline → both append → reload converges" guarantee: two
// peers each append offline frames; after both flush, a fresh reader receives
// the UNION of every frame exactly once, in a single stable seq order —
// independent of interleaving. (Byte-identical CRDT convergence of the applied
// result is proven at the Yjs layer in the JS suite.)
func TestConvergenceFrameSetUnion(t *testing.T) {
	s := newStore(t)
	peerA := [][]byte{[]byte("A1"), []byte("A2")}
	peerB := [][]byte{[]byte("B1"), []byte("B2"), []byte("B3")}
	// Interleave the two peers' appends.
	s.Append("doc", FrameKindUpdate, peerA[0], "A", 0)
	s.Append("doc", FrameKindUpdate, peerB[0], "B", 0)
	s.Append("doc", FrameKindUpdate, peerB[1], "B", 0)
	s.Append("doc", FrameKindUpdate, peerA[1], "A", 0)
	s.Append("doc", FrameKindUpdate, peerB[2], "B", 0)

	log, err := s.Load("doc", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(log.Frames) != 5 {
		t.Fatalf("expected 5 union frames, got %d", len(log.Frames))
	}
	// Seqs are strictly increasing and every peer's payloads are present once.
	seen := map[string]int{}
	var prev int64
	for _, f := range log.Frames {
		if f.Seq <= prev {
			t.Fatalf("non-monotonic seq: %d after %d", f.Seq, prev)
		}
		prev = f.Seq
		b, _ := DecodeFrame(f)
		seen[string(b)]++
	}
	for _, want := range append(append([][]byte{}, peerA...), peerB...) {
		if seen[string(want)] != 1 {
			t.Fatalf("payload %q appeared %d times, want 1", want, seen[string(want)])
		}
	}
}
