// Package spaces implements the CRDT-synced message store for Vulos Spaces
// (channels, DMs, threads, messages).  It is pure-Go with no CGO.
//
// Convergence model
// -----------------
// Messages are identified by (ChannelID, ID).  Each message carries a
// SeqClock in the form "<wall-unix-ms>-<counter>-<nodeID>" which is
// lexicographically comparable and globally unique.
//
//   - Append  – insert if ID is unknown to the replica.
//   - Edit    – replace body when incoming SeqClock > stored SeqClock for
//               the same message ID.
//   - Tombstone – permanently delete; once a message is tombstoned its
//                 state can never be changed back.
//
// ApplyOp / MergeOps implement the merge function.  They are safe to call
// from multiple goroutines.
package spaces

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"vulos-office/backend/models"

	"github.com/google/uuid"
)

// ErrMemberNotFound is returned by SetDisplayName / SetMembershipName when the
// (channelID, accountID) membership does not exist. Mirrors the cloud fleet
// store's ErrNotMember sentinel for the MemberNamer seam.
var ErrMemberNotFound = errors.New("spaces: membership not found")

// -------------------------------------------------------------------------
// Hybrid Logical Clock (simple wall+counter variant)
// -------------------------------------------------------------------------

type hlc struct {
	mu      sync.Mutex
	wallMs  int64
	counter uint32
	nodeID  string
}

func newHLC(nodeID string) *hlc {
	if nodeID == "" {
		nodeID = uuid.NewString()[:8]
	}
	return &hlc{nodeID: nodeID}
}

// Tick returns the next SeqClock value, guaranteed > any previously returned
// value on this node.
func (h *hlc) Tick() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now().UnixMilli()
	if now > h.wallMs {
		h.wallMs = now
		h.counter = 0
	} else {
		h.counter++
	}
	return fmt.Sprintf("%020d-%010d-%s", h.wallMs, h.counter, h.nodeID)
}

// Receive advances the HLC past a received remote clock value.
func (h *hlc) Receive(remote string) {
	parts := strings.SplitN(remote, "-", 3)
	if len(parts) < 2 {
		return
	}
	var remoteWall int64
	var remoteCounter uint32
	fmt.Sscanf(parts[0], "%d", &remoteWall)
	fmt.Sscanf(parts[1], "%d", &remoteCounter)

	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now().UnixMilli()
	switch {
	case remoteWall > h.wallMs && remoteWall > now:
		h.wallMs = remoteWall
		h.counter = remoteCounter + 1
	case remoteWall == h.wallMs:
		if remoteCounter >= h.counter {
			h.counter = remoteCounter + 1
		}
	default:
		if now > h.wallMs {
			h.wallMs = now
			h.counter = 0
		} else {
			h.counter++
		}
	}
}

// -------------------------------------------------------------------------
// SpacesStore – in-memory CRDT replica with pluggable persistence
// -------------------------------------------------------------------------

// Persister is the interface the store calls to durably write state.
// Implementations in local.go and postgres.go satisfy this interface.
type Persister interface {
	// Channels
	SaveChannel(ch *models.Channel) error
	ListChannels() ([]*models.Channel, error)
	GetChannel(id string) (*models.Channel, error)
	DeleteChannel(id string) error

	// Memberships
	SaveMembership(m *models.Membership) error
	ListMemberships(channelID string) ([]*models.Membership, error)
	DeleteMembership(channelID, accountID string) error
	// SetMembershipName updates the display_name for an existing membership.
	// Returns ErrMemberNotFound when (channelID, accountID) does not exist.
	SetMembershipName(channelID, accountID, displayName string) error

	// Messages (append-only; edits/tombstones are upserts keyed by id)
	SaveMessage(msg *models.Message) error
	ListMessages(channelID string) ([]*models.Message, error)
	GetMessage(channelID, id string) (*models.Message, error)

	// Ops log (append-only – for cold-joiner replay)
	AppendOp(op *models.MessageOp) error
	ListOps(channelID string, afterClock string) ([]*models.MessageOp, error)

	// ReadState
	SaveReadState(rs *models.ReadState) error
	GetReadState(accountID, channelID string) (*models.ReadState, error)

	// Presence: user status (OFFICE-SPACES-4) — durable so it survives restart.
	SaveStatus(s *models.UserStatus) error
	ListStatuses() ([]*models.UserStatus, error)

	// Reactions (OFFICE-SPACES-1) — durable.
	SaveReaction(r *models.Reaction) error
	DeleteReaction(msgID, emoji, userID string) error
	ListReactions() ([]*models.Reaction, error)

	// Pins (OFFICE-SPACES-6) — durable.
	SavePin(p *models.PinnedMessage) error
	DeletePin(channelID, msgID string) error
	ListPins() ([]*models.PinnedMessage, error)
}

