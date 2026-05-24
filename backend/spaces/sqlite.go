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
	db *sql.DB
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
			id         TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			account_id TEXT NOT NULL,
			joined_at  INTEGER NOT NULL DEFAULT 0,
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
	`)
	if err != nil {
		return fmt.Errorf("spaces: init schema: %w", err)
	}
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
		`INSERT INTO memberships (id, channel_id, account_id, joined_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(channel_id, account_id) DO NOTHING`,
		m.ID, m.ChannelID, m.AccountID, m.JoinedAt.UnixNano())
	return err
}

func (p *SQLitePersister) ListMemberships(channelID string) ([]*models.Membership, error) {
	rows, err := p.db.Query(`SELECT id, channel_id, account_id, joined_at FROM memberships WHERE channel_id = ?`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Membership
	for rows.Next() {
		var m models.Membership
		var joined int64
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.AccountID, &joined); err != nil {
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
	return err
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
