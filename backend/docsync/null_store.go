package docsync

import (
	"encoding/json"
	"sync"
)

// NullStore is an in-memory Store used for tests and as the degraded fallback
// when the SQLite op-log database cannot be opened. It is fully functional
// (relay + late-joiner bootstrap still work) but does NOT survive a restart.
type NullStore struct {
	mu    sync.Mutex
	ops   map[string][]OpRecord // docID -> ops after the snapshot base
	snaps map[string]snapEntry  // docID -> compacted snapshot
	seq   map[string]uint64     // docID -> highest assigned sequence
}

type snapEntry struct {
	seq    uint64
	origin string
	snap   json.RawMessage
}

// NewNullStore builds an empty in-memory store.
func NewNullStore() *NullStore {
	return &NullStore{
		ops:   make(map[string][]OpRecord),
		snaps: make(map[string]snapEntry),
		seq:   make(map[string]uint64),
	}
}

func (n *NullStore) AppendOp(docID, origin string, op json.RawMessage) (uint64, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.seq[docID]++
	s := n.seq[docID]
	// Copy the payload so a caller reusing its buffer cannot mutate stored state.
	cp := make(json.RawMessage, len(op))
	copy(cp, op)
	n.ops[docID] = append(n.ops[docID], OpRecord{Seq: s, Origin: origin, Op: cp})
	return s, nil
}

func (n *NullStore) SaveSnapshot(docID, origin string, snap json.RawMessage) (uint64, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	cur := n.seq[docID]
	if existing, ok := n.snaps[docID]; ok && existing.seq >= cur {
		return existing.seq, nil
	}
	cp := make(json.RawMessage, len(snap))
	copy(cp, snap)
	n.snaps[docID] = snapEntry{seq: cur, origin: origin, snap: cp}
	// Compaction: drop ops folded into the snapshot.
	trimmed := n.ops[docID][:0]
	for _, r := range n.ops[docID] {
		if r.Seq > cur {
			trimmed = append(trimmed, r)
		}
	}
	if len(trimmed) == 0 {
		delete(n.ops, docID)
	} else {
		cpOps := make([]OpRecord, len(trimmed))
		copy(cpOps, trimmed)
		n.ops[docID] = cpOps
	}
	return cur, nil
}

func (n *NullStore) Load(docID string) (State, error) {
	if docID == "" {
		return State{}, ErrEmptyDocID
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	var st State
	if snap, ok := n.snaps[docID]; ok {
		st.Snap = snap.snap
	}
	src := n.ops[docID]
	st.Ops = make([]OpRecord, len(src))
	copy(st.Ops, src)
	st.Seq = n.seq[docID]
	return st, nil
}

func (n *NullStore) MaxSeq(docID string) (uint64, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.seq[docID], nil
}

func (n *NullStore) OpCount(docID string) (int, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.ops[docID]), nil
}

func (n *NullStore) Delete(docID string) error {
	if docID == "" {
		return ErrEmptyDocID
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.ops, docID)
	delete(n.snaps, docID)
	delete(n.seq, docID)
	return nil
}

func (n *NullStore) Close() error { return nil }