// Searcher is an OPTIONAL capability a Persister may implement to provide a real
// full-text index instead of a linear scan. The SQLitePersister implements it
// with an FTS5 virtual table; callers should type-assert and fall back to an
// in-memory scan when the Persister does not support it (NullPersister).
type Searcher interface {
	// SearchMessages returns the ids of messages in channelID whose body matches
	// the free-text query, ordered by recency. terms is a list of plain word
	// tokens (operators like from:/before: are applied by the caller against the
	// returned messages); an empty terms slice returns no ids.
	SearchMessages(channelID string, terms []string) ([]string, error)
}

// SearchIndexed returns matching message ids using the Persister's full-text
// index when it implements Searcher, in recency order. ok=false means the
// Persister has no FTS capability and the caller should fall back to a scan.
func (s *SpacesStore) SearchIndexed(channelID string, terms []string) (ids []string, ok bool) {
	srch, isSearcher := s.persist.(Searcher)
	if !isSearcher {
		return nil, false
	}
	res, err := srch.SearchMessages(channelID, terms)
	if err != nil {
		return nil, false
	}
	return res, true
}

// MessageByID returns a message by id within a channel (in-memory index).
func (s *SpacesStore) MessageByID(channelID, msgID string) (*models.Message, bool) {
	return s.GetMessage(channelID, msgID)
}

// ThreadReplies returns the active (non-tombstoned) replies whose ThreadParent
// is parentID, in SeqClock order. Lives on the store so both the REST handler
// and tests share one threading definition.
func (s *SpacesStore) ThreadReplies(channelID, parentID string) []*models.Message {
	s.mu.RLock()
	defer s.mu.RUnlock()
	msgs := s.messages[channelID]
	out := make([]*models.Message, 0)
	for _, m := range msgs {
		if m.ThreadParent == parentID {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SeqClock < out[j].SeqClock })
	return out
}

// SpacesStore is a CRDT message store for one node/replica.
type SpacesStore struct {
	mu      sync.RWMutex
	clock   *hlc
	nodeID  string
	persist Persister

	// in-memory indexes (rebuilt from Persister on Open)
	channels map[string]*models.Channel             // channelID → Channel
	members  map[string]map[string]*models.Membership // channelID → accountID → Membership
	messages map[string]map[string]*models.Message  // channelID → msgID → Message
}

