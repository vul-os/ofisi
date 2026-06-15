package handlers

// presence.go — REST/poll presence for Vulos Spaces (OFFICE-62 REST path).
//
// Two endpoints:
//   POST /api/spaces/presence/heartbeat   { status, status_text, display_name }  → 200 {"ok":true}
//   GET  /api/spaces/presence/roster      → [{user_id, display_name, status, status_text, last_seen}]
//
// In-memory store: TTL 35 s (client polls every 15 s, heartbeat every 15 s).
// No fabric required. When fabric is later wired, these endpoints become
// authoritative fallback; the fabric layer takes precedence in the UI.

import (
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// presenceTTL is the duration after which a peer is considered offline.
const presenceTTL = 35 * time.Second

// presenceEntry holds the last-known state for one peer.
type presenceEntry struct {
	UserID      string    `json:"user_id"`
	DisplayName string    `json:"display_name"`
	Status      string    `json:"status"`
	StatusText  string    `json:"status_text"`
	LastSeen    time.Time `json:"last_seen"`
}

// presenceRegistry is the in-memory store for presence entries.
type presenceRegistry struct {
	mu      sync.RWMutex
	entries map[string]*presenceEntry
}

func newPresenceRegistry() *presenceRegistry {
	return &presenceRegistry{entries: make(map[string]*presenceEntry)}
}

// heartbeat upserts the entry for userID and resets LastSeen to now.
func (r *presenceRegistry) heartbeat(userID, displayName, status, statusText string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[userID]
	if !ok {
		e = &presenceEntry{UserID: userID}
		r.entries[userID] = e
	}
	if displayName != "" {
		e.DisplayName = displayName
	}
	if status != "" {
		e.Status = status
	} else if e.Status == "" {
		e.Status = "online"
	}
	e.StatusText = statusText
	e.LastSeen = time.Now().UTC()
}

// roster returns all entries that are within TTL, sorted by UserID.
func (r *presenceRegistry) roster() []presenceEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	cutoff := time.Now().UTC().Add(-presenceTTL)
	var out []presenceEntry
	for _, e := range r.entries {
		if e.LastSeen.After(cutoff) {
			out = append(out, *e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserID < out[j].UserID })
	return out
}

// globalPresenceRegistry is the process-wide singleton.
var globalPresenceRegistry = newPresenceRegistry()

// PresenceHandler exposes heartbeat and roster endpoints.
type PresenceHandler struct {
	reg *presenceRegistry
}

// NewPresenceHandler creates a PresenceHandler backed by the global registry.
func NewPresenceHandler() *PresenceHandler {
	return &PresenceHandler{reg: globalPresenceRegistry}
}

// Heartbeat handles POST /api/spaces/presence/heartbeat.
// Body: { status, status_text, display_name }
// Requires authentication (requesterID must be non-empty).
func (h *PresenceHandler) Heartbeat(c *gin.Context) {
	userID := requesterID(c)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return
	}
	var body struct {
		Status      string `json:"status"`
		StatusText  string `json:"status_text"`
		DisplayName string `json:"display_name"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Status == "" {
		body.Status = "online"
	}
	h.reg.heartbeat(userID, body.DisplayName, body.Status, body.StatusText)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Roster handles GET /api/spaces/presence/roster.
// Returns all presence entries within TTL.
func (h *PresenceHandler) Roster(c *gin.Context) {
	userID := requesterID(c)
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return
	}
	entries := h.reg.roster()
	if entries == nil {
		entries = []presenceEntry{}
	}
	c.JSON(http.StatusOK, entries)
}
