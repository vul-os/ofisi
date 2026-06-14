// Package calstore provides a durable, account-scoped SQLite store for
// calendar events and subscriptions.
//
// Tenant isolation: every row is keyed by account_id (the verified JWT
// subject). All reads and writes require an account_id; the store never
// returns rows belonging to a different account. An empty account_id ("") is
// the OSS single-user / auth-disabled mode fall-safe: such rows are visible
// to every caller (matching the fileacl unowned-file behaviour).
//
// DSN: pass ":memory:" for tests; pass a file path for production persistence.
package calstore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// CalEvent mirrors handlers.CalEvent but lives in this package so the store
// has no import cycle back into handlers.
type CalEvent struct {
	ID          string      `json:"id"`
	AccountID   string      `json:"account_id,omitempty"`
	CalendarID  string      `json:"calendar_id"`
	Title       string      `json:"title"`
	AllDay      bool        `json:"all_day,omitempty"`
	Start       time.Time   `json:"start"`
	End         time.Time   `json:"end"`
	TimeZone    string      `json:"time_zone,omitempty"`
	Location    string      `json:"location,omitempty"`
	Description string      `json:"description,omitempty"`
	InviteesJSON string     `json:"-"` // internal: raw JSON blob
	Recurrence  string      `json:"recurrence,omitempty"`
	RemindersJSON string    `json:"-"` // internal: raw JSON blob
	Color       string      `json:"color,omitempty"`
	Visibility  string      `json:"visibility,omitempty"`
	MeetURL     string      `json:"meet_url,omitempty"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

// CalSubscription mirrors handlers.calSubscription.
type CalSubscription struct {
	ID        string    `json:"id"`
	AccountID string    `json:"account_id,omitempty"`
	URL       string    `json:"url"`
	Name      string    `json:"name"`
	Added     time.Time `json:"added"`
}

// Store is the durable, account-scoped calendar store.
type Store struct {
	mu sync.Mutex
	db *sql.DB
}

var defaultStore *Store
var defaultOnce sync.Once

// Default returns the process-wide Store, lazily initialised with an in-memory
// SQLite database. For production call InitDefault with a file DSN before the
// first request handler runs.
func Default() *Store {
	defaultOnce.Do(func() {
		s, err := New(":memory:")
		if err != nil {
			panic(fmt.Sprintf("calstore: failed to open DB: %v", err))
		}
		defaultStore = s
	})
	return defaultStore
}

// InitDefault replaces the process-wide store with one backed by dsn.
// Must be called before any handler runs (e.g. from main). Idempotent if
// called more than once only when defaultOnce has already fired — in that
// case it resets the singleton (intended for testing only).
func InitDefault(dsn string) error {
	s, err := New(dsn)
	if err != nil {
		return err
	}
	// Reset once so subsequent Default() calls return the new store.
	defaultOnce.Do(func() {}) // ensure once has fired
	defaultStore = s
	return nil
}

// New opens (or creates) a SQLite-backed Store at dsn.
func New(dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("calstore: open: %w", err)
	}
	if err := initSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func initSchema(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS cal_events (
			id           TEXT NOT NULL,
			account_id   TEXT NOT NULL DEFAULT '',
			calendar_id  TEXT NOT NULL DEFAULT '',
			title        TEXT NOT NULL DEFAULT '',
			all_day      INTEGER NOT NULL DEFAULT 0,
			start_ts     INTEGER NOT NULL DEFAULT 0,
			end_ts       INTEGER NOT NULL DEFAULT 0,
			time_zone    TEXT NOT NULL DEFAULT '',
			location     TEXT NOT NULL DEFAULT '',
			description  TEXT NOT NULL DEFAULT '',
			invitees     TEXT NOT NULL DEFAULT '[]',
			recurrence   TEXT NOT NULL DEFAULT '',
			reminders    TEXT NOT NULL DEFAULT '[]',
			color        TEXT NOT NULL DEFAULT '',
			visibility   TEXT NOT NULL DEFAULT '',
			meet_url     TEXT NOT NULL DEFAULT '',
			created_at   INTEGER NOT NULL DEFAULT 0,
			updated_at   INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, account_id)
		);
		CREATE INDEX IF NOT EXISTS idx_calevents_account ON cal_events(account_id);
		CREATE INDEX IF NOT EXISTS idx_calevents_range   ON cal_events(account_id, start_ts, end_ts);

		CREATE TABLE IF NOT EXISTS cal_subscriptions (
			id         TEXT NOT NULL,
			account_id TEXT NOT NULL DEFAULT '',
			url        TEXT NOT NULL DEFAULT '',
			name       TEXT NOT NULL DEFAULT '',
			added_at   INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, account_id)
		);
		CREATE INDEX IF NOT EXISTS idx_calsubs_account ON cal_subscriptions(account_id);
	`)
	return err
}

