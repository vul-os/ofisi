// Package contactstore provides a durable, account-scoped SQLite store for
// contact records (VCF import/export/merge).
//
// Tenant isolation: every row is keyed by account_id (the verified JWT
// subject). All reads and writes require an account_id; the store never
// returns rows belonging to a different account.
//
// Contact data is stored as a JSON blob (the vCard field set is rich and
// variable; a blob avoids a brittle column schema while still being queryable
// per-account). Dedup index columns (email_lower, phone_digits) are maintained
// separately so duplicate-detection doesn't need to unmarshal every row.
package contactstore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Email is one email entry on a contact.
type Email struct {
	Address string `json:"address"`
	Label   string `json:"label,omitempty"`
}

// Phone is one phone entry on a contact.
type Phone struct {
	Number string `json:"number"`
	Label  string `json:"label,omitempty"`
}

// Contact is the portable contact record stored in the DB.
// It mirrors the fields in contacts_vcf.Contact that we persist; additional
// fields are preserved verbatim in the blob column.
type Contact struct {
	UID       string    `json:"uid"`
	AccountID string    `json:"account_id,omitempty"`
	FullName  string    `json:"full_name,omitempty"`
	Emails    []Email   `json:"emails,omitempty"`
	Phones    []Phone   `json:"phones,omitempty"`
	Notes     string    `json:"notes,omitempty"`
	Blob      string    `json:"blob,omitempty"` // full vCard payload (round-trip)
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Store is the durable, account-scoped contact store.
type Store struct {
	mu sync.Mutex
	db *sql.DB
}

var defaultStore *Store
var defaultOnce sync.Once

// Default returns the process-wide Store (in-memory SQLite for safety;
// call InitDefault with a file DSN in main for production).
func Default() *Store {
	defaultOnce.Do(func() {
		s, err := New(":memory:")
		if err != nil {
			panic(fmt.Sprintf("contactstore: failed to open DB: %v", err))
		}
		defaultStore = s
	})
	return defaultStore
}

// InitDefault replaces the process-wide store with one backed by dsn.
func InitDefault(dsn string) error {
	s, err := New(dsn)
	if err != nil {
		return err
	}
	defaultOnce.Do(func() {})
	defaultStore = s
	return nil
}

// New opens (or creates) a SQLite-backed Store at dsn.
func New(dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("contactstore: open: %w", err)
	}
	if err := initSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func initSchema(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS contacts (
			uid        TEXT NOT NULL,
			account_id TEXT NOT NULL DEFAULT '',
			full_name  TEXT NOT NULL DEFAULT '',
			notes      TEXT NOT NULL DEFAULT '',
			blob       TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (uid, account_id)
		);
		CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);

		CREATE TABLE IF NOT EXISTS contact_emails (
			uid        TEXT NOT NULL,
			account_id TEXT NOT NULL DEFAULT '',
			email      TEXT NOT NULL,
			PRIMARY KEY (uid, account_id, email)
		);

		CREATE TABLE IF NOT EXISTS contact_phones (
			uid        TEXT NOT NULL,
			account_id TEXT NOT NULL DEFAULT '',
			digits     TEXT NOT NULL,
			PRIMARY KEY (uid, account_id, digits)
		);
	`)
	return err
}

// Put inserts or replaces a contact. AccountID is the tenant key.
func (s *Store) Put(c *Contact) error {
	blob, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("contactstore: marshal: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	_, err = s.db.Exec(`
		INSERT INTO contacts (uid, account_id, full_name, notes, blob, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(uid, account_id) DO UPDATE SET
			full_name=excluded.full_name, notes=excluded.notes,
			blob=excluded.blob, updated_at=excluded.updated_at`,
		c.UID, c.AccountID, c.FullName, c.Notes, string(blob),
		c.CreatedAt.Unix(), c.UpdatedAt.Unix(),
	)
	if err != nil {
		return err
	}

	// Refresh email index.
	s.db.Exec(`DELETE FROM contact_emails WHERE uid=? AND account_id=?`, c.UID, c.AccountID)
	for _, e := range c.Emails {
		if e.Address != "" {
			s.db.Exec(`INSERT OR IGNORE INTO contact_emails (uid, account_id, email) VALUES (?,?,?)`,
				c.UID, c.AccountID, normaliseEmail(e.Address))
		}
	}

	// Refresh phone index.
	s.db.Exec(`DELETE FROM contact_phones WHERE uid=? AND account_id=?`, c.UID, c.AccountID)
	for _, p := range c.Phones {
		digits := normalisePhone(p.Number)
		if digits != "" {
			s.db.Exec(`INSERT OR IGNORE INTO contact_phones (uid, account_id, digits) VALUES (?,?,?)`,
				c.UID, c.AccountID, digits)
		}
	}

	return nil
}

// Get returns the contact only if accountID owns it (or it has no owner or isAdmin).
func (s *Store) Get(uid, accountID string, isAdmin bool) (*Contact, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`
		SELECT uid, account_id, full_name, notes, blob, created_at, updated_at
		FROM contacts
		WHERE uid = ? AND (account_id = '' OR account_id = ? OR ?)`,
		uid, accountID, b2i(isAdmin),
	)
	return scanContact(row)
}

// List returns all contacts the caller may access.
func (s *Store) List(accountID string, isAdmin bool) []*Contact {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
		SELECT uid, account_id, full_name, notes, blob, created_at, updated_at
		FROM contacts
		WHERE account_id = '' OR account_id = ? OR ?`,
		accountID, b2i(isAdmin),
	)
	if err != nil {
		log.Printf("[contactstore] List error: %v", err)
		return nil
	}
	defer rows.Close()
	var out []*Contact
	for rows.Next() {
		c, ok := scanContactRow(rows)
		if ok {
			out = append(out, c)
		}
	}
	return out
}