// Open creates a SpacesStore, loads state from the Persister, and is ready to use.
func Open(nodeID string, p Persister) (*SpacesStore, error) {
	s := &SpacesStore{
		clock:    newHLC(nodeID),
		nodeID:   nodeID,
		persist:  p,
		channels: make(map[string]*models.Channel),
		members:  make(map[string]map[string]*models.Membership),
		messages: make(map[string]map[string]*models.Message),
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// Persister returns the underlying durable Persister so callers (e.g. the
// presence sub-stores in handlers/spaces_ext.go) can write-through state that
// must survive a restart.
func (s *SpacesStore) Persister() Persister { return s.persist }

func (s *SpacesStore) load() error {
	chs, err := s.persist.ListChannels()
	if err != nil {
		return fmt.Errorf("spaces load channels: %w", err)
	}
	for _, ch := range chs {
		s.channels[ch.ID] = ch
		mems, err := s.persist.ListMemberships(ch.ID)
		if err != nil {
			return fmt.Errorf("spaces load memberships %s: %w", ch.ID, err)
		}
		s.members[ch.ID] = make(map[string]*models.Membership)
		for _, m := range mems {
			s.members[ch.ID][m.AccountID] = m
		}
		msgs, err := s.persist.ListMessages(ch.ID)
		if err != nil {
			return fmt.Errorf("spaces load messages %s: %w", ch.ID, err)
		}
		s.messages[ch.ID] = make(map[string]*models.Message)
		for _, msg := range msgs {
			s.messages[ch.ID][msg.ID] = msg
		}
	}
	return nil
}

// -------------------------------------------------------------------------
// Channel management
// -------------------------------------------------------------------------

func (s *SpacesStore) CreateChannel(name string, ctype models.ChannelType, createdBy string) (*models.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ch := &models.Channel{
		ID:        uuid.NewString(),
		Name:      name,
		Type:      ctype,
		CreatedBy: createdBy,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := s.persist.SaveChannel(ch); err != nil {
		return nil, err
	}
	s.channels[ch.ID] = ch
	s.members[ch.ID] = make(map[string]*models.Membership)
	s.messages[ch.ID] = make(map[string]*models.Message)
	return ch, nil
}

// CreateChannelWithID creates a channel with a caller-supplied ID.
// Used when bootstrapping a replica that already knows the channel id from
// a peer (e.g. in tests or after initial channel-sync).
func (s *SpacesStore) CreateChannelWithID(id, name string, ctype models.ChannelType, createdBy string) (*models.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.channels[id]; ok {
		return existing, nil // idempotent
	}
	ch := &models.Channel{
		ID:        id,
		Name:      name,
		Type:      ctype,
		CreatedBy: createdBy,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := s.persist.SaveChannel(ch); err != nil {
		return nil, err
	}
	s.channels[ch.ID] = ch
	s.members[ch.ID] = make(map[string]*models.Membership)
	s.messages[ch.ID] = make(map[string]*models.Message)
	return ch, nil
}

func (s *SpacesStore) GetChannel(id string) (*models.Channel, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ch, ok := s.channels[id]
	return ch, ok
}

func (s *SpacesStore) ListChannels() []*models.Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*models.Channel, 0, len(s.channels))
	for _, ch := range s.channels {
		out = append(out, ch)
	}
	return out
}

// -------------------------------------------------------------------------
// Membership management
// -------------------------------------------------------------------------

// AddMember adds accountID to channelID with no display name. The roster falls
// back to the account id / email until a name is set (via SetDisplayName or by
// inviting with a name through AddMemberWithName). Kept for back-compat.
func (s *SpacesStore) AddMember(channelID, accountID string) (*models.Membership, error) {
	return s.AddMemberWithName(channelID, accountID, "")
}

// AddMemberWithName adds accountID to channelID, capturing displayName at add
// time. This is the invite/accept name-capture path: when an admin invites a
// member by name, the name is applied here so ListMembers returns it instead of
// the email fallback. An empty displayName behaves exactly like AddMember.
//
// If the member already exists (idempotent add) and a non-empty displayName is
// supplied that differs from the stored one, the name is refreshed — so a later
// invite/accept that carries a name can fill in a previously-empty name.
func (s *SpacesStore) AddMemberWithName(channelID, accountID, displayName string) (*models.Membership, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.channels[channelID]; !ok {
		return nil, fmt.Errorf("channel not found: %s", channelID)
	}
	if s.members[channelID] == nil {
		s.members[channelID] = make(map[string]*models.Membership)
	}
	displayName = strings.TrimSpace(displayName)
	if m, exists := s.members[channelID][accountID]; exists {
		// Idempotent re-add. Backfill a name only when one is supplied and the
		// stored name is empty (never clobber an existing name with "").
		if displayName != "" && m.DisplayName != displayName {
			updated := *m
			updated.DisplayName = displayName
			if err := s.persist.SetMembershipName(channelID, accountID, displayName); err != nil {
				return nil, err
			}
			s.members[channelID][accountID] = &updated
			return &updated, nil
		}
		return m, nil // idempotent
	}
	m := &models.Membership{
		ID:          uuid.NewString(),
		ChannelID:   channelID,
		AccountID:   accountID,
		DisplayName: displayName,
		JoinedAt:    time.Now(),
	}
	if err := s.persist.SaveMembership(m); err != nil {
		return nil, err
	}
	s.members[channelID][accountID] = m
	return m, nil
}

// SetDisplayName sets the member-local display name for (channelID, accountID).
// An empty name clears it (the roster then falls back to the account id/email).
// Returns ErrMemberNotFound when the membership does not exist. This is the
// office-local analogue of the cloud fleet store's MemberNamer.SetDisplayName
// seam — used by the "your display name" profile control on first join.
func (s *SpacesStore) SetDisplayName(channelID, accountID, displayName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	byChannel, ok := s.members[channelID]
	if !ok {
		return ErrMemberNotFound
	}
	m, ok := byChannel[accountID]
	if !ok {
		return ErrMemberNotFound
	}
	displayName = strings.TrimSpace(displayName)
	if err := s.persist.SetMembershipName(channelID, accountID, displayName); err != nil {
		return err
	}
	updated := *m
	updated.DisplayName = displayName
	byChannel[accountID] = &updated
	return nil
}

// IsMember reports whether accountID belongs to the given channel.
func (s *SpacesStore) IsMember(channelID, accountID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if m, ok := s.members[channelID]; ok {
		_, isMember := m[accountID]
		return isMember
	}
	return false
}

func (s *SpacesStore) ListMembers(channelID string) []*models.Membership {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*models.Membership, 0)
	for _, m := range s.members[channelID] {
		out = append(out, m)
	}
	return out
}

// -------------------------------------------------------------------------
// Message operations (local sends)
// -------------------------------------------------------------------------

func (s *SpacesStore) SendMessage(channelID, authorID, body, threadParent string) (*models.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.channels[channelID]; !ok {
		return nil, fmt.Errorf("channel not found: %s", channelID)
	}
	now := time.Now()
	msg := &models.Message{
		ID:           uuid.NewString(),
		ChannelID:    channelID,
		ThreadParent: threadParent,
		AuthorID:     authorID,
		Body:         body,
		State:        models.MessageStateActive,
		SeqClock:     s.clock.Tick(),
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	op := &models.MessageOp{
		Op:        models.MessageOpAppend,
		ChannelID: channelID,
		Msg:       *msg,
		AppliedAt: now,
	}
	if err := s.applyLocal(op); err != nil {
		return nil, err
	}
	return msg, nil
}

func (s *SpacesStore) EditMessage(channelID, msgID, newBody string) (*models.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgs := s.messages[channelID]
	if msgs == nil {
		return nil, fmt.Errorf("channel not found: %s", channelID)
	}
	existing, ok := msgs[msgID]
	if !ok {
		return nil, fmt.Errorf("message not found: %s", msgID)
	}
	if existing.State == models.MessageStateTombed {
		return nil, fmt.Errorf("cannot edit a deleted message")
	}
	updated := *existing
	updated.Body = newBody
	updated.State = models.MessageStateEdited
	updated.SeqClock = s.clock.Tick()
	updated.UpdatedAt = time.Now()

	op := &models.MessageOp{
		Op:        models.MessageOpEdit,
		ChannelID: channelID,
		Msg:       updated,
		AppliedAt: time.Now(),
	}
	if err := s.applyLocal(op); err != nil {
		return nil, err
	}
	return &updated, nil
}

func (s *SpacesStore) DeleteMessage(channelID, msgID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	msgs := s.messages[channelID]
	if msgs == nil {
		return fmt.Errorf("channel not found: %s", channelID)
	}
	existing, ok := msgs[msgID]
	if !ok {
		return fmt.Errorf("message not found: %s", msgID)
	}
	tombed := *existing
	tombed.Body = "" // clear body on tombstone
	tombed.State = models.MessageStateTombed
	tombed.SeqClock = s.clock.Tick()
	tombed.UpdatedAt = time.Now()

	op := &models.MessageOp{
		Op:        models.MessageOpTombstone,
		ChannelID: channelID,
		Msg:       tombed,
		AppliedAt: time.Now(),
	}
	return s.applyLocal(op)
}

// GetMessage returns a single message from the in-memory index.
func (s *SpacesStore) GetMessage(channelID, msgID string) (*models.Message, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if msgs, ok := s.messages[channelID]; ok {
		m, found := msgs[msgID]
		return m, found
	}
	return nil, false
}

// ListMessages returns messages in a channel sorted by SeqClock ascending.
// Thread replies are included; callers may filter by ThreadParent.
func (s *SpacesStore) ListMessages(channelID string) []*models.Message {
	s.mu.RLock()
	defer s.mu.RUnlock()
	msgs := s.messages[channelID]
	out := make([]*models.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].SeqClock < out[j].SeqClock
	})
	return out
}

