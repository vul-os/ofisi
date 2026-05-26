// sqlite.go — durable Persister for Vulos Spaces backed by pure-Go modernc
// SQLite (no CGO). Matches the storage approach used by the meeting lobby
// (backend/services/meeting/lobby.go).
//
// OFFICE-60: messages, channels, memberships, the op-log, and read-state all
// survive a server restart. NullPersister remains available as a
// test/opt-out (in-memory-only) backend.
package spaces

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"vulos-office/backend/models"

	_ "modernc.org/sqlite"
)

func marshalMessage(m *models.Message) (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("spaces: marshal op message: %w", err)
	}
	return string(b), nil
}

func unmarshalMessage(s string) (*models.Message, error) {
	var m models.Message
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, fmt.Errorf("spaces: unmarshal op message: %w", err)
	}
	return &m, nil
}

// SQLitePersister stores Spaces state in a SQLite database.
// Use a file path (e.g. "./data/spaces.db") for durability, or ":memory:" for
// an ephemeral DB in tests.
type SQLitePersister struct {
	db  *sql.DB
	fts bool // true when the FTS5 virtual table is available
}

// NewSQLitePersister opens (or creates) the database at dsn and ensures the
// schema exists.
func NewSQLitePersister(dsn string) (*SQLitePersister, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("spaces: open db: %w", err)
	}
	// modernc/sqlite is safe with a single connection; serialize to avoid
	// "database is locked" under concurrent writers.
	db.SetMaxOpenConns(1)
	p := &SQLitePersister{db: db}
	if err := p.init(); err != nil {
		db.Close()
		return nil, err
	}
	return p, nil
}

// Close releases the underlying database handle.
func (p *SQLitePersister) Close() error {
	if p.db == nil {
		return nil
	}
	return p.db.Close()
}

