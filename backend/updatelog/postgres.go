package updatelog

// postgres.go — the Postgres-backed implementation of the update-log Store, the
// production sibling of LocalStore (filesystem). It satisfies the SAME Store
// interface and the SAME semantics:
//
//   - a monotonic seq per file, assigned server-side and never interpreted;
//   - opaque frame bytes (the server stays content-blind);
//   - snapshot compaction that prunes frames at/below the snapshot floor while
//     PRESERVING frames above it (a peer's un-merged work is never dropped);
//   - the stale-snapshot guard (a snapshot whose floor regresses below the
//     current snapshot's floor is refused).
//
// It shares the office schema and connection pool with the primary storage
// backend (search_path is already pinned to "office" on that pool), so the two
// update-log tables live alongside files/folders/versions in one Neon database.
//
// CONCURRENCY: the per-file seq is derived as max(existing)+1. Two concurrent
// appends to the same file must not compute the same seq, so every append takes
// a per-file transaction-scoped advisory lock (pg_advisory_xact_lock) before it
// reads head and writes — serialising appends per file exactly as LocalStore's
// per-file mutex does, but across processes. Appends to DIFFERENT files never
// contend (the lock key is the file id).

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore is the Postgres-backed Store.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore builds a Postgres update-log store over an EXISTING pool
// (typically the primary storage pool, whose search_path is pinned to "office").
// It ensures the two update-log tables exist (idempotent).
func NewPostgresStore(pool *pgxpool.Pool) (*PostgresStore, error) {
	if pool == nil {
		return nil, fmt.Errorf("updatelog: nil postgres pool")
	}
	s := &PostgresStore{pool: pool}
	if err := s.migrate(); err != nil {
		return nil, fmt.Errorf("updatelog: migrate: %w", err)
	}
	return s, nil
}

func (s *PostgresStore) migrate() error {
	ctx := context.Background()
	// CREATE SCHEMA is idempotent and harmless if the primary store already made
	// it; keeping it here lets the update-log store stand up even if it is the
	// first thing to touch the schema.
	if _, err := s.pool.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS office`); err != nil {
		return fmt.Errorf("create schema office: %w", err)
	}
	_, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS file_updates (
			file_id    TEXT   NOT NULL,
			seq        BIGINT NOT NULL,
			kind       TEXT   NOT NULL,
			data       BYTEA  NOT NULL,
			floor      BIGINT NOT NULL DEFAULT 0,
			peer       TEXT   NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (file_id, seq)
		);
		CREATE TABLE IF NOT EXISTS file_update_snapshots (
			file_id    TEXT   PRIMARY KEY,
			seq        BIGINT NOT NULL,
			data       BYTEA  NOT NULL,
			floor      BIGINT NOT NULL DEFAULT 0,
			peer       TEXT   NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`)
	return err
}

// headTx returns the highest seq assigned for a file (max over update frames and
// the snapshot) inside tx. Caller must already hold the per-file advisory lock.
func headTx(ctx context.Context, tx pgx.Tx, fileID string) (int64, error) {
	var head int64
	err := tx.QueryRow(ctx, `
		SELECT GREATEST(
			COALESCE((SELECT MAX(seq) FROM file_updates WHERE file_id = $1), 0),
			COALESCE((SELECT seq     FROM file_update_snapshots WHERE file_id = $1), 0)
		)`, fileID).Scan(&head)
	return head, err
}