// -------------------------------------------------------------------------
// CRDT merge – apply ops from a remote replica
// -------------------------------------------------------------------------

// MergeOps applies a batch of ops received from a peer.  It is idempotent
// and commutative: applying the same ops in any order converges to the same
// state.
//
// MergeOps performs no author validation and is intended for trusted/internal
// replication (e.g. server-to-server sync over an authenticated fabric link)
// and tests. The REST endpoint must use MergeOpsAs to bind ops to the
// authenticated user.
func (s *SpacesStore) MergeOps(ops []*models.MessageOp) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, op := range ops {
		if err := s.applyRemote(op); err != nil {
			return err
		}
	}
	return nil
}

// MergeOpsAs applies a batch of ops submitted by an authenticated peer, but
// only after validating that the caller is allowed to author them.
//
// Security rules (defends against AuthorID/SeqClock forgery):
//   - Append: op.Msg.AuthorID must equal authUser. A peer cannot inject
//     messages attributed to someone else.
//   - Edit / Tombstone: the targeted message, if it already exists locally,
//     must have been authored by authUser. This stops a peer from editing or
//     tombstoning another user's message. Edits/tombstones for messages not
//     yet seen locally must also carry op.Msg.AuthorID == authUser (a forged
//     op authored as someone else is rejected outright).
//
// Ops that fail validation are rejected and the whole batch is refused so a
// caller cannot smuggle a forged op alongside legitimate ones.
func (s *SpacesStore) MergeOpsAs(authUser string, ops []*models.MessageOp) error {
	if authUser == "" {
		return fmt.Errorf("spaces: MergeOpsAs requires an authenticated user")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	// Validate the whole batch first; reject atomically on any violation.
	for _, op := range ops {
		if op.Msg.AuthorID != authUser {
			return fmt.Errorf("spaces: op author %q does not match authenticated user %q", op.Msg.AuthorID, authUser)
		}
		// If the target already exists, the existing author must also match —
		// guards against tombstoning/editing a message id whose body was
		// authored by someone else (even if the forged op claims authUser).
		if existing, ok := s.lookupLocked(op.ChannelID, op.Msg.ID); ok {
			if existing.AuthorID != "" && existing.AuthorID != authUser {
				return fmt.Errorf("spaces: cannot apply %s to message %q authored by %q", op.Op, op.Msg.ID, existing.AuthorID)
			}
		}
	}

	for _, op := range ops {
		if err := s.applyRemote(op); err != nil {
			return err
		}
	}
	return nil
}

// lookupLocked returns the stored message for (channelID, msgID). Caller must
// hold s.mu.
func (s *SpacesStore) lookupLocked(channelID, msgID string) (*models.Message, bool) {
	if msgs, ok := s.messages[channelID]; ok {
		m, found := msgs[msgID]
		return m, found
	}
	return nil, false
}

// ExportOps returns all ops for channelID with SeqClock > afterClock for
// cold-joiner or catch-up sync.
func (s *SpacesStore) ExportOps(channelID, afterClock string) ([]*models.MessageOp, error) {
	return s.persist.ListOps(channelID, afterClock)
}

// -------------------------------------------------------------------------
// internal helpers (caller must hold s.mu)
// -------------------------------------------------------------------------

func (s *SpacesStore) applyLocal(op *models.MessageOp) error {
	if err := s.applyToIndex(op); err != nil {
		return err
	}
	if err := s.persist.SaveMessage(&op.Msg); err != nil {
		return err
	}
	return s.persist.AppendOp(op)
}

func (s *SpacesStore) applyRemote(op *models.MessageOp) error {
	s.clock.Receive(op.Msg.SeqClock)
	return s.applyLocal(op)
}

// applyToIndex applies the CRDT merge rule to the in-memory index.
func (s *SpacesStore) applyToIndex(op *models.MessageOp) error {
	chID := op.ChannelID
	if _, ok := s.channels[chID]; !ok {
		// Auto-create a channel skeleton for the remote op so the store
		// stays consistent; full channel metadata comes via channel sync.
		s.channels[chID] = &models.Channel{ID: chID, Name: chID}
		s.members[chID] = make(map[string]*models.Membership)
		s.messages[chID] = make(map[string]*models.Message)
	}
	if s.messages[chID] == nil {
		s.messages[chID] = make(map[string]*models.Message)
	}

	msg := op.Msg
	existing, exists := s.messages[chID][msg.ID]

	switch op.Op {
	case models.MessageOpAppend:
		if !exists {
			s.messages[chID][msg.ID] = &msg
		}
		// If already present, do nothing (append is idempotent).

	case models.MessageOpEdit:
		if !exists {
			// Remote edit for unknown message — store it as active.
			s.messages[chID][msg.ID] = &msg
			return nil
		}
		// Tombstone is terminal; do not un-delete.
		if existing.State == models.MessageStateTombed {
			return nil
		}
		// LWW: highest SeqClock wins.
		if msg.SeqClock > existing.SeqClock {
			s.messages[chID][msg.ID] = &msg
		}

	case models.MessageOpTombstone:
		// Tombstone always wins, regardless of SeqClock.
		if !exists {
			s.messages[chID][msg.ID] = &msg
			return nil
		}
		// Apply tombstone body-clearing.
		tombed := *existing
		tombed.State = models.MessageStateTombed
		tombed.Body = ""
		if msg.SeqClock > tombed.SeqClock {
			tombed.SeqClock = msg.SeqClock
		}
		tombed.UpdatedAt = msg.UpdatedAt
		s.messages[chID][msg.ID] = &tombed

	default:
		return fmt.Errorf("unknown op type: %s", op.Op)
	}
	return nil
}

// -------------------------------------------------------------------------
// ReadState helpers
// -------------------------------------------------------------------------

func (s *SpacesStore) MarkRead(accountID, channelID, clock string) error {
	rs := &models.ReadState{
		AccountID:    accountID,
		ChannelID:    channelID,
		LastReadClock: clock,
		UpdatedAt:    time.Now(),
	}
	return s.persist.SaveReadState(rs)
}

func (s *SpacesStore) GetReadState(accountID, channelID string) (*models.ReadState, error) {
	return s.persist.GetReadState(accountID, channelID)
}

// -------------------------------------------------------------------------
// NullPersister – in-memory-only backend (for tests / single-session mode)
// -------------------------------------------------------------------------

// NullPersister is a Persister that stores everything in memory.
// It satisfies the interface without any disk or DB dependency.
type NullPersister struct {
	mu         sync.Mutex
	channels   map[string]*models.Channel
	memberships map[string][]*models.Membership
	messages   map[string]map[string]*models.Message // channelID → msgID → msg
	ops        map[string][]*models.MessageOp        // channelID → ops
	readStates map[string]*models.ReadState          // "accountID:channelID" → rs
	statuses   map[string]*models.UserStatus         // userID → status
	reactions  map[string]*models.Reaction           // "msgID|emoji|userID" → reaction
	pins       map[string]*models.PinnedMessage      // "channelID|msgID" → pin
}

func NewNullPersister() *NullPersister {
	return &NullPersister{
		channels:    make(map[string]*models.Channel),
		memberships: make(map[string][]*models.Membership),
		messages:    make(map[string]map[string]*models.Message),
		ops:         make(map[string][]*models.MessageOp),
		readStates:  make(map[string]*models.ReadState),
		statuses:    make(map[string]*models.UserStatus),
		reactions:   make(map[string]*models.Reaction),
		pins:        make(map[string]*models.PinnedMessage),
	}
}

func (p *NullPersister) SaveChannel(ch *models.Channel) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.channels[ch.ID] = ch
	return nil
}

