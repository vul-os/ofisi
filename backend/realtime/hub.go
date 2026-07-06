// Package realtime implements the server-mediated live-collaboration broker for
// Vulos Office (WAVE37). It is a per-document pub/sub fan-out that the doc-sync
// op-ingest write path publishes into, and that session-authed SSE connections
// subscribe to for the documents they are authorized to read.
//
// This is the CLOUD / account collaboration path — a fallback and complement to
// the peer-to-peer fabric (src/lib/crdt/*, @vulos/relay-client). When no p2p
// peer is reachable (no relay, no WebRTC), two editors still converge and the
// document still stays saved, because their CRDT ops flow through this server
// hub and are persisted authoritatively (see backend/docsync). The p2p path is
// E2E-encrypted and is deliberately NOT routed through this readable server —
// only the account/cloud path uses the hub.
//
// Transport decision: Server-Sent Events (SSE) for the server→client push, and
// an authenticated REST POST for the client→server op ingest. This mirrors the
// pattern Vulos Talk shipped (backend/realtime + handlers/stream.go):
//
//   - No WebSocket library is vendored (go.mod has none); gin already ships
//     gin-contrib/sse, so SSE adds ZERO new dependencies.
//   - SSE rides the SAME session cookie / vk_ API key as every other /v1 call
//     (middleware.V1Auth). A browser WebSocket cannot attach the cookie as
//     uniformly, and the session token was deliberately removed from the query
//     string, so a cookie-authed SSE + REST-POST duplex is the clean fit.
//   - The client op stream is one-directional per leg (down over SSE, up over
//     POST), so a full duplex socket buys nothing here.
//
// The hub is transport-agnostic: it hands each subscriber a buffered channel of
// pre-marshalled JSON frames. The SSE handler (backend/handlers/docsync.go)
// owns framing. The hub does NOT enforce authz — the handler verifies the doc
// ACL (viewer to subscribe, editor to publish) before calling Subscribe /
// Publish, exactly as the rest of the codebase splits handler-enforces /
// store-trusts.
package realtime

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
)

// Event is one server-push frame. Type discriminates the payload the client
// applies. Payload is an already-shaped value marshalled to JSON on publish.
//
// Types:
//
//	"op"   — a CRDT TextOp (RGA insert/delete, wire shape {k,id,p,v,t}) wrapped
//	         as {origin, seq, op}. The client applies it to the same crdt/text
//	         TextCRDT store used by the p2p path; TextCRDT.apply is idempotent
//	         (deduped by op id), so a pushed op it already has is a no-op and a
//	         pushed op that also arrived over p2p never double-applies.
//	"snap" — a full CRDT snapshot {origin, seq, snap} for late-joiner bootstrap.
//	"ping" — heartbeat keep-alive (no payload).
type Event struct {
	Type    string      `json:"type"`
	DocID   string      `json:"doc_id,omitempty"`
	Origin  string      `json:"origin,omitempty"` // replica/tab id that produced it (self-echo filter)
	Seq     uint64      `json:"seq,omitempty"`    // server-assigned monotonic sequence for this doc
	Payload interface{} `json:"payload,omitempty"`
}

// Tuning bounds. These keep a single connection (and the hub as a whole) from
// being turned into a memory/DoS amplifier.
const (
	// subBuffer is the per-subscriber queue depth. A subscriber that falls this
	// far behind is dropped (slow-consumer backpressure) rather than blocking
	// the publisher or growing without bound.
	subBuffer = 128

	// MaxDocsPerConn caps how many documents one connection may subscribe to,
	// bounding the fan-out work a single client can request.
	MaxDocsPerConn = 64

	// MaxConnsPerUser caps how many concurrent live stream connections one
	// authenticated account may hold open. Without it a single account could
	// open unbounded EventSource connections, each pinning a goroutine, a
	// buffered frame channel, and hub index entries — a memory/goroutine
	// exhaustion vector (the wave-38 gap Talk closed). A legitimate client opens
	// one stream per document tab, so this ceiling is generous for real use while
	// capping abuse.
	MaxConnsPerUser = 20

	// MaxTotalSubs is a hard process-wide ceiling on live subscribers, a
	// last-resort backstop against a flood spread across many accounts. Beyond
	// it, new subscriptions are refused (the client falls back to /collab/state
	// polling) rather than exhausting the process.
	MaxTotalSubs = 50000

	// HeartbeatInterval is how often the hub emits a keep-alive ping to every
	// live subscriber so idle proxies don't cut the stream and the client can
	// detect a dead connection.
	HeartbeatInterval = 25 * time.Second
)

// subscriber is one live connection's view onto the hub.
type subscriber struct {
	id      uint64
	owner   string          // account id that opened this connection (for per-user caps)
	out     chan []byte     // buffered pre-marshalled frames
	docs    map[string]bool // doc ids this sub is subscribed to
	dropped atomic.Bool     // set true when we drop the connection for lag
}

// Hub is the process-wide realtime broker.
type Hub struct {
	mu sync.RWMutex
	// byDoc[docID] = set of subscribers subscribed to it.
	byDoc map[string]map[uint64]*subscriber
	// all subscribers, for heartbeat fan-out.
	subs map[uint64]*subscriber
	// byOwner[accountID] = count of live connections that account holds, for the
	// per-user connection cap.
	byOwner map[string]int
	nextID  uint64

	stop chan struct{}
	once sync.Once
}