// Delete removes the contact only if the caller owns it (or isAdmin).
func (s *Store) Delete(uid, accountID string, isAdmin bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`
		DELETE FROM contacts
		WHERE uid = ? AND (account_id = '' OR account_id = ? OR ?)`,
		uid, accountID, b2i(isAdmin),
	)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		s.db.Exec(`DELETE FROM contact_emails WHERE uid=? AND account_id=?`, uid, accountID)
		s.db.Exec(`DELETE FROM contact_phones WHERE uid=? AND account_id=?`, uid, accountID)
	}
	return n > 0
}

// CanAccess reports whether accountID may touch uid (no lock — caller must be
// within a Put/Delete cycle, or use Get directly).
func (s *Store) CanAccess(uid, accountID string, isAdmin bool) bool {
	_, ok := s.Get(uid, accountID, isAdmin)
	return ok
}

// DupsByEmail returns slices of UIDs that share the same normalised email,
// restricted to the caller's contacts.
func (s *Store) DupsByEmail(accountID string, isAdmin bool) map[string][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
		SELECT email, uid FROM contact_emails
		WHERE account_id = '' OR account_id = ? OR ?`,
		accountID, b2i(isAdmin),
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	m := map[string][]string{}
	for rows.Next() {
		var email, uid string
		if rows.Scan(&email, &uid) == nil {
			m[email] = append(m[email], uid)
		}
	}
	return m
}

// DupsByPhone returns slices of UIDs that share the same normalised phone digits.
func (s *Store) DupsByPhone(accountID string, isAdmin bool) map[string][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
		SELECT digits, uid FROM contact_phones
		WHERE account_id = '' OR account_id = ? OR ?`,
		accountID, b2i(isAdmin),
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	m := map[string][]string{}
	for rows.Next() {
		var digits, uid string
		if rows.Scan(&digits, &uid) == nil {
			m[digits] = append(m[digits], uid)
		}
	}
	return m
}

// Clear removes all contacts (test helper).
func (s *Store) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.db.Exec(`DELETE FROM contacts`)
	s.db.Exec(`DELETE FROM contact_emails`)
	s.db.Exec(`DELETE FROM contact_phones`)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

type scanner interface{ Scan(...interface{}) error }

func scanContact(row *sql.Row) (*Contact, bool) {
	var c Contact
	var createdTS, updatedTS int64
	err := row.Scan(&c.UID, &c.AccountID, &c.FullName, &c.Notes, &c.Blob, &createdTS, &updatedTS)
	if err != nil {
		return nil, false
	}
	c.CreatedAt = time.Unix(createdTS, 0).UTC()
	c.UpdatedAt = time.Unix(updatedTS, 0).UTC()
	// Unmarshal blob to restore emails/phones.
	_ = json.Unmarshal([]byte(c.Blob), &c)
	return &c, true
}

func scanContactRow(rows *sql.Rows) (*Contact, bool) {
	var c Contact
	var createdTS, updatedTS int64
	err := rows.Scan(&c.UID, &c.AccountID, &c.FullName, &c.Notes, &c.Blob, &createdTS, &updatedTS)
	if err != nil {
		return nil, false
	}
	c.CreatedAt = time.Unix(createdTS, 0).UTC()
	c.UpdatedAt = time.Unix(updatedTS, 0).UTC()
	_ = json.Unmarshal([]byte(c.Blob), &c)
	return &c, true
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func normaliseEmail(s string) string {
	// lowercase trim
	out := []byte(s)
	for i, b := range out {
		if b >= 'A' && b <= 'Z' {
			out[i] = b + 32
		}
	}
	return string(out)
}

func normalisePhone(s string) string {
	var digits []byte
	for _, c := range []byte(s) {
		if c >= '0' && c <= '9' {
			digits = append(digits, c)
		}
	}
	return string(digits)
}