func (s *PostgresStore) Append(fileID, kind string, data []byte, peerID string, floor int64) (*Frame, error) {
	if kind != FrameKindUpdate && kind != FrameKindSnapshot {
		return nil, fmt.Errorf("invalid frame kind %q", kind)
	}
	if !idPattern.MatchString(fileID) {
		return nil, fmt.Errorf("invalid file id")
	}
	ctx := context.Background()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful Commit

	// Serialise appends to THIS file across processes: two concurrent appends must
	// not read the same head and mint the same seq. hashtextextended gives a
	// 64-bit key from the file id for the transaction-scoped advisory lock.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, fileID); err != nil {
		return nil, err
	}

	head, err := headTx(ctx, tx, fileID)
	if err != nil {
		return nil, err
	}
	seq := head + 1

	frame := &Frame{
		Seq:    seq,
		Kind:   kind,
		Data:   base64.StdEncoding.EncodeToString(data),
		PeerID: peerID,
	}

	if kind == FrameKindSnapshot {
		// Clamp the floor to what actually exists — a snapshot can only incorporate
		// seqs already assigned.
		if floor < 0 {
			floor = 0
		}
		if floor > head {
			floor = head
		}
		// Stale-snapshot guard: a newer snapshot must not regress below the floor we
		// already hold (it would un-prune / lose ground).
		var existingFloor int64
		var haveSnap bool
		err := tx.QueryRow(ctx, `SELECT floor FROM file_update_snapshots WHERE file_id = $1`, fileID).Scan(&existingFloor)
		switch {
		case err == nil:
			haveSnap = true
		case errors.Is(err, pgx.ErrNoRows):
			haveSnap = false
		default:
			return nil, err
		}
		if haveSnap && floor < existingFloor {
			return nil, fmt.Errorf("stale snapshot: floor %d < existing %d", floor, existingFloor)
		}
		frame.Floor = floor
		if _, err := tx.Exec(ctx, `
			INSERT INTO file_update_snapshots (file_id, seq, data, floor, peer, created_at)
			VALUES ($1, $2, $3, $4, $5, NOW())
			ON CONFLICT (file_id) DO UPDATE
			  SET seq = EXCLUDED.seq, data = EXCLUDED.data, floor = EXCLUDED.floor,
			      peer = EXCLUDED.peer, created_at = NOW()`,
			fileID, seq, data, floor, peerID); err != nil {
			return nil, err
		}
		// Prune every update frame the snapshot now subsumes.
		if _, err := tx.Exec(ctx, `DELETE FROM file_updates WHERE file_id = $1 AND seq <= $2`, fileID, floor); err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return frame, nil
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO file_updates (file_id, seq, kind, data, floor, peer, created_at)
		VALUES ($1, $2, $3, $4, 0, $5, NOW())`,
		fileID, seq, kind, data, peerID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return frame, nil
}

// scanSnapshot reads the file's snapshot (or nil when none). Runs on the pool.
func (s *PostgresStore) scanSnapshot(ctx context.Context, fileID string) (*Frame, error) {
	var (
		seq, floor int64
		data       []byte
		peer       string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT seq, data, floor, peer FROM file_update_snapshots WHERE file_id = $1`, fileID).
		Scan(&seq, &data, &floor, &peer)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Frame{
		Seq:    seq,
		Kind:   FrameKindSnapshot,
		Data:   base64.StdEncoding.EncodeToString(data),
		Floor:  floor,
		PeerID: peer,
	}, nil
}

func (s *PostgresStore) Load(fileID string, since int64) (*Log, error) {
	if !idPattern.MatchString(fileID) {
		return nil, fmt.Errorf("invalid file id")
	}
	ctx := context.Background()

	snap, err := s.scanSnapshot(ctx, fileID)
	if err != nil {
		return nil, err
	}
	head, err := s.Head(fileID)
	if err != nil {
		return nil, err
	}

	out := &Log{Head: head, Frames: []*Frame{}}
	var floor int64
	if snap != nil {
		floor = snap.Floor
	}

	// A caller behind the snapshot floor gets the snapshot plus every frame above
	// the floor; a caller at/past the floor gets only its missing tail. In both
	// cases the frame lower bound is max(since, floor).
	lower := since
	if snap != nil && since < floor {
		out.Snapshot = snap
		lower = floor
	}

	rows, err := s.pool.Query(ctx, `
		SELECT seq, kind, data, floor, peer FROM file_updates
		WHERE file_id = $1 AND seq > $2 ORDER BY seq ASC`, fileID, lower)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			seq, fl int64
			kind    string
			data    []byte
			peer    string
		)
		if err := rows.Scan(&seq, &kind, &data, &fl, &peer); err != nil {
			return nil, err
		}
		out.Frames = append(out.Frames, &Frame{
			Seq:    seq,
			Kind:   kind,
			Data:   base64.StdEncoding.EncodeToString(data),
			Floor:  fl,
			PeerID: peer,
		})
	}
	return out, rows.Err()
}

func (s *PostgresStore) Pending(fileID string) (int64, error) {
	if !idPattern.MatchString(fileID) {
		return 0, fmt.Errorf("invalid file id")
	}
	ctx := context.Background()
	// Count update frames above the current snapshot floor (0 when no snapshot).
	var n int64
	err := s.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM file_updates
		WHERE file_id = $1
		  AND seq > COALESCE((SELECT floor FROM file_update_snapshots WHERE file_id = $1), 0)`,
		fileID).Scan(&n)
	return n, err
}

func (s *PostgresStore) Head(fileID string) (int64, error) {
	if !idPattern.MatchString(fileID) {
		return 0, fmt.Errorf("invalid file id")
	}
	ctx := context.Background()
	var head int64
	err := s.pool.QueryRow(ctx, `
		SELECT GREATEST(
			COALESCE((SELECT MAX(seq) FROM file_updates WHERE file_id = $1), 0),
			COALESCE((SELECT seq     FROM file_update_snapshots WHERE file_id = $1), 0)
		)`, fileID).Scan(&head)
	return head, err
}
