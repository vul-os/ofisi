// Package userauth provides a real per-user credential store, replacing the
// single shared-password + self-asserted account-id login (the P1 hole where a
// client could claim any account id at login).
//
// Credentials are stored as bcrypt hashes in a pure-Go modernc SQLite database
// (no CGO). On a successful Verify the caller obtains the canonical account id
// from the store, so the JWT subject is bound to the *authenticated* user
// rather than to client-supplied input.
//
// Backwards compatibility: per-user auth is ADDITIVE. When no users are
// registered the app may keep using the legacy shared-password path (see
// handlers/auth.go); once a user registers, that account must authenticate with
// its own password.
package userauth

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	_ "modernc.org/sqlite"
)

// Errors returned by the store.
var (
	ErrUserExists      = errors.New("userauth: account already registered")
	ErrInvalidCredential = errors.New("userauth: invalid credentials")
	ErrEmptyInput      = errors.New("userauth: account id and password required")
)

// Store is the per-user credential interface.
type Store interface {
	// Register creates a new account with a bcrypt-hashed password.
	// Returns ErrUserExists if the account id is already taken.
	Register(accountID, password string) error
	// Verify checks the password for accountID. On success it returns the
	// canonical account id stored in the DB (the authenticated identity); on
	// failure it returns ErrInvalidCredential. It never reveals whether the
	// failure was an unknown account vs. a wrong password.
	Verify(accountID, password string) (canonicalID string, err error)
	// HasUsers reports whether any credentials are registered. Used to decide
	// whether to enforce per-user auth or fall back to the shared password.
	HasUsers() (bool, error)
	// RegisterFirst atomically registers accountID ONLY IF no users exist yet.
	// It closes the first-user bootstrap TOCTOU race: the existence check and
	// the insert happen under one transaction, so two concurrent callers cannot
	// both believe they are the first user. Returns ErrNotFirstUser when at
	// least one account already exists (the caller must then use the gated
	// Register path), or ErrUserExists if the id is somehow already taken.
	RegisterFirst(accountID, password string) error
	Close() error
}

// ErrNotFirstUser is returned by RegisterFirst when the store is already
// bootstrapped (≥1 user exists), so the unauthenticated first-user path is
// closed and registration must go through the gated path.
var ErrNotFirstUser = errors.New("userauth: store already bootstrapped")

// ErrAlreadyMigrated is returned by MigrateSharedPassword when the credential
// store already holds users (so the shared-password → per-user migration has
// already happened, or real users exist) and the one-shot migration is a no-op.
var ErrAlreadyMigrated = errors.New("userauth: credential store already has users; migration not needed")

// MigrateSharedPassword performs the one-shot upgrade from a legacy shared-
// password deploy to per-user credentials.
//
// Before per-user auth existed, every operator logged in with a single shared
// password and any client-asserted account id. After the upgrade, login on a
// bootstrapped instance requires a per-user credential — so an upgrade with NO
// migrated credential would silently lock everyone out (HasUsers()==false keeps
// shared-password login working, but the moment any user is added the shared
// password stops authenticating existing operators).
//
// This creates the FIRST per-user credential (adminID + the existing shared
// password) so the operator can log in immediately after upgrading, and from
// there mint invites / register the rest of the team. It refuses to run if any
// user already exists (idempotent / safe to invoke on every boot).
func MigrateSharedPassword(s Store, adminID, sharedPassword string) error {
	if adminID == "" || sharedPassword == "" {
		return ErrEmptyInput
	}
	hasUsers, err := s.HasUsers()
	if err != nil {
		return err
	}
	if hasUsers {
		return ErrAlreadyMigrated
	}
	// RegisterFirst is atomic; if a concurrent boot won the race it returns
	// ErrNotFirstUser which we surface as "already migrated".
	switch err := s.RegisterFirst(adminID, sharedPassword); err {
	case nil:
		return nil
	case ErrNotFirstUser:
		return ErrAlreadyMigrated
	default:
		return err
	}
}

// normalize lower-cases and trims the account id so logins are case-insensitive
// on the email/handle (matching how identity is treated elsewhere).
func normalize(accountID string) string {
	return strings.ToLower(strings.TrimSpace(accountID))
}