// ─── events ───────────────────────────────────────────────────────────────────

// Put inserts or replaces an event. The event's AccountID is the tenant key.
func (s *Store) Put(e *CalEvent) error {
	invJSON, _ := json.Marshal(json.RawMessage(nvlJSON(e.InviteesJSON)))
	remJSON, _ := json.Marshal(json.RawMessage(nvlJSON(e.RemindersJSON)))
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		INSERT INTO cal_events
			(id, account_id, calendar_id, title, all_day,
			 start_ts, end_ts, time_zone, location, description,
			 invitees, recurrence, reminders, color, visibility, meet_url,
			 created_at, updated_at)
		VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?)
		ON CONFLICT(id, account_id) DO UPDATE SET
			calendar_id=excluded.calendar_id, title=excluded.title,
			all_day=excluded.all_day,
			start_ts=excluded.start_ts, end_ts=excluded.end_ts,
			time_zone=excluded.time_zone, location=excluded.location,
			description=excluded.description,
			invitees=excluded.invitees, recurrence=excluded.recurrence,
			reminders=excluded.reminders, color=excluded.color,
			visibility=excluded.visibility, meet_url=excluded.meet_url,
			created_at=excluded.created_at, updated_at=excluded.updated_at`,
		e.ID, e.AccountID, e.CalendarID, e.Title, b2i(e.AllDay),
		e.Start.Unix(), e.End.Unix(), e.TimeZone, e.Location, e.Description,
		string(invJSON), e.Recurrence, string(remJSON), e.Color, e.Visibility, e.MeetURL,
		e.CreatedAt.Unix(), e.UpdatedAt.Unix(),
	)
	return err
}

// Get returns the event if it belongs to accountID (or has no owner — legacy).
// Returns (nil, false) when the event does not exist or is owned by another account.
func (s *Store) Get(id, accountID string, isAdmin bool) (*CalEvent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`
		SELECT id, account_id, calendar_id, title, all_day,
		       start_ts, end_ts, time_zone, location, description,
		       invitees, recurrence, reminders, color, visibility, meet_url,
		       created_at, updated_at
		FROM cal_events
		WHERE id = ? AND (account_id = '' OR account_id = ? OR ?)`,
		id, accountID, b2i(isAdmin),
	)
	return scanEvent(row)
}

// GetRaw returns an event regardless of ownership (reminder worker / tests only).
func (s *Store) GetRaw(id string) (*CalEvent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`
		SELECT id, account_id, calendar_id, title, all_day,
		       start_ts, end_ts, time_zone, location, description,
		       invitees, recurrence, reminders, color, visibility, meet_url,
		       created_at, updated_at
		FROM cal_events WHERE id = ? LIMIT 1`, id,
	)
	e, ok := scanEvent(row)
	return e, ok
}

// List returns all events the caller may access within [from, to) for calID.
func (s *Store) List(from, to time.Time, calID, accountID string, isAdmin bool) []*CalEvent {
	s.mu.Lock()
	defer s.mu.Unlock()

	query := `
		SELECT id, account_id, calendar_id, title, all_day,
		       start_ts, end_ts, time_zone, location, description,
		       invitees, recurrence, reminders, color, visibility, meet_url,
		       created_at, updated_at
		FROM cal_events
		WHERE (account_id = '' OR account_id = ? OR ?)
		  AND end_ts > ?
		  AND start_ts < ?`
	args := []interface{}{accountID, b2i(isAdmin), from.Unix(), to.Unix()}
	if calID != "" {
		query += " AND calendar_id = ?"
		args = append(args, calID)
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		log.Printf("[calstore] List error: %v", err)
		return nil
	}
	defer rows.Close()
	var out []*CalEvent
	for rows.Next() {
		e, ok := scanEventRow(rows)
		if ok {
			out = append(out, e)
		}
	}
	return out
}

// AllEvents returns every event in the store (reminder worker use only).
func (s *Store) AllEvents() []*CalEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
		SELECT id, account_id, calendar_id, title, all_day,
		       start_ts, end_ts, time_zone, location, description,
		       invitees, recurrence, reminders, color, visibility, meet_url,
		       created_at, updated_at
		FROM cal_events`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []*CalEvent
	for rows.Next() {
		e, ok := scanEventRow(rows)
		if ok {
			out = append(out, e)
		}
	}
	return out
}

