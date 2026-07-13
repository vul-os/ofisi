// Package fileacl implements per-file ownership + access-control for the
// office document store (Docs, Sheets, Slides, PDF), closing the P0 hole where
// every file operation ignored the authenticated identity.
//
// Model
// -----
// Each file has exactly one OWNER (a Vulos account id) and an optional set of
// COLLABORATORS, each with an explicit role:
//
//   - RoleOwner  — full control: read, write, delete, and manage collaborators.
//   - RoleEditor — read + write content, but cannot delete or manage collaborators.
//   - RoleViewer — read only; cannot write, delete, or manage collaborators.
//
// Access is granted for any read when the caller is the owner OR is listed as a
// collaborator (any role). Write/delete/share operations additionally require a
// minimum role (see FileAuthz.requireEditor / requireOwner).
//
// Roles
// -----
// A share row carries an explicit role; Share (the role-less helper) grants
// RoleEditor, and the role column defaults to 'editor' at the storage layer.
//
// Persistence is pure-Go modernc SQLite (no CGO). A NullStore (in-memory) is
// provided for tests and for the degraded path when the DB cannot be opened.
//
// Fail-safe defaults
// ------------------
//   - A file with NO recorded owner (legacy data created before ACLs existed,
//     or created while auth was disabled) is treated as UNOWNED and therefore
//     accessible to everyone. This preserves the OSS single-user / local-mode
//     experience and avoids locking admins out of pre-existing documents. When
//     auth is enabled and a file is created through the API, an owner is always
//     recorded, so new documents are private by default.
package fileacl

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// ErrEmptyFileID is returned when a file id (or required account id) is empty.
// Exported so alternate Store backends (e.g. the co-located Postgres ACL store)
// can return the same sentinel.
var ErrEmptyFileID = errors.New("fileacl: empty file id or account id")

// Role is the level of access a collaborator holds on a file.
type Role string

const (
	// RoleOwner has full control: read, write, delete, and manage collaborators.
	RoleOwner Role = "owner"
	// RoleEditor may read and write content but cannot delete or manage collaborators.
	RoleEditor Role = "editor"
	// RoleCommenter may read content and add comments/suggestions, but cannot
	// edit the document body, delete it, or manage collaborators. It sits
	// between viewer and editor for write-scoping purposes (see
	// FileAuthz.requireEditor, which denies it content edits).
	RoleCommenter Role = "commenter"
	// RoleViewer may read content only.
	RoleViewer Role = "viewer"
	// RoleNone indicates no access (the account is not a collaborator).
	RoleNone Role = ""
)

// NormalizeRole maps the share-API role vocabulary (view/comment/edit and their
// long forms) onto the canonical fileacl roles. An unrecognized/empty value
// returns RoleNone so callers can reject it (fail closed) or apply a default.
func NormalizeRole(s string) Role {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "edit", "editor", "write", "writer":
		return RoleEditor
	case "comment", "commenter":
		return RoleCommenter
	case "view", "viewer", "read", "reader":
		return RoleViewer
	default:
		return RoleNone
	}
}

// IsGrantableRole reports whether role is one a collaborator may be granted
// (editor, commenter, or viewer). RoleOwner is set via SetOwner, not granted.
func IsGrantableRole(role Role) bool {
	return role == RoleEditor || role == RoleCommenter || role == RoleViewer
}

// CollaboratorEntry pairs an account id with its role on a specific file.
type CollaboratorEntry struct {
	AccountID string `json:"account_id"`
	Role      Role   `json:"role"`
}

// Record is the stored ACL for a single file.
type Record struct {
	FileID        string              `json:"file_id"`
	Owner         string              `json:"owner"`
	Collaborators []CollaboratorEntry `json:"collaborators"`
}