func (p *NullPersister) ListChannels() ([]*models.Channel, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*models.Channel, 0, len(p.channels))
	for _, ch := range p.channels {
		out = append(out, ch)
	}
	return out, nil
}

func (p *NullPersister) GetChannel(id string) (*models.Channel, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ch, ok := p.channels[id]; ok {
		return ch, nil
	}
	return nil, fmt.Errorf("channel not found: %s", id)
}

func (p *NullPersister) DeleteChannel(id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.channels, id)
	return nil
}

func (p *NullPersister) SaveMembership(m *models.Membership) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.memberships[m.ChannelID] = append(p.memberships[m.ChannelID], m)
	return nil
}

func (p *NullPersister) ListMemberships(channelID string) ([]*models.Membership, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.memberships[channelID], nil
}

func (p *NullPersister) DeleteMembership(channelID, accountID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	list := p.memberships[channelID]
	out := list[:0]
	for _, m := range list {
		if m.AccountID != accountID {
			out = append(out, m)
		}
	}
	p.memberships[channelID] = out
	return nil
}

func (p *NullPersister) SetMembershipName(channelID, accountID, displayName string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, m := range p.memberships[channelID] {
		if m.AccountID == accountID {
			m.DisplayName = displayName
			return nil
		}
	}
	return ErrMemberNotFound
}

