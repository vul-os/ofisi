// Package audit implements an append-only audit log for security-sensitive
// administrative events: file-ACL grants/revokes, registration and invite
// lifecycle, and role changes.
//
// The log is APPEND-ONLY: the Store interface exposes Append + List but NO
// update or delete path, and the SQLite schema is written with that contract in
// mind (callers must never expose mutation). Each entry is immutable once
// written.
//
// Persistence is pure-Go modernc SQLite (no CGO), mirroring fileacl/userauth/
// invites. A NullStore (in-memory) is provided for tests and degraded mode.
package audit

import (
	"database/sql"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	_ "modernc.org/sqlite"
)

// Action enumerates the audited event kinds.
type Action string

const (
	ActionACLGrant      Action = "acl.grant"
	ActionACLRevoke     Action = "acl.revoke"
	ActionACLSetOwner   Action = "acl.set_owner"
	ActionRegister      Action = "auth.register"
	ActionInviteMint    Action = "invite.mint"
	ActionInviteConsume Action = "invite.consume"
	ActionInviteRevoke  Action = "invite.revoke"
	ActionRoleChange    Action = "role.change"
	// Share-link lifecycle (anonymous read-only doc links).
	ActionShareLinkMint   Action = "sharelink.mint"
	ActionShareLinkRevoke Action = "sharelink.revoke"
)

// Entry is one immutable audit record.
type Entry struct {
	ID     string `json:"id"`
	At     int64  `json:"at"`     // unix nanoseconds
	Actor  string `json:"actor"`  // who performed the action (account id) — may be "" for anonymous
	Action Action `json:"action"` // what happened
	Target string `json:"target"` // the object acted upon (file id, account id, invite id, …)
	Detail string `json:"detail"` // free-form context (grantee id, note, outcome)
}

// Store is the append-only audit persistence interface.
type Store interface {
	// Append writes a new immutable entry. The id/timestamp are filled in if unset.
	Append(e Entry) error
	// List returns the most-recent entries first, capped at limit (<=0 → all).
	List(limit int) ([]Entry, error)
	Close() error
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("audit: open db: %w", err)
	}
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
		CREATE TABLE IF NOT EXISTS audit_log (
			id     TEXT PRIMARY KEY,
			at     INTEGER NOT NULL,
			actor  TEXT NOT NULL DEFAULT '',
			action TEXT NOT NULL,
			target TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT ''
		);
		CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
	`)
	if err != nil {
		return fmt.Errorf("audit: init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) Append(e Entry) error {
	if e.ID == "" {
		e.ID = uuid.NewString()
	}
	if e.At == 0 {
		e.At = time.Now().UnixNano()
	}
	_, err := s.db.Exec(
		`INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)`,
		e.ID, e.At, e.Actor, string(e.Action), e.Target, e.Detail)
	return err
}

func (s *SQLiteStore) List(limit int) ([]Entry, error) {
	q := `SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY at DESC`
	if limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := s.db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		var action string
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &action, &e.Target, &e.Detail); err != nil {
			return nil, err
		}
		e.Action = Action(action)
		out = append(out, e)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// NullStore — in-memory backend for tests / degraded mode
// ---------------------------------------------------------------------------

type NullStore struct {
	mu      sync.Mutex
	entries []Entry
}

func NewNullStore() *NullStore { return &NullStore{} }

func (n *NullStore) Append(e Entry) error {
	if e.ID == "" {
		e.ID = uuid.NewString()
	}
	if e.At == 0 {
		e.At = time.Now().UnixNano()
	}
	n.mu.Lock()
	n.entries = append(n.entries, e)
	n.mu.Unlock()
	return nil
}

func (n *NullStore) List(limit int) ([]Entry, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make([]Entry, len(n.entries))
	copy(out, n.entries)
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (n *NullStore) Close() error { return nil }
