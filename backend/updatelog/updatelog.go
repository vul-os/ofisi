// Package updatelog implements the per-file, append-only CRDT update log — the
// phase-1 CRDT-native durability model that layers on top of (and eventually
// replaces) the single-blob "whole-document PUT + 409 compare-and-swap" store.
//
// WHY
// ---
// The whole-doc PUT is a last-writer-wins blob guarded by an optimistic-
// concurrency rev: two clients that both edited offline collide on save and one
// must discard and reconcile. Office's editing model is already CRDT-based
// (Yjs for Docs/whiteboards; hand-rolled RGA/LWW/tree CRDTs for the others), and
// CRDT updates are commutative + idempotent: if we simply KEEP every update
// frame, any set of divergent offline edits merges to one convergent document
// with nothing discarded. This log is that keep-everything store.
//
// MODEL
// -----
//   - Each file has an ordered, append-only sequence of opaque frames. The
//     server assigns a monotonic seq per file and NEVER interprets a frame's
//     bytes — a frame is an encrypted-or-plain Yjs update (or a sheet/slide CRDT
//     op). The server stays content-blind; merge semantics live entirely in the
//     client CRDT.
//   - Compaction: a client periodically posts a `snapshot` frame — the whole
//     compacted CRDT state (e.g. Y.encodeStateAsUpdate) — together with the
//     `floor` seq it incorporates. The store keeps the latest snapshot and
//     prunes every update frame with seq <= floor. Frames ABOVE the floor
//     (edits the snapshotting client had not yet integrated) are preserved, so
//     compaction can never drop a peer's un-merged work.
//   - Load: return the latest snapshot (if the caller is behind it) plus every
//     frame the caller is missing. Applying snapshot-then-frames reconstructs
//     the document; because the frames are CRDT updates, order of application
//     does not affect the converged result.
//
// This phase-1 implementation is filesystem-backed (LocalStore); a Postgres
// implementation can satisfy the same Store interface later.
package updatelog

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// FrameKindUpdate is an incremental CRDT update frame.
const FrameKindUpdate = "update"

// FrameKindSnapshot is a compacted whole-state frame (see package doc).
const FrameKindSnapshot = "snapshot"

// Frame is one opaque entry in a file's log. Data is base64 so the wire form and
// the on-disk form are identical and the server never has to decode it.
type Frame struct {
	Seq       int64     `json:"seq"`
	Kind      string    `json:"kind"`
	Data      string    `json:"data"`            // base64 opaque bytes
	Floor     int64     `json:"floor,omitempty"` // snapshot only: seq it incorporates
	PeerID    string    `json:"peer,omitempty"`  // server-verified appender (never trusted from body)
	CreatedAt time.Time `json:"created_at"`
}

// Log is the result of loading a file's update log.
type Log struct {
	// Snapshot is the latest compacted state frame the caller needs (nil when
	// the caller is already past the snapshot floor, or none exists).
	Snapshot *Frame `json:"snapshot"`
	// Frames are the update frames the caller is missing, ascending by seq.
	Frames []*Frame `json:"frames"`
	// Head is the highest seq assigned for this file (0 when empty).
	Head int64 `json:"head"`
}

// Store is the append-only update-log backend.
type Store interface {
	// Append adds an opaque frame and returns it with its assigned seq. For a
	// snapshot, floor is the seq the snapshot incorporates (frames <= floor are
	// pruned). PeerID stamps the server-verified appender.
	Append(fileID, kind string, data []byte, peerID string, floor int64) (*Frame, error)
	// Load returns the snapshot + frames a caller who already holds up to
	// `since` (0 = nothing) is missing.
	Load(fileID string, since int64) (*Log, error)
	// Head returns the highest seq assigned for a file (0 when empty).
	Head(fileID string) (int64, error)
	// Pending returns the number of un-compacted update frames — those with
	// seq ABOVE the latest snapshot's floor (or all frames when no snapshot
	// exists). It is the server-side compaction-pressure signal: when it grows
	// large the log should be compacted by a client posting a fresh snapshot (the
	// server CANNOT compact opaque CRDT frames itself). Cheap — it never
	// materialises frame payloads.
	Pending(fileID string) (int64, error)
}

// CompactAdviseThreshold is the number of un-compacted update frames at which
// the server advises the appending client to post a snapshot NOW (see
// Store.Pending). Client-driven compaction stays primary — the server never
// fabricates a snapshot; it can only nudge, because it cannot merge opaque CRDT
// frames. The threshold is set well above the client's own snapshotEvery (150)
// so it only fires when NO single client is accumulating enough edits to
// self-compact (e.g. many short-lived clients each appending a few frames). It
// is a var (not a const) purely so tests can drive the nudge without appending
// hundreds of frames; production never mutates it.
var CompactAdviseThreshold int64 = 600

// ---- LocalStore (filesystem) ----

// idPattern constrains a file id to a safe single path segment (letters,
// digits, '_' , '-'), rejecting "", ".", "..", and any path separator — a
// caller-supplied id can never escape the updates root.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// framePattern matches a frame file name: f<zero-padded seq>.json.
var framePattern = regexp.MustCompile(`^f(\d+)\.json$`)

const seqWidth = 20 // zero-pad seq so lexical order == numeric order

// LocalStore keeps each file's log under baseDir/<fileID>/:
//   - f00000000000000000001.json … — update frames
//   - snapshot.json                — the single latest compacted snapshot
type LocalStore struct {
	baseDir string
	mu      sync.Mutex // serialises append/compaction (phase-1 single box)
}

