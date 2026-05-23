package meeting

import (
	"sync"
	"time"
)

// LobbyState persists in-memory lobby state for a meeting room.
// On server restart lobby state is cleared; this is acceptable because the
// organizer must be present to admit participants anyway.
//
// Security: all lobby state changes are gated by the join token claim — the
// organizer receives a token with their accountID, lobby entrants have a token
// with their accountID/IP. Only the organizer may call Admit/Deny.

// WaitingEntry is a participant waiting in the lobby.
type WaitingEntry struct {
	Nonce       string    `json:"nonce"`         // from join token — ties lobby slot to a specific request
	AccountID   string    `json:"account_id"`    // empty for anonymous
	DisplayName string    `json:"display_name"`
	Email       string    `json:"email,omitempty"`
	IP          string    `json:"ip"`
	UserAgent   string    `json:"user_agent"`
	ArrivedAt   time.Time `json:"arrived_at"`
}

// LobbyManager manages lobby state across all rooms.
type LobbyManager struct {
	mu      sync.RWMutex
	waiting map[string][]*WaitingEntry // roomID → ordered queue
	denied  map[string]map[string]bool // roomID → set of denied nonces
}

var defaultLobby = &LobbyManager{
	waiting: make(map[string][]*WaitingEntry),
	denied:  make(map[string]map[string]bool),
}

// Default returns the process-wide LobbyManager.
func Default() *LobbyManager { return defaultLobby }

// Enter adds a participant to the waiting queue. Idempotent on nonce.
func (lm *LobbyManager) Enter(roomID string, e *WaitingEntry) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	for _, existing := range lm.waiting[roomID] {
		if existing.Nonce == e.Nonce {
			return // already waiting
		}
	}
	lm.waiting[roomID] = append(lm.waiting[roomID], e)
}

// List returns all waiting entries for a room (copy).
func (lm *LobbyManager) List(roomID string) []*WaitingEntry {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	src := lm.waiting[roomID]
	out := make([]*WaitingEntry, len(src))
	copy(out, src)
	return out
}

// Admit removes a participant from the waiting queue and returns true if found.
func (lm *LobbyManager) Admit(roomID, nonce string) bool {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	q := lm.waiting[roomID]
	for i, e := range q {
		if e.Nonce == nonce {
			lm.waiting[roomID] = append(q[:i], q[i+1:]...)
			return true
		}
	}
	return false
}

// AdmitAll removes all waiting entries for a room.
func (lm *LobbyManager) AdmitAll(roomID string) []*WaitingEntry {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	admitted := lm.waiting[roomID]
	lm.waiting[roomID] = nil
	return admitted
}

// Deny removes and blacklists a participant by nonce.
func (lm *LobbyManager) Deny(roomID, nonce string) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	q := lm.waiting[roomID]
	for i, e := range q {
		if e.Nonce == nonce {
			lm.waiting[roomID] = append(q[:i], q[i+1:]...)
			break
		}
	}
	if lm.denied[roomID] == nil {
		lm.denied[roomID] = make(map[string]bool)
	}
	lm.denied[roomID][nonce] = true
}

// IsDenied checks whether a nonce was previously denied.
func (lm *LobbyManager) IsDenied(roomID, nonce string) bool {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	return lm.denied[roomID] != nil && lm.denied[roomID][nonce]
}
