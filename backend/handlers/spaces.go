package handlers

import (
	"log"
	"net/http"
	"os"
	"sync"

	"vulos-office/backend/middleware"
	"vulos-office/backend/models"
	"vulos-office/backend/spaces"

	"github.com/gin-gonic/gin"
)

// SpacesHandler exposes a REST façade over the in-process SpacesStore.
// The SpacesStore is the single source of truth.
//
// OFFICE-60: persistence is durable by default — a SQLite (pure-Go modernc)
// Persister at VULOS_SPACES_DB (default ./data/spaces.db) so messages survive
// a restart. Set VULOS_SPACES_DB=":memory:" (or unset with the test
// constructor) to opt out to an ephemeral in-memory backend.
type SpacesHandler struct {
	mu    sync.RWMutex
	store *spaces.SpacesStore
}

// spacesDBPath resolves the SQLite DSN from env, defaulting to a durable file.
func spacesDBPath() string {
	if v := os.Getenv("VULOS_SPACES_DB"); v != "" {
		return v
	}
	return "./data/spaces.db"
}

// NewSpacesHandler wires a durable SQLite-backed store. If the DB cannot be
// opened it falls back to the in-memory NullPersister so the app still boots
// (degraded: no persistence) rather than crashing.
func NewSpacesHandler() *SpacesHandler {
	var p spaces.Persister
	if sp, err := spaces.NewSQLitePersister(spacesDBPath()); err != nil {
		log.Printf("spaces: durable persister unavailable (%v); falling back to in-memory store", err)
		p = spaces.NewNullPersister()
	} else {
		p = sp
	}
	return newSpacesHandlerWith(p)
}

// NewSpacesHandlerWithPersister builds a handler over a caller-supplied
// Persister. Used by tests (NullPersister or :memory: SQLite) to opt out of
// the default durable file path.
func NewSpacesHandlerWithPersister(p spaces.Persister) *SpacesHandler {
	return newSpacesHandlerWith(p)
}

func newSpacesHandlerWith(p spaces.Persister) *SpacesHandler {
	s, _ := spaces.Open("server", p)
	h := &SpacesHandler{store: s}
	// Seed a default general channel so the UI has something to show
	// (idempotent — survives across restarts via the durable persister).
	_, _ = s.CreateChannelWithID("general", "general", models.ChannelTypePublic, "system")
	return h
}

// -------------------------------------------------------------------------
// Channel-membership authorization
// -------------------------------------------------------------------------

// canAccessChannel enforces channel-membership authz.
//
// Rules:
//   - Public channels: any authenticated user may read/post.
//   - Private / DM channels: the requester MUST be a member.
//   - Unknown channel: deny (treated as private until it exists).
//
// Returns (allowed, exists).
func (h *SpacesHandler) canAccessChannel(channelID, requester string) (allowed, exists bool) {
	ch, ok := h.store.GetChannel(channelID)
	if !ok {
		return false, false
	}
	switch ch.Type {
	case models.ChannelTypePrivate, models.ChannelTypeDM:
		return h.store.IsMember(channelID, requester), true
	default: // public (and any unset/legacy type)
		return true, true
	}
}

// requireChannelAccess writes the appropriate error response and returns false
// when the requester may not access the channel.
func (h *SpacesHandler) requireChannelAccess(c *gin.Context, channelID, requester string) bool {
	allowed, exists := h.canAccessChannel(channelID, requester)
	if !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return false
	}
	if !allowed {
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of this channel"})
		return false
	}
	return true
}

// findMessageChannel locates the channel that owns msgID by scanning known
// channels. Used by message-scoped routes (react/unreact) that don't carry a
// channelId path param so we can still enforce membership.
func (h *SpacesHandler) findMessageChannel(msgID string) (string, bool) {
	for _, ch := range h.store.ListChannels() {
		for _, m := range h.store.ListMessages(ch.ID) {
			if m.ID == msgID {
				return ch.ID, true
			}
		}
	}
	return "", false
}

// -------------------------------------------------------------------------
// Channels
// -------------------------------------------------------------------------

func (h *SpacesHandler) ListChannels(c *gin.Context) {
	requester := requesterID(c)
	all := h.store.ListChannels()
	// Hide private/DM channels the requester is not a member of.
	chs := make([]*models.Channel, 0, len(all))
	for _, ch := range all {
		switch ch.Type {
		case models.ChannelTypePrivate, models.ChannelTypeDM:
			if h.store.IsMember(ch.ID, requester) {
				chs = append(chs, ch)
			}
		default:
			chs = append(chs, ch)
		}
	}
	c.JSON(http.StatusOK, chs)
}

func (h *SpacesHandler) CreateChannel(c *gin.Context) {
	var req models.CreateChannelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctype := req.Type
	if ctype == "" {
		ctype = models.ChannelTypePublic
	}
	requester := requesterID(c)
	ch, err := h.store.CreateChannel(req.Name, ctype, requester)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Auto-join the creator.
	if len(req.Members) == 0 {
		req.Members = []string{requester}
	}
	for _, accountID := range req.Members {
		_, _ = h.store.AddMember(ch.ID, accountID)
	}
	c.JSON(http.StatusCreated, ch)
}

// -------------------------------------------------------------------------
// Membership
// -------------------------------------------------------------------------

