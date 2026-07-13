// Package docsync provides the AUTHORITATIVE server-side persistence for the
// WAVE37 server-mediated collaboration path. It stores, per document, the CRDT
// op log (and a periodically compacted snapshot) that the realtime hub relays
// between authorized editors.
//
// Why a sidecar store (not models.File.Content):
//
//	models.File.Content holds the editor's TipTap JSON — the export/print
//	representation. The live collaboration transport speaks the RGA TextCRDT op
//	wire format ({k,id,p,v,t}). These are different representations; the CRDT op
//	log must persist independently so it can be replayed to a late joiner and so
//	the doc converges even with zero p2p peers. Persisting the op log through
//	storage.UpdateFile would also spuriously churn a version snapshot on every
//	keystroke (UpdateFile auto-snapshots the previous content). So op state lives
//	in its own table, and the existing TipTap-JSON autosave (PUT /api/files/:id)
//	is left exactly as-is — the two are complementary, not competing.
//
// Honesty note: this is server-mediated RELAY + PERSISTENCE of opaque RGA CRDT
// ops, NOT a full OT engine. The server does not itself parse/merge RGA text; it
// assigns a monotonic per-doc sequence, appends ops durably, relays them, and
// snapshots the latest client-supplied CRDT snapshot for late-joiner bootstrap.
// Convergence is provided by the RGA CRDT running on the clients (idempotent,
// commutative apply); the server guarantees durability + ordering + fan-out.
package docsync

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	_ "modernc.org/sqlite"
)

// ErrEmptyDocID is returned when a document id is empty.
var ErrEmptyDocID = errors.New("docsync: empty document id")

// OpRecord is one persisted CRDT op (or snapshot marker) with its
// server-assigned monotonic sequence. Op is the opaque JSON payload the client
// sent ({k,id,p,v,t} for a TextOp); the server does not interpret it.
type OpRecord struct {
	Seq    uint64          `json:"seq"`
	Origin string          `json:"origin"` // replica/tab id that produced it
	Op     json.RawMessage `json:"op"`
}

// State is the current authoritative view of a document's CRDT stream returned
// to a late joiner: the latest compacted snapshot (may be nil) plus every op
// recorded AFTER that snapshot, in sequence order, and the current max seq.
type State struct {
	Seq  uint64          `json:"seq"`            // highest sequence assigned for this doc
	Snap json.RawMessage `json:"snap,omitempty"` // latest CRDT snapshot (compaction base)
	Ops  []OpRecord      `json:"ops"`            // ops recorded after the snapshot
}