func (p *SQLitePersister) init() error {
	_, err := p.db.Exec(`
		CREATE TABLE IF NOT EXISTS channels (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL DEFAULT '',
			type       TEXT NOT NULL DEFAULT 'public',
			created_by TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS memberships (
			id           TEXT NOT NULL,
			channel_id   TEXT NOT NULL,
			account_id   TEXT NOT NULL,
			display_name TEXT NOT NULL DEFAULT '',
			joined_at    INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (channel_id, account_id)
		);
		CREATE TABLE IF NOT EXISTS messages (
			id            TEXT NOT NULL,
			channel_id    TEXT NOT NULL,
			thread_parent TEXT NOT NULL DEFAULT '',
			author_id     TEXT NOT NULL DEFAULT '',
			body          TEXT NOT NULL DEFAULT '',
			state         TEXT NOT NULL DEFAULT 'active',
			seq_clock     TEXT NOT NULL DEFAULT '',
			created_at    INTEGER NOT NULL DEFAULT 0,
			updated_at    INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (channel_id, id)
		);
		-- P2: index the op-log by (channel_id, seq_clock) so ExportOps does a
		-- range scan instead of a full table scan.
		CREATE TABLE IF NOT EXISTS ops (
			channel_id TEXT NOT NULL,
			op         TEXT NOT NULL,
			seq_clock  TEXT NOT NULL,
			msg_json   TEXT NOT NULL,
			applied_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_ops_channel_seq ON ops(channel_id, seq_clock);
		CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
		CREATE TABLE IF NOT EXISTS read_state (
			account_id      TEXT NOT NULL,
			channel_id      TEXT NOT NULL,
			last_read_clock TEXT NOT NULL DEFAULT '',
			updated_at      INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (account_id, channel_id)
		);
		-- Presence: durable user status, reactions, and pins so they survive a
		-- restart (previously in-memory only in spaces_ext.go).
		CREATE TABLE IF NOT EXISTS user_status (
			user_id     TEXT PRIMARY KEY,
			status      TEXT NOT NULL DEFAULT 'online',
			custom_text TEXT NOT NULL DEFAULT '',
			until_unix  INTEGER NOT NULL DEFAULT 0,
			updated_at  INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS reactions (
			message_id TEXT NOT NULL,
			emoji      TEXT NOT NULL,
			user_id    TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (message_id, emoji, user_id)
		);
		CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
		CREATE TABLE IF NOT EXISTS pins (
			channel_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			author_id  TEXT NOT NULL DEFAULT '',
			body       TEXT NOT NULL DEFAULT '',
			pinned_by  TEXT NOT NULL DEFAULT '',
			pinned_at  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (channel_id, message_id)
		);
		CREATE INDEX IF NOT EXISTS idx_pins_channel ON pins(channel_id);
	`)
	if err != nil {
		return fmt.Errorf("spaces: init schema: %w", err)
	}
	// Full-text search index (FTS5). The virtual table indexes message bodies
	// keyed by (channel_id, msg_id) so SearchMessages is a real inverted-index
	// MATCH instead of a linear scan. modernc/sqlite ships FTS5; if the build
	// lacks it we degrade to the in-memory scan (see ftsAvailable). Use an
	// external-content-free table (own copy of body) for simplicity.
	if _, ferr := p.db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			msg_id UNINDEXED, channel_id UNINDEXED, body, tokenize='unicode61'
		)`); ferr == nil {
		p.fts = true
		// Backfill any rows that predate the FTS index (idempotent: clear+reload).
		_, _ = p.db.Exec(`DELETE FROM messages_fts`)
		_, _ = p.db.Exec(`INSERT INTO messages_fts (msg_id, channel_id, body)
			SELECT id, channel_id, body FROM messages WHERE state != 'tombed'`)
	}
	// Migration: add memberships.display_name to databases created before the
	// name-capture flow landed. CREATE TABLE IF NOT EXISTS above is a no-op for
	// an existing table, so a pre-existing DB needs the column added here. The
	// error is swallowed because SQLite has no "ADD COLUMN IF NOT EXISTS" and a
	// second run (column already present) returns a duplicate-column error.
	_, _ = p.db.Exec(`ALTER TABLE memberships ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`)
	return nil
}

// ---- channels ----------------------------------------------------------------

func (p *SQLitePersister) SaveChannel(ch *models.Channel) error {
	_, err := p.db.Exec(
		`INSERT INTO channels (id, name, type, created_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,
		   created_by=excluded.created_by, updated_at=excluded.updated_at`,
		ch.ID, ch.Name, string(ch.Type), ch.CreatedBy,
		ch.CreatedAt.UnixNano(), ch.UpdatedAt.UnixNano())
	return err
}

func (p *SQLitePersister) ListChannels() ([]*models.Channel, error) {
	rows, err := p.db.Query(`SELECT id, name, type, created_by, created_at, updated_at FROM channels`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Channel
	for rows.Next() {
		var ch models.Channel
		var ctype string
		var created, updated int64
		if err := rows.Scan(&ch.ID, &ch.Name, &ctype, &ch.CreatedBy, &created, &updated); err != nil {
			return nil, err
		}
		ch.Type = models.ChannelType(ctype)
		ch.CreatedAt = time.Unix(0, created)
		ch.UpdatedAt = time.Unix(0, updated)
		out = append(out, &ch)
	}
	return out, rows.Err()
}

func (p *SQLitePersister) GetChannel(id string) (*models.Channel, error) {
	row := p.db.QueryRow(`SELECT id, name, type, created_by, created_at, updated_at FROM channels WHERE id = ?`, id)
	var ch models.Channel
	var ctype string
	var created, updated int64
	if err := row.Scan(&ch.ID, &ch.Name, &ctype, &ch.CreatedBy, &created, &updated); err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("channel not found: %s", id)
		}
		return nil, err
	}
	ch.Type = models.ChannelType(ctype)
	ch.CreatedAt = time.Unix(0, created)
	ch.UpdatedAt = time.Unix(0, updated)
	return &ch, nil
}

func (p *SQLitePersister) DeleteChannel(id string) error {
	_, err := p.db.Exec(`DELETE FROM channels WHERE id = ?`, id)
	return err
}

// ---- memberships -------------------------------------------------------------

func (p *SQLitePersister) SaveMembership(m *models.Membership) error {
	_, err := p.db.Exec(
		`INSERT INTO memberships (id, channel_id, account_id, display_name, joined_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(channel_id, account_id) DO NOTHING`,
		m.ID, m.ChannelID, m.AccountID, m.DisplayName, m.JoinedAt.UnixNano())
	return err
}

func (p *SQLitePersister) ListMemberships(channelID string) ([]*models.Membership, error) {
	rows, err := p.db.Query(`SELECT id, channel_id, account_id, display_name, joined_at FROM memberships WHERE channel_id = ?`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Membership
	for rows.Next() {
		var m models.Membership
		var joined int64
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.AccountID, &m.DisplayName, &joined); err != nil {
			return nil, err
		}
		m.JoinedAt = time.Unix(0, joined)
		out = append(out, &m)
	}
	return out, rows.Err()
}

func (p *SQLitePersister) DeleteMembership(channelID, accountID string) error {
	_, err := p.db.Exec(`DELETE FROM memberships WHERE channel_id = ? AND account_id = ?`, channelID, accountID)
	return err
}

func (p *SQLitePersister) SetMembershipName(channelID, accountID, displayName string) error {
	res, err := p.db.Exec(
		`UPDATE memberships SET display_name = ? WHERE channel_id = ? AND account_id = ?`,
		displayName, channelID, accountID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrMemberNotFound
	}
	return nil
}

// ---- messages ----------------------------------------------------------------

func (p *SQLitePersister) SaveMessage(msg *models.Message) error {
	_, err := p.db.Exec(
		`INSERT INTO messages (id, channel_id, thread_parent, author_id, body, state, seq_clock, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(channel_id, id) DO UPDATE SET
		   thread_parent=excluded.thread_parent, author_id=excluded.author_id,
		   body=excluded.body, state=excluded.state, seq_clock=excluded.seq_clock,
		   updated_at=excluded.updated_at`,
		msg.ID, msg.ChannelID, msg.ThreadParent, msg.AuthorID, msg.Body,
		string(msg.State), msg.SeqClock, msg.CreatedAt.UnixNano(), msg.UpdatedAt.UnixNano())
	if err != nil {
		return err
	}
	p.indexMessage(msg)
	return nil
}

// indexMessage keeps the FTS5 index in sync with a saved/edited/tombstoned
// message. A tombstoned (deleted) message is removed from the index so deleted
// content is not searchable. Errors are swallowed: search is best-effort and
// must never block a message write.
func (p *SQLitePersister) indexMessage(msg *models.Message) {
	if !p.fts {
		return
	}
	// Replace any existing row for this message id, then insert the current body
	// unless the message is tombstoned (deleted).
	_, _ = p.db.Exec(`DELETE FROM messages_fts WHERE msg_id = ?`, msg.ID)
	if msg.State == models.MessageStateTombed {
		return
	}
	_, _ = p.db.Exec(
		`INSERT INTO messages_fts (msg_id, channel_id, body) VALUES (?, ?, ?)`,
		msg.ID, msg.ChannelID, msg.Body)
}

// SearchMessages runs a real FTS5 MATCH over the channel's message bodies and
// returns matching message ids most-recent first. Implements spaces.Searcher.
func (p *SQLitePersister) SearchMessages(channelID string, terms []string) ([]string, error) {
	if !p.fts || len(terms) == 0 {
		return nil, nil
	}
	match := buildFTSMatch(terms)
	if match == "" {
		return nil, nil
	}
	rows, err := p.db.Query(
		`SELECT f.msg_id FROM messages_fts f
		 JOIN messages m ON m.id = f.msg_id AND m.channel_id = f.channel_id
		 WHERE f.channel_id = ? AND f.body MATCH ? AND m.state != 'tombed'
		 ORDER BY m.seq_clock DESC`,
		channelID, match)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// buildFTSMatch turns plain word tokens into a safe FTS5 MATCH expression:
// each token becomes a prefix query (`term*`) quoted to neutralise FTS5
// operators, AND-ed together. Returns "" when no usable token remains.
func buildFTSMatch(terms []string) string {
	var parts []string
	for _, t := range terms {
		clean := sanitizeFTSToken(t)
		if clean == "" {
			continue
		}
		// Quote the term (escaping embedded quotes) and add a prefix wildcard so
		// "deploy" matches "deployment". The wildcard sits OUTSIDE the quotes.
		parts = append(parts, `"`+strings.ReplaceAll(clean, `"`, `""`)+`"*`)
	}
	return strings.Join(parts, " AND ")
}

// sanitizeFTSToken strips characters that are FTS5 syntax so user input can
// never inject an operator/column filter. Keeps letters, digits, and a few
// in-word separators.
func sanitizeFTSToken(t string) string {
	var b strings.Builder
	for _, r := range t {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '_' || r == '-' || r == '@' || r == '.':
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (p *SQLitePersister) scanMessages(rows *sql.Rows) ([]*models.Message, error) {
	defer rows.Close()
	var out []*models.Message
	for rows.Next() {
		var m models.Message
		var state string
		var created, updated int64
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.ThreadParent, &m.AuthorID, &m.Body, &state, &m.SeqClock, &created, &updated); err != nil {
			return nil, err
		}
		m.State = models.MessageState(state)
		m.CreatedAt = time.Unix(0, created)
		m.UpdatedAt = time.Unix(0, updated)
		out = append(out, &m)
	}
	return out, rows.Err()
}

func (p *SQLitePersister) ListMessages(channelID string) ([]*models.Message, error) {
	rows, err := p.db.Query(
		`SELECT id, channel_id, thread_parent, author_id, body, state, seq_clock, created_at, updated_at
		 FROM messages WHERE channel_id = ?`, channelID)
	if err != nil {
		return nil, err
	}
	return p.scanMessages(rows)
}

func (p *SQLitePersister) GetMessage(channelID, id string) (*models.Message, error) {
	rows, err := p.db.Query(
		`SELECT id, channel_id, thread_parent, author_id, body, state, seq_clock, created_at, updated_at
		 FROM messages WHERE channel_id = ? AND id = ?`, channelID, id)
	if err != nil {
		return nil, err
	}
	msgs, err := p.scanMessages(rows)
	if err != nil {
		return nil, err
	}
	if len(msgs) == 0 {
		return nil, fmt.Errorf("message not found: %s", id)
	}
	return msgs[0], nil
}

// ---- ops log -----------------------------------------------------------------

func (p *SQLitePersister) AppendOp(op *models.MessageOp) error {
	msgJSON, err := marshalMessage(&op.Msg)
	if err != nil {
		return err
	}
	_, err = p.db.Exec(
		`INSERT INTO ops (channel_id, op, seq_clock, msg_json, applied_at) VALUES (?, ?, ?, ?, ?)`,
		op.ChannelID, string(op.Op), op.Msg.SeqClock, msgJSON, op.AppliedAt.UnixNano())
	return err
}

func (p *SQLitePersister) ListOps(channelID string, afterClock string) ([]*models.MessageOp, error) {
	// Indexed range scan via idx_ops_channel_seq.
	rows, err := p.db.Query(
		`SELECT channel_id, op, msg_json, applied_at FROM ops
		 WHERE channel_id = ? AND seq_clock > ? ORDER BY seq_clock ASC`,
		channelID, afterClock)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.MessageOp
	for rows.Next() {
		var op models.MessageOp
		var opType, msgJSON string
		var applied int64
		if err := rows.Scan(&op.ChannelID, &opType, &msgJSON, &applied); err != nil {
			return nil, err
		}
		op.Op = models.MessageOpType(opType)
		op.AppliedAt = time.Unix(0, applied)
		msg, err := unmarshalMessage(msgJSON)
		if err != nil {
			return nil, err
		}
		op.Msg = *msg
		out = append(out, &op)
	}
	return out, rows.Err()
}

// ---- read-state --------------------------------------------------------------

func (p *SQLitePersister) SaveReadState(rs *models.ReadState) error {
	// LWW: only advance when the incoming clock is strictly newer.
	row := p.db.QueryRow(`SELECT last_read_clock FROM read_state WHERE account_id = ? AND channel_id = ?`, rs.AccountID, rs.ChannelID)
	var existing string
	switch err := row.Scan(&existing); err {
	case nil:
		if rs.LastReadClock <= existing {
			return nil
		}
	case sql.ErrNoRows:
		// insert below
	default:
		return err
	}
	_, err := p.db.Exec(
		`INSERT INTO read_state (account_id, channel_id, last_read_clock, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(account_id, channel_id) DO UPDATE SET
		   last_read_clock=excluded.last_read_clock, updated_at=excluded.updated_at`,
		rs.AccountID, rs.ChannelID, rs.LastReadClock, rs.UpdatedAt.UnixNano())
	return err
}

func (p *SQLitePersister) GetReadState(accountID, channelID string) (*models.ReadState, error) {
	row := p.db.QueryRow(`SELECT last_read_clock, updated_at FROM read_state WHERE account_id = ? AND channel_id = ?`, accountID, channelID)
	rs := &models.ReadState{AccountID: accountID, ChannelID: channelID}
	var updated int64
	switch err := row.Scan(&rs.LastReadClock, &updated); err {
	case nil:
		rs.UpdatedAt = time.Unix(0, updated)
		return rs, nil
	case sql.ErrNoRows:
		return rs, nil
	default:
		return nil, err
	}
}

// ---- presence: user status --------------------------------------------------

func (p *SQLitePersister) SaveStatus(s *models.UserStatus) error {
	_, err := p.db.Exec(
		`INSERT INTO user_status (user_id, status, custom_text, until_unix, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,
		   custom_text=excluded.custom_text, until_unix=excluded.until_unix,
		   updated_at=excluded.updated_at`,
		s.UserID, s.Status, s.CustomText, s.UntilUnix, s.UpdatedAt.UnixNano())
	return err
}

func (p *SQLitePersister) ListStatuses() ([]*models.UserStatus, error) {
	rows, err := p.db.Query(`SELECT user_id, status, custom_text, until_unix, updated_at FROM user_status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.UserStatus
	for rows.Next() {
		var s models.UserStatus
		var updated int64
		if err := rows.Scan(&s.UserID, &s.Status, &s.CustomText, &s.UntilUnix, &updated); err != nil {
			return nil, err
		}
		s.UpdatedAt = time.Unix(0, updated)
		out = append(out, &s)
	}
	return out, rows.Err()
}

// ---- presence: reactions -----------------------------------------------------

func (p *SQLitePersister) SaveReaction(r *models.Reaction) error {
	_, err := p.db.Exec(
		`INSERT INTO reactions (message_id, emoji, user_id, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(message_id, emoji, user_id) DO NOTHING`,
		r.MessageID, r.Emoji, r.UserID, r.CreatedAt.UnixNano())
	return err
}

func (p *SQLitePersister) DeleteReaction(msgID, emoji, userID string) error {
	_, err := p.db.Exec(
		`DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?`,
		msgID, emoji, userID)
	return err
}

func (p *SQLitePersister) ListReactions() ([]*models.Reaction, error) {
	rows, err := p.db.Query(`SELECT message_id, emoji, user_id, created_at FROM reactions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Reaction
	for rows.Next() {
		var r models.Reaction
		var created int64
		if err := rows.Scan(&r.MessageID, &r.Emoji, &r.UserID, &created); err != nil {
			return nil, err
		}
		r.CreatedAt = time.Unix(0, created)
		out = append(out, &r)
	}
	return out, rows.Err()
}

// ---- presence: pins ----------------------------------------------------------

func (p *SQLitePersister) SavePin(pin *models.PinnedMessage) error {
	_, err := p.db.Exec(
		`INSERT INTO pins (channel_id, message_id, author_id, body, pinned_by, pinned_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(channel_id, message_id) DO UPDATE SET author_id=excluded.author_id,
		   body=excluded.body, pinned_by=excluded.pinned_by, pinned_at=excluded.pinned_at`,
		pin.ChannelID, pin.MessageID, pin.AuthorID, pin.Body, pin.PinnedBy, pin.PinnedAt.UnixNano())
	return err
}

func (p *SQLitePersister) DeletePin(channelID, msgID string) error {
	_, err := p.db.Exec(`DELETE FROM pins WHERE channel_id = ? AND message_id = ?`, channelID, msgID)
	return err
}

func (p *SQLitePersister) ListPins() ([]*models.PinnedMessage, error) {
	rows, err := p.db.Query(`SELECT channel_id, message_id, author_id, body, pinned_by, pinned_at FROM pins`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.PinnedMessage
	for rows.Next() {
		var pin models.PinnedMessage
		var pinnedAt int64
		if err := rows.Scan(&pin.ChannelID, &pin.MessageID, &pin.AuthorID, &pin.Body, &pin.PinnedBy, &pinnedAt); err != nil {
			return nil, err
		}
		pin.PinnedAt = time.Unix(0, pinnedAt)
		out = append(out, &pin)
	}
	return out, rows.Err()
}