func (h *SpacesHandler) JoinChannel(c *gin.Context) {
	channelID := c.Param("channelId")
	accountID := requesterID(c)
	// A user may only join themselves. Private/DM channels are invite-only:
	// non-members cannot self-join (membership is managed at channel creation
	// or by an existing member via the members list, not implemented here).
	ch, ok := h.store.GetChannel(channelID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}
	if ch.Type == models.ChannelTypePrivate || ch.Type == models.ChannelTypeDM {
		if !h.store.IsMember(channelID, accountID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "cannot self-join a private channel"})
			return
		}
	}
	m, err := h.store.AddMember(channelID, accountID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, m)
}

func (h *SpacesHandler) ListMembers(c *gin.Context) {
	channelID := c.Param("channelId")
	if !h.requireChannelAccess(c, channelID, requesterID(c)) {
		return
	}
	members := h.store.ListMembers(channelID)
	if members == nil {
		members = []*models.Membership{}
	}
	c.JSON(http.StatusOK, members)
}

// -------------------------------------------------------------------------
// Messages
// -------------------------------------------------------------------------

func (h *SpacesHandler) ListMessages(c *gin.Context) {
	channelID := c.Param("channelId")
	if !h.requireChannelAccess(c, channelID, requesterID(c)) {
		return
	}
	msgs := h.store.ListMessages(channelID)
	if msgs == nil {
		msgs = []*models.Message{}
	}
	c.JSON(http.StatusOK, msgs)
}

func (h *SpacesHandler) SendMessage(c *gin.Context) {
	channelID := c.Param("channelId")
	var req models.SendMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	authorID := requesterID(c)
	if !h.requireChannelAccess(c, channelID, authorID) {
		return
	}
	msg, err := h.store.SendMessage(channelID, authorID, req.Body, req.ThreadParent)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, msg)
}

func (h *SpacesHandler) EditMessage(c *gin.Context) {
	channelID := c.Param("channelId")
	msgID := c.Param("msgId")
	requester := requesterID(c)
	if !h.requireChannelAccess(c, channelID, requester) {
		return
	}
	if !h.requireMessageAuthor(c, channelID, msgID, requester) {
		return
	}
	var req models.EditMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	msg, err := h.store.EditMessage(channelID, msgID, req.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, msg)
}

func (h *SpacesHandler) DeleteMessage(c *gin.Context) {
	channelID := c.Param("channelId")
	msgID := c.Param("msgId")
	requester := requesterID(c)
	if !h.requireChannelAccess(c, channelID, requester) {
		return
	}
	if !h.requireMessageAuthor(c, channelID, msgID, requester) {
		return
	}
	if err := h.store.DeleteMessage(channelID, msgID); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// requireMessageAuthor allows the operation only when the requester authored
// the target message (or is an admin). Returns false (and writes the response)
// otherwise.
func (h *SpacesHandler) requireMessageAuthor(c *gin.Context, channelID, msgID, requester string) bool {
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	msg, ok := h.store.GetMessage(channelID, msgID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "message not found"})
		return false
	}
	if msg.AuthorID != requester {
		c.JSON(http.StatusForbidden, gin.H{"error": "cannot modify another user's message"})
		return false
	}
	return true
}

// -------------------------------------------------------------------------
// Read-state
// -------------------------------------------------------------------------

func (h *SpacesHandler) MarkRead(c *gin.Context) {
	channelID := c.Param("channelId")
	accountID := requesterID(c)
	if !h.requireChannelAccess(c, channelID, accountID) {
		return
	}
	var body struct {
		Clock string `json:"clock"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Clock == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "clock required"})
		return
	}
	if err := h.store.MarkRead(accountID, channelID, body.Clock); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SpacesHandler) GetReadState(c *gin.Context) {
	channelID := c.Param("channelId")
	accountID := requesterID(c)
	if !h.requireChannelAccess(c, channelID, accountID) {
		return
	}
	rs, err := h.store.GetReadState(accountID, channelID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, rs)
}

// -------------------------------------------------------------------------
// CRDT op sync (pull/push for cold-joiner catch-up)
// -------------------------------------------------------------------------

func (h *SpacesHandler) ExportOps(c *gin.Context) {
	channelID := c.Param("channelId")
	if !h.requireChannelAccess(c, channelID, requesterID(c)) {
		return
	}
	afterClock := c.Query("after")
	ops, err := h.store.ExportOps(channelID, afterClock)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if ops == nil {
		ops = []*models.MessageOp{}
	}
	c.JSON(http.StatusOK, ops)
}

func (h *SpacesHandler) MergeOps(c *gin.Context) {
	var ops []*models.MessageOp
	if err := c.ShouldBindJSON(&ops); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	requester := requesterID(c)
	// Enforce channel membership for every channel touched by the batch before
	// applying anything. Public channels are open; private/DM require membership.
	seen := make(map[string]bool)
	for _, op := range ops {
		if op == nil || seen[op.ChannelID] {
			continue
		}
		seen[op.ChannelID] = true
		// Only enforce for channels that already exist as private/DM; unknown
		// channels are created as public skeletons by the CRDT merge and remain
		// subject to author validation below.
		if ch, ok := h.store.GetChannel(op.ChannelID); ok {
			if ch.Type == models.ChannelTypePrivate || ch.Type == models.ChannelTypeDM {
				if !h.store.IsMember(op.ChannelID, requester) {
					c.JSON(http.StatusForbidden, gin.H{"error": "not a member of channel " + op.ChannelID})
					return
				}
			}
		}
	}
	// Author validation: a peer may only submit ops authored as themselves.
	if err := h.store.MergeOpsAs(requester, ops); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"applied": len(ops)})
}