// Delete removes the event only if accountID owns it (or isAdmin).
// Returns true if a row was deleted.
func (s *Store) Delete(id, accountID string, isAdmin bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`
		DELETE FROM cal_events
		WHERE id = ? AND (account_id = '' OR account_id = ? OR ?)`,
		id, accountID, b2i(isAdmin),
	)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

// Clear removes all events (test helper).
func (s *Store) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.db.Exec(`DELETE FROM cal_events`)
}

// ─── subscriptions ────────────────────────────────────────────────────────────

// PutSubscription inserts or replaces a subscription.
func (s *Store) PutSubscription(sub *CalSubscription) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		INSERT INTO cal_subscriptions (id, account_id, url, name, added_at)
		VALUES (?,?,?,?,?)
		ON CONFLICT(id, account_id) DO UPDATE SET
			url=excluded.url, name=excluded.name, added_at=excluded.added_at`,
		sub.ID, sub.AccountID, sub.URL, sub.Name, sub.Added.Unix(),
	)
	return err
}

// ListSubscriptions returns subscriptions owned by accountID (or unowned).
func (s *Store) ListSubscriptions(accountID string, isAdmin bool) []*CalSubscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`
		SELECT id, account_id, url, name, added_at
		FROM cal_subscriptions
		WHERE account_id = '' OR account_id = ? OR ?`,
		accountID, b2i(isAdmin),
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []*CalSubscription
	for rows.Next() {
		var sub CalSubscription
		var ts int64
		if err := rows.Scan(&sub.ID, &sub.AccountID, &sub.URL, &sub.Name, &ts); err != nil {
			continue
		}
		sub.Added = time.Unix(ts, 0)
		out = append(out, &sub)
	}
	return out
}

// ─── helpers ──────────────────────────────────────────────────────────────────

type scanner interface {
	Scan(...interface{}) error
}

func scanEvent(row *sql.Row) (*CalEvent, bool) {
	var e CalEvent
	var allDay int
	var startTS, endTS, createdTS, updatedTS int64
	err := row.Scan(
		&e.ID, &e.AccountID, &e.CalendarID, &e.Title, &allDay,
		&startTS, &endTS, &e.TimeZone, &e.Location, &e.Description,
		&e.InviteesJSON, &e.Recurrence, &e.RemindersJSON, &e.Color, &e.Visibility, &e.MeetURL,
		&createdTS, &updatedTS,
	)
	if err != nil {
		return nil, false
	}
	e.AllDay = allDay != 0
	e.Start = time.Unix(startTS, 0).UTC()
	e.End = time.Unix(endTS, 0).UTC()
	e.CreatedAt = time.Unix(createdTS, 0).UTC()
	e.UpdatedAt = time.Unix(updatedTS, 0).UTC()
	return &e, true
}

func scanEventRow(rows *sql.Rows) (*CalEvent, bool) {
	var e CalEvent
	var allDay int
	var startTS, endTS, createdTS, updatedTS int64
	err := rows.Scan(
		&e.ID, &e.AccountID, &e.CalendarID, &e.Title, &allDay,
		&startTS, &endTS, &e.TimeZone, &e.Location, &e.Description,
		&e.InviteesJSON, &e.Recurrence, &e.RemindersJSON, &e.Color, &e.Visibility, &e.MeetURL,
		&createdTS, &updatedTS,
	)
	if err != nil {
		return nil, false
	}
	e.AllDay = allDay != 0
	e.Start = time.Unix(startTS, 0).UTC()
	e.End = time.Unix(endTS, 0).UTC()
	e.CreatedAt = time.Unix(createdTS, 0).UTC()
	e.UpdatedAt = time.Unix(updatedTS, 0).UTC()
	return &e, true
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nvlJSON(s string) string {
	if s == "" {
		return "[]"
	}
	return s
}