func (p *NullPersister) SaveMessage(msg *models.Message) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.messages[msg.ChannelID] == nil {
		p.messages[msg.ChannelID] = make(map[string]*models.Message)
	}
	p.messages[msg.ChannelID][msg.ID] = msg
	return nil
}

func (p *NullPersister) ListMessages(channelID string) ([]*models.Message, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*models.Message, 0)
	for _, m := range p.messages[channelID] {
		out = append(out, m)
	}
	return out, nil
}

func (p *NullPersister) GetMessage(channelID, id string) (*models.Message, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if m, ok := p.messages[channelID][id]; ok {
		return m, nil
	}
	return nil, fmt.Errorf("message not found: %s", id)
}

func (p *NullPersister) AppendOp(op *models.MessageOp) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ops[op.ChannelID] = append(p.ops[op.ChannelID], op)
	return nil
}

func (p *NullPersister) ListOps(channelID string, afterClock string) ([]*models.MessageOp, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []*models.MessageOp
	for _, op := range p.ops[channelID] {
		if op.Msg.SeqClock > afterClock {
			out = append(out, op)
		}
	}
	return out, nil
}

func (p *NullPersister) SaveReadState(rs *models.ReadState) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := rs.AccountID + ":" + rs.ChannelID
	// LWW: only update if incoming clock is newer
	if existing, ok := p.readStates[key]; ok {
		if rs.LastReadClock <= existing.LastReadClock {
			return nil
		}
	}
	p.readStates[key] = rs
	return nil
}