// NewHub builds a Hub and starts its heartbeat loop.
func NewHub() *Hub {
	h := &Hub{
		byDoc:   make(map[string]map[uint64]*subscriber),
		subs:    make(map[uint64]*subscriber),
		byOwner: make(map[string]int),
		stop:    make(chan struct{}),
	}
	go h.heartbeatLoop()
	return h
}

// Close stops the heartbeat loop. Safe to call multiple times.
func (h *Hub) Close() { h.once.Do(func() { close(h.stop) }) }

// Subscription is the caller-facing handle returned by Subscribe. Frames is the
// stream of JSON frames to write to the client; it is closed when the
// subscription ends. Cancel tears the subscription down and must be called
// (defer it) when the connection closes.
type Subscription struct {
	Frames <-chan []byte
	Cancel func()
	id     uint64
}

// Subscribe registers a new connection for the given (already ACL-checked) doc
// ids, owned by the given account. The caller MUST have verified read access for
// every id — the hub does not itself enforce authz; it only fans out to whoever
// it was told to. This mirrors the split elsewhere in the codebase where the
// handler enforces FileAuthz.require and the store trusts the caller.
//
// Subscribe returns nil when a resource bound is exceeded — the per-user
// connection cap (MaxConnsPerUser) or the process-wide ceiling (MaxTotalSubs).
// The caller MUST treat a nil result as "refused" and respond fail-closed (429),
// not open a stream. owner "" is treated as a single shared local identity
// (self-host mode) and is still subject to the caps. At most MaxDocsPerConn doc
// ids are honored per connection (excess ids are ignored) so one connection
// cannot request unbounded fan-out work.
func (h *Hub) Subscribe(owner string, docIDs []string) *Subscription {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Resource caps (fail closed). Refuse rather than let one account, or a
	// coordinated flood, exhaust goroutines/memory.
	if len(h.subs) >= MaxTotalSubs {
		return nil
	}
	if h.byOwner[owner] >= MaxConnsPerUser {
		return nil
	}

	h.nextID++
	id := h.nextID
	sub := &subscriber{
		id:    id,
		owner: owner,
		out:   make(chan []byte, subBuffer),
		docs:  make(map[string]bool, len(docIDs)),
	}
	for _, did := range docIDs {
		if did == "" {
			continue
		}
		if len(sub.docs) >= MaxDocsPerConn {
			break
		}
		sub.docs[did] = true
		set := h.byDoc[did]
		if set == nil {
			set = make(map[uint64]*subscriber)
			h.byDoc[did] = set
		}
		set[id] = sub
	}
	h.subs[id] = sub
	h.byOwner[owner]++

	return &Subscription{
		Frames: sub.out,
		id:     id,
		Cancel: func() { h.unsubscribe(id) },
	}
}

func (h *Hub) unsubscribe(id uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	sub, ok := h.subs[id]
	if !ok {
		return
	}
	for did := range sub.docs {
		if set := h.byDoc[did]; set != nil {
			delete(set, id)
			if len(set) == 0 {
				delete(h.byDoc, did)
			}
		}
	}
	delete(h.subs, id)
	if h.byOwner[sub.owner] <= 1 {
		delete(h.byOwner, sub.owner)
	} else {
		h.byOwner[sub.owner]--
	}
	close(sub.out)
}

// Publish fans an event out to every subscriber of ev.DocID. A subscriber whose
// buffer is full is dropped (its stream is closed) rather than blocking the
// publisher — slow-consumer backpressure. Publish never blocks and is safe to
// call from any goroutine.
func (h *Hub) Publish(ev Event) {
	if ev.DocID == "" {
		return
	}
	frame, err := json.Marshal(ev)
	if err != nil {
		return
	}
	var lagging []uint64
	h.mu.RLock()
	for id, sub := range h.byDoc[ev.DocID] {
		select {
		case sub.out <- frame:
		default:
			// Buffer full: mark for drop. Don't mutate the map under RLock.
			sub.dropped.Store(true)
			lagging = append(lagging, id)
		}
	}
	h.mu.RUnlock()
	for _, id := range lagging {
		h.unsubscribe(id)
	}
}

// heartbeatLoop emits a ping frame to every live subscriber on an interval so
// idle connections stay open through proxies and dead peers are detected on the
// next write.
func (h *Hub) heartbeatLoop() {
	ping, _ := json.Marshal(Event{Type: "ping"})
	t := time.NewTicker(HeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-h.stop:
			return
		case <-t.C:
			var lagging []uint64
			h.mu.RLock()
			for id, sub := range h.subs {
				select {
				case sub.out <- ping:
				default:
					sub.dropped.Store(true)
					lagging = append(lagging, id)
				}
			}
			h.mu.RUnlock()
			for _, id := range lagging {
				h.unsubscribe(id)
			}
		}
	}
}

// SubscriberCount returns the number of live subscribers for a doc (test /
// metrics helper).
func (h *Hub) SubscriberCount(docID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.byDoc[docID])
}

// ConnCountForUser returns how many live connections an account currently holds
// (test / metrics helper for the per-user connection cap).
func (h *Hub) ConnCountForUser(owner string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.byOwner[owner]
}