// NewLocalStore roots a filesystem update log at baseDir (created if absent).
func NewLocalStore(baseDir string) (*LocalStore, error) {
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, fmt.Errorf("create update-log dir %s: %w", baseDir, err)
	}
	return &LocalStore{baseDir: baseDir}, nil
}

func (s *LocalStore) fileDir(fileID string) (string, error) {
	if !idPattern.MatchString(fileID) {
		return "", fmt.Errorf("invalid file id")
	}
	return filepath.Join(s.baseDir, fileID), nil
}

func framePath(dir string, seq int64) string {
	return filepath.Join(dir, fmt.Sprintf("f%0*d.json", seqWidth, seq))
}

func snapshotPath(dir string) string { return filepath.Join(dir, "snapshot.json") }

func readFrameFile(path string) (*Frame, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f Frame
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

// readSnapshot returns the latest snapshot frame, or (nil, nil) if none.
func readSnapshot(dir string) (*Frame, error) {
	f, err := readFrameFile(snapshotPath(dir))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// listFrames returns every update frame present, ascending by seq.
func listFrames(dir string) ([]*Frame, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var frames []*Frame
	for _, e := range entries {
		if e.IsDir() || !framePattern.MatchString(e.Name()) {
			continue
		}
		f, err := readFrameFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue // skip an unreadable/corrupt frame rather than fail the whole load
		}
		frames = append(frames, f)
	}
	sort.Slice(frames, func(i, j int) bool { return frames[i].Seq < frames[j].Seq })
	return frames, nil
}

// headLocked computes the highest seq assigned (frames + snapshot). Caller holds mu.
func headLocked(dir string) (int64, *Frame, []*Frame, error) {
	snap, err := readSnapshot(dir)
	if err != nil {
		return 0, nil, nil, err
	}
	frames, err := listFrames(dir)
	if err != nil {
		return 0, nil, nil, err
	}
	var head int64
	if snap != nil {
		head = snap.Seq
	}
	for _, f := range frames {
		if f.Seq > head {
			head = f.Seq
		}
	}
	return head, snap, frames, nil
}

func (s *LocalStore) Append(fileID, kind string, data []byte, peerID string, floor int64) (*Frame, error) {
	if kind != FrameKindUpdate && kind != FrameKindSnapshot {
		return nil, fmt.Errorf("invalid frame kind %q", kind)
	}
	dir, err := s.fileDir(fileID)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create file log dir: %w", err)
	}
	head, snap, frames, err := headLocked(dir)
	if err != nil {
		return nil, err
	}
	seq := head + 1
	frame := &Frame{
		Seq:       seq,
		Kind:      kind,
		Data:      base64.StdEncoding.EncodeToString(data),
		PeerID:    peerID,
		CreatedAt: time.Now().UTC(),
	}

	if kind == FrameKindSnapshot {
		// Clamp the floor to what actually exists; a snapshot can only ever be
		// said to incorporate seqs already assigned.
		if floor < 0 {
			floor = 0
		}
		if floor > head {
			floor = head
		}
		// A newer snapshot must not regress: reject one whose floor is below the
		// snapshot we already hold (it would un-prune / lose ground).
		if snap != nil && floor < snap.Floor {
			return nil, fmt.Errorf("stale snapshot: floor %d < existing %d", floor, snap.Floor)
		}
		frame.Floor = floor
		if err := writeJSON(snapshotPath(dir), frame); err != nil {
			return nil, err
		}
		// Prune every update frame the snapshot now subsumes.
		for _, f := range frames {
			if f.Seq <= floor {
				_ = os.Remove(framePath(dir, f.Seq))
			}
		}
		return frame, nil
	}

	if err := writeJSON(framePath(dir, seq), frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func (s *LocalStore) Load(fileID string, since int64) (*Log, error) {
	dir, err := s.fileDir(fileID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	head, snap, frames, err := headLocked(dir)
	if err != nil {
		return nil, err
	}
	out := &Log{Head: head, Frames: []*Frame{}}
	var floor int64
	if snap != nil {
		floor = snap.Floor
	}
	if snap != nil && since < floor {
		// Caller is behind the snapshot: hand it the snapshot plus every frame
		// above the floor.
		out.Snapshot = snap
		for _, f := range frames {
			if f.Seq > floor {
				out.Frames = append(out.Frames, f)
			}
		}
		return out, nil
	}
	// Caller is at or past the floor: just the frames it hasn't seen.
	for _, f := range frames {
		if f.Seq > since {
			out.Frames = append(out.Frames, f)
		}
	}
	return out, nil
}

func (s *LocalStore) Head(fileID string) (int64, error) {
	dir, err := s.fileDir(fileID)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	head, _, _, err := headLocked(dir)
	return head, err
}

func (s *LocalStore) Pending(fileID string) (int64, error) {
	dir, err := s.fileDir(fileID)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, snap, frames, err := headLocked(dir)
	if err != nil {
		return 0, err
	}
	var floor int64
	if snap != nil {
		floor = snap.Floor
	}
	var n int64
	for _, f := range frames {
		if f.Seq > floor {
			n++
		}
	}
	return n, nil
}

// writeJSON writes v to path atomically-ish (write temp, rename) so a crashed
// write never leaves a truncated frame that would fail every future load.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// DecodeFrame decodes a frame's opaque bytes (helper for consumers/tests).
func DecodeFrame(f *Frame) ([]byte, error) {
	return base64.StdEncoding.DecodeString(strings.TrimSpace(f.Data))
}