// ---------------------------------------------------------------------------
// SQLiteStore
// ---------------------------------------------------------------------------

type SQLiteStore struct {
	db *sql.DB
}

// NewSQLiteStore opens (or creates) the credential database at dsn.
func NewSQLiteStore(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("userauth: open db: %w", err)
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
		CREATE TABLE IF NOT EXISTS users (
			account_id    TEXT PRIMARY KEY,
			password_hash TEXT NOT NULL,
			created_at    INTEGER NOT NULL DEFAULT 0
		);
	`)
	if err != nil {
		return fmt.Errorf("userauth: init schema: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) Register(accountID, password string) error {
	id := normalize(accountID)
	if id == "" || password == "" {
		return ErrEmptyInput
	}
	var exists int
	if err := s.db.QueryRow(`SELECT 1 FROM users WHERE account_id = ?`, id).Scan(&exists); err == nil {
		return ErrUserExists
	} else if err != sql.ErrNoRows {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("userauth: hash: %w", err)
	}
	_, err = s.db.Exec(
		`INSERT INTO users (account_id, password_hash, created_at) VALUES (?, ?, ?)`,
		id, string(hash), time.Now().UnixNano())
	return err
}

func (s *SQLiteStore) Verify(accountID, password string) (string, error) {
	id := normalize(accountID)
	if id == "" || password == "" {
		return "", ErrInvalidCredential
	}
	var hash string
	switch err := s.db.QueryRow(`SELECT password_hash FROM users WHERE account_id = ?`, id).Scan(&hash); err {
	case nil:
		// continue
	case sql.ErrNoRows:
		// Run a dummy compare to keep timing roughly constant against an
		// unknown-account probe.
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$0000000000000000000000000000000000000000000000000000"), []byte(password))
		return "", ErrInvalidCredential
	default:
		return "", err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return "", ErrInvalidCredential
	}
	return id, nil
}

func (s *SQLiteStore) HasUsers() (bool, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM users`).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// RegisterFirst atomically inserts the first user inside a transaction, guarded
// by a count check so concurrent callers cannot both win the bootstrap race.
// (db.SetMaxOpenConns(1) already serialises writers; the transaction makes the
// check-then-insert atomic regardless.)
func (s *SQLiteStore) RegisterFirst(accountID, password string) error {
	id := normalize(accountID)
	if id == "" || password == "" {
		return ErrEmptyInput
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("userauth: hash: %w", err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck — no-op after a successful Commit

	var n int
	if err := tx.QueryRow(`SELECT COUNT(1) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrNotFirstUser
	}
	if _, err := tx.Exec(
		`INSERT INTO users (account_id, password_hash, created_at) VALUES (?, ?, ?)`,
		id, string(hash), time.Now().UnixNano()); err != nil {
		return err
	}
	return tx.Commit()
}

// ---------------------------------------------------------------------------
// NullStore — in-memory backend for tests / degraded mode
// ---------------------------------------------------------------------------

type NullStore struct {
	mu    sync.Mutex
	users map[string]string // accountID → bcrypt hash
}

func NewNullStore() *NullStore {
	return &NullStore{users: make(map[string]string)}
}

func (n *NullStore) Register(accountID, password string) error {
	id := normalize(accountID)
	if id == "" || password == "" {
		return ErrEmptyInput
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, ok := n.users[id]; ok {
		return ErrUserExists
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	n.users[id] = string(hash)
	return nil
}

// RegisterFirst atomically registers accountID only when no users exist (the
// in-memory analogue of the SQLite transaction-guarded bootstrap).
func (n *NullStore) RegisterFirst(accountID, password string) error {
	id := normalize(accountID)
	if id == "" || password == "" {
		return ErrEmptyInput
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(n.users) > 0 {
		return ErrNotFirstUser
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	n.users[id] = string(hash)
	return nil
}

func (n *NullStore) Verify(accountID, password string) (string, error) {
	id := normalize(accountID)
	n.mu.Lock()
	hash, ok := n.users[id]
	n.mu.Unlock()
	if !ok {
		return "", ErrInvalidCredential
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return "", ErrInvalidCredential
	}
	return id, nil
}

func (n *NullStore) HasUsers() (bool, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.users) > 0, nil
}

func (n *NullStore) Close() error { return nil }