// Store is the durable op-log persistence contract. A SQLite implementation is
// provided for self-host/local; a NullStore (in-memory) covers tests and the
// degraded path when the DB cannot be opened.
type Store interface {
	// AppendOp durably records op for docID, assigns it the next monotonic
	// sequence for that doc, and returns that sequence. origin identifies the
	// producing replica. The op payload is stored verbatim (opaque to the store).
	AppendOp(docID, origin string, op json.RawMessage) (seq uint64, err error)
	// SaveSnapshot records a compacted CRDT snapshot for docID at the current
	// max sequence and prunes ops at or below that sequence (compaction). It is
	// best-effort: a snapshot only ever moves the compaction base forward.
	SaveSnapshot(docID, origin string, snap json.RawMessage) (seq uint64, err error)
	// Load returns the current authoritative state (snapshot + trailing ops) for
	// a late joiner. A doc with no recorded ops returns an empty State.
	Load(docID string) (State, error)
	// MaxSeq returns the highest sequence assigned for docID (0 if none).
	MaxSeq(docID string) (uint64, error)
	// OpCount returns how many ops are CURRENTLY persisted in the op log for
	// docID (i.e. ops recorded after the latest snapshot/compaction base). Unlike
	// MaxSeq — which is monotonic and includes compacted-away ops — this reflects
	// the live, un-compacted size of the log, so the ingest gate can force a
	// client snapshot/compaction before the log grows without bound.
	OpCount(docID string) (int, error)
	// Delete removes all op-log + snapshot state for docID (called when the
	// document itself is deleted).
	Delete(docID string) error
	Close() error
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

// SQLiteStore persists the op log in a pure-Go modernc SQLite database.
type SQLiteStore struct {
	mu sync.Mutex // serializes the read-max-then-insert sequence assignment
	db *sql.DB
}

// NewSQLiteStore opens (or creates) the doc-sync database at dsn and ensures the
// schema exists. Use ":memory:" for an ephemeral DB in tests.
func NewSQLiteStore(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("docsync: open db: %w", err)
	}
	// modernc/sqlite is safe with a single connection; serialize to avoid
	// "database is locked" under concurrent writers.
	db.SetMaxOpenConns(1)
	s := &SQLiteStore{db: db}
	if err := s.init(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *SQLiteStore) init() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS docsync_ops (
			doc_id TEXT NOT NULL,
			seq    INTEGER NOT NULL,
			origin TEXT NOT NULL DEFAULT '',
			op     TEXT NOT NULL,
			PRIMARY KEY (doc_id, seq)
		);
		CREATE TABLE IF NOT EXISTS docsync_snapshots (
			doc_id TEXT PRIMARY KEY,
			seq    INTEGER NOT NULL,
			origin TEXT NOT NULL DEFAULT '',
			snap   TEXT NOT NULL
		);
	`)
	if err != nil {
		return fmt.Errorf("docsync: init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

// maxSeqLocked returns the highest sequence across the op log and the snapshot
// base for docID. Caller holds s.mu.
func (s *SQLiteStore) maxSeqLocked(docID string) (uint64, error) {
	var opMax sql.NullInt64
	if err := s.db.QueryRow(`SELECT MAX(seq) FROM docsync_ops WHERE doc_id = ?`, docID).Scan(&opMax); err != nil {
		return 0, err
	}
	var snapSeq sql.NullInt64
	if err := s.db.QueryRow(`SELECT seq FROM docsync_snapshots WHERE doc_id = ?`, docID).Scan(&snapSeq); err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	var m int64
	if opMax.Valid && opMax.Int64 > m {
		m = opMax.Int64
	}
	if snapSeq.Valid && snapSeq.Int64 > m {
		m = snapSeq.Int64
	}
	return uint64(m), nil
}

func (s *SQLiteStore) AppendOp(docID, origin string, op json.RawMessage) (uint64, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.maxSeqLocked(docID)
	if err != nil {
		return 0, err
	}
	next := cur + 1
	if _, err := s.db.Exec(
		`INSERT INTO docsync_ops (doc_id, seq, origin, op) VALUES (?, ?, ?, ?)`,
		docID, int64(next), origin, string(op)); err != nil {
		return 0, err
	}
	return next, nil
}

func (s *SQLiteStore) SaveSnapshot(docID, origin string, snap json.RawMessage) (uint64, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, err := s.maxSeqLocked(docID)
	if err != nil {
		return 0, err
	}
	// Snapshot at the current max sequence. Never regress the compaction base.
	var existing sql.NullInt64
	if err := s.db.QueryRow(`SELECT seq FROM docsync_snapshots WHERE doc_id = ?`, docID).Scan(&existing); err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if existing.Valid && uint64(existing.Int64) >= cur {
		// A snapshot at or beyond this point already exists — nothing to compact.
		return uint64(existing.Int64), nil
	}
	if _, err := s.db.Exec(
		`INSERT INTO docsync_snapshots (doc_id, seq, origin, snap) VALUES (?, ?, ?, ?)
		 ON CONFLICT(doc_id) DO UPDATE SET seq=excluded.seq, origin=excluded.origin, snap=excluded.snap`,
		docID, int64(cur), origin, string(snap)); err != nil {
		return 0, err
	}
	// Compaction: drop ops folded into the snapshot.
	if _, err := s.db.Exec(`DELETE FROM docsync_ops WHERE doc_id = ? AND seq <= ?`, docID, int64(cur)); err != nil {
		return 0, err
	}
	return cur, nil
}

func (s *SQLiteStore) Load(docID string) (State, error) {
	if docID == "" {
		return State{}, ErrEmptyDocID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var st State
	// Snapshot base (if any).
	var snapSeq sql.NullInt64
	var snap sql.NullString
	if err := s.db.QueryRow(`SELECT seq, snap FROM docsync_snapshots WHERE doc_id = ?`, docID).Scan(&snapSeq, &snap); err != nil && err != sql.ErrNoRows {
		return State{}, err
	}
	if snap.Valid {
		st.Snap = json.RawMessage(snap.String)
	}
	// Trailing ops after the snapshot base.
	rows, err := s.db.Query(`SELECT seq, origin, op FROM docsync_ops WHERE doc_id = ? ORDER BY seq ASC`, docID)
	if err != nil {
		return State{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var rec OpRecord
		var seq int64
		var opStr string
		if err := rows.Scan(&seq, &rec.Origin, &opStr); err != nil {
			return State{}, err
		}
		rec.Seq = uint64(seq)
		rec.Op = json.RawMessage(opStr)
		st.Ops = append(st.Ops, rec)
	}
	if err := rows.Err(); err != nil {
		return State{}, err
	}
	m, err := s.maxSeqLocked(docID)
	if err != nil {
		return State{}, err
	}
	st.Seq = m
	return st, nil
}

func (s *SQLiteStore) MaxSeq(docID string) (uint64, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.maxSeqLocked(docID)
}

func (s *SQLiteStore) OpCount(docID string) (int, error) {
	if docID == "" {
		return 0, ErrEmptyDocID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM docsync_ops WHERE doc_id = ?`, docID).Scan(&n); err != nil {
		return 0, err
	}
	return int(n), nil
}

func (s *SQLiteStore) Delete(docID string) error {
	if docID == "" {
		return ErrEmptyDocID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM docsync_ops WHERE doc_id = ?`, docID); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM docsync_snapshots WHERE doc_id = ?`, docID)
	return err
}