// Store is the persistence interface for file ACLs.
type Store interface {
	// SetOwner records (or overwrites) the owner of a file. Idempotent.
	SetOwner(fileID, owner string) error
	// Get returns the ACL record for a file. ok=false means no ACL is recorded
	// (the file is unowned/legacy).
	Get(fileID string) (rec Record, ok bool, err error)
	// Share adds accountID to the file's collaborator set as an editor.
	// Idempotent — equivalent to ShareWithRole(fileID, accountID, RoleEditor).
	Share(fileID, accountID string) error
	// ShareWithRole adds accountID to the file's collaborator set with the given
	// role (RoleEditor or RoleViewer). Idempotent; updates role if already shared.
	ShareWithRole(fileID, accountID string, role Role) error
	// Unshare removes accountID from the collaborator set. Idempotent.
	Unshare(fileID, accountID string) error
	// Delete removes all ACL state for a file (called on file delete).
	Delete(fileID string) error
	// CanAccess reports whether accountID may access fileID (any role).
	//   - recorded owner or any collaborator → true
	//   - unowned/legacy file → true (fail-safe for local/OSS mode)
	CanAccess(fileID, accountID string) (allowed bool, recorded bool, err error)
	// GetRole returns the role held by accountID on fileID.
	// For the owner, RoleOwner is returned. ok=false means accountID has no role.
	GetRole(fileID, accountID string) (role Role, ok bool, err error)
	// AccessibleFileIDs returns the set of file ids accountID can access
	// (owned + shared). Used to filter List without leaking other files.
	AccessibleFileIDs(accountID string) (map[string]bool, error)
	Close() error
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

// SQLiteStore persists ACLs in a pure-Go modernc SQLite database.
type SQLiteStore struct {
	db *sql.DB
}

// NewSQLiteStore opens (or creates) the ACL database at dsn and ensures the
// schema exists. Use ":memory:" for an ephemeral DB in tests.
func NewSQLiteStore(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("fileacl: open db: %w", err)
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
		CREATE TABLE IF NOT EXISTS file_owners (
			file_id TEXT PRIMARY KEY,
			owner   TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS file_shares (
			file_id    TEXT NOT NULL,
			account_id TEXT NOT NULL,
			role       TEXT NOT NULL DEFAULT 'editor',
			PRIMARY KEY (file_id, account_id)
		);
		CREATE INDEX IF NOT EXISTS idx_file_owners_owner ON file_owners(owner);
		CREATE INDEX IF NOT EXISTS idx_file_shares_account ON file_shares(account_id);
	`)
	if err != nil {
		return fmt.Errorf("fileacl: init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) SetOwner(fileID, owner string) error {
	if fileID == "" {
		return fmt.Errorf("fileacl: empty file id")
	}
	_, err := s.db.Exec(
		`INSERT INTO file_owners (file_id, owner) VALUES (?, ?)
		 ON CONFLICT(file_id) DO UPDATE SET owner=excluded.owner`,
		fileID, owner)
	return err
}

func (s *SQLiteStore) Get(fileID string) (Record, bool, error) {
	row := s.db.QueryRow(`SELECT owner FROM file_owners WHERE file_id = ?`, fileID)
	var owner string
	switch err := row.Scan(&owner); err {
	case nil:
		// fallthrough — load collaborators below
	case sql.ErrNoRows:
		return Record{}, false, nil
	default:
		return Record{}, false, err
	}
	collabs, err := s.listCollaborators(fileID)
	if err != nil {
		return Record{}, false, err
	}
	return Record{FileID: fileID, Owner: owner, Collaborators: collabs}, true, nil
}

func (s *SQLiteStore) listCollaborators(fileID string) ([]CollaboratorEntry, error) {
	rows, err := s.db.Query(`SELECT account_id, role FROM file_shares WHERE file_id = ? ORDER BY account_id`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CollaboratorEntry
	for rows.Next() {
		var a, r string
		if err := rows.Scan(&a, &r); err != nil {
			return nil, err
		}
		out = append(out, CollaboratorEntry{AccountID: a, Role: Role(r)})
	}
	return out, rows.Err()
}

func (s *SQLiteStore) Share(fileID, accountID string) error {
	return s.ShareWithRole(fileID, accountID, RoleEditor)
}

func (s *SQLiteStore) ShareWithRole(fileID, accountID string, role Role) error {
	if fileID == "" || accountID == "" {
		return fmt.Errorf("fileacl: empty file id or account id")
	}
	_, err := s.db.Exec(
		`INSERT INTO file_shares (file_id, account_id, role) VALUES (?, ?, ?)
		 ON CONFLICT(file_id, account_id) DO UPDATE SET role=excluded.role`,
		fileID, accountID, string(role))
	return err
}

func (s *SQLiteStore) Unshare(fileID, accountID string) error {
	_, err := s.db.Exec(`DELETE FROM file_shares WHERE file_id = ? AND account_id = ?`, fileID, accountID)
	return err
}

func (s *SQLiteStore) Delete(fileID string) error {
	if _, err := s.db.Exec(`DELETE FROM file_owners WHERE file_id = ?`, fileID); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM file_shares WHERE file_id = ?`, fileID)
	return err
}

func (s *SQLiteStore) CanAccess(fileID, accountID string) (bool, bool, error) {
	rec, ok, err := s.Get(fileID)
	if err != nil {
		return false, false, err
	}
	if !ok {
		// Unowned/legacy file → fail-safe allow (local/OSS mode).
		return true, false, nil
	}
	if rec.Owner == accountID {
		return true, true, nil
	}
	for _, c := range rec.Collaborators {
		if c.AccountID == accountID {
			return true, true, nil
		}
	}
	return false, true, nil
}

func (s *SQLiteStore) GetRole(fileID, accountID string) (Role, bool, error) {
	rec, ok, err := s.Get(fileID)
	if err != nil {
		return RoleNone, false, err
	}
	if !ok {
		return RoleNone, false, nil
	}
	if rec.Owner == accountID {
		return RoleOwner, true, nil
	}
	for _, c := range rec.Collaborators {
		if c.AccountID == accountID {
			return c.Role, true, nil
		}
	}
	return RoleNone, false, nil
}

func (s *SQLiteStore) AccessibleFileIDs(accountID string) (map[string]bool, error) {
	out := make(map[string]bool)
	owned, err := s.db.Query(`SELECT file_id FROM file_owners WHERE owner = ?`, accountID)
	if err != nil {
		return nil, err
	}
	defer owned.Close()
	for owned.Next() {
		var id string
		if err := owned.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	if err := owned.Err(); err != nil {
		return nil, err
	}
	shared, err := s.db.Query(`SELECT file_id FROM file_shares WHERE account_id = ?`, accountID)
	if err != nil {
		return nil, err
	}
	defer shared.Close()
	for shared.Next() {
		var id string
		if err := shared.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, shared.Err()
}

// ---------------------------------------------------------------------------
// NullStore — in-memory backend for tests / degraded mode
// ---------------------------------------------------------------------------

type NullStore struct {
	mu     sync.RWMutex
	owners map[string]string          // fileID → owner
	shares map[string]map[string]Role // fileID → accountID → role
}

func NewNullStore() *NullStore {
	return &NullStore{
		owners: make(map[string]string),
		shares: make(map[string]map[string]Role),
	}
}

func (n *NullStore) SetOwner(fileID, owner string) error {
	if fileID == "" {
		return fmt.Errorf("fileacl: empty file id")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.owners[fileID] = owner
	return nil
}

func (n *NullStore) Get(fileID string) (Record, bool, error) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	owner, ok := n.owners[fileID]
	if !ok {
		return Record{}, false, nil
	}
	var collabs []CollaboratorEntry
	for a, r := range n.shares[fileID] {
		collabs = append(collabs, CollaboratorEntry{AccountID: a, Role: r})
	}
	sort.Slice(collabs, func(i, j int) bool { return collabs[i].AccountID < collabs[j].AccountID })
	return Record{FileID: fileID, Owner: owner, Collaborators: collabs}, true, nil
}

func (n *NullStore) Share(fileID, accountID string) error {
	return n.ShareWithRole(fileID, accountID, RoleEditor)
}

func (n *NullStore) ShareWithRole(fileID, accountID string, role Role) error {
	if fileID == "" || accountID == "" {
		return fmt.Errorf("fileacl: empty file id or account id")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.shares[fileID] == nil {
		n.shares[fileID] = make(map[string]Role)
	}
	n.shares[fileID][accountID] = role
	return nil
}

func (n *NullStore) Unshare(fileID, accountID string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if m := n.shares[fileID]; m != nil {
		delete(m, accountID)
	}
	return nil
}

func (n *NullStore) Delete(fileID string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.owners, fileID)
	delete(n.shares, fileID)
	return nil
}

func (n *NullStore) CanAccess(fileID, accountID string) (bool, bool, error) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	owner, ok := n.owners[fileID]
	if !ok {
		return true, false, nil
	}
	if owner == accountID {
		return true, true, nil
	}
	if _, has := n.shares[fileID][accountID]; has {
		return true, true, nil
	}
	return false, true, nil
}

func (n *NullStore) GetRole(fileID, accountID string) (Role, bool, error) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	owner, ok := n.owners[fileID]
	if !ok {
		return RoleNone, false, nil
	}
	if owner == accountID {
		return RoleOwner, true, nil
	}
	if r, has := n.shares[fileID][accountID]; has {
		return r, true, nil
	}
	return RoleNone, false, nil
}

func (n *NullStore) AccessibleFileIDs(accountID string) (map[string]bool, error) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	out := make(map[string]bool)
	for id, owner := range n.owners {
		if owner == accountID {
			out[id] = true
		}
	}
	for id, m := range n.shares {
		if _, has := m[accountID]; has {
			out[id] = true
		}
	}
	return out, nil
}

func (n *NullStore) Close() error { return nil }