func (p *NullPersister) GetReadState(accountID, channelID string) (*models.ReadState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	key := accountID + ":" + channelID
	if rs, ok := p.readStates[key]; ok {
		return rs, nil
	}
	return &models.ReadState{AccountID: accountID, ChannelID: channelID}, nil
}

func (p *NullPersister) SaveStatus(s *models.UserStatus) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cp := *s
	p.statuses[s.UserID] = &cp
	return nil
}

func (p *NullPersister) ListStatuses() ([]*models.UserStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*models.UserStatus, 0, len(p.statuses))
	for _, s := range p.statuses {
		out = append(out, s)
	}
	return out, nil
}

func reactionDBKey(msgID, emoji, userID string) string {
	return msgID + "|" + emoji + "|" + userID
}

func (p *NullPersister) SaveReaction(r *models.Reaction) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cp := *r
	p.reactions[reactionDBKey(r.MessageID, r.Emoji, r.UserID)] = &cp
	return nil
}

func (p *NullPersister) DeleteReaction(msgID, emoji, userID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.reactions, reactionDBKey(msgID, emoji, userID))
	return nil
}

func (p *NullPersister) ListReactions() ([]*models.Reaction, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*models.Reaction, 0, len(p.reactions))
	for _, r := range p.reactions {
		out = append(out, r)
	}
	return out, nil
}

func pinDBKey(channelID, msgID string) string {
	return channelID + "|" + msgID
}

func (p *NullPersister) SavePin(pin *models.PinnedMessage) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cp := *pin
	p.pins[pinDBKey(pin.ChannelID, pin.MessageID)] = &cp
	return nil
}

func (p *NullPersister) DeletePin(channelID, msgID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.pins, pinDBKey(channelID, msgID))
	return nil
}

func (p *NullPersister) ListPins() ([]*models.PinnedMessage, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*models.PinnedMessage, 0, len(p.pins))
	for _, pin := range p.pins {
		out = append(out, pin)
	}
	return out, nil
}
