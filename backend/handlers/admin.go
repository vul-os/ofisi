package handlers

// admin.go — admin-only endpoints for invite-token management and the audit
// log viewer.
//
// Authorization: every route here is mounted on the protected group AND
// additionally requires the admin scope (middleware.CtxIsAdmin, set from the
// "vulos:admin" JWT audience). A non-admin caller receives 403. This keeps
// invite minting and audit reads off the surface of ordinary users.

import (
	"net/http"
	"os"
	"sync"
	"time"

	"vulos-office/backend/audit"
	"vulos-office/backend/invites"
	"vulos-office/backend/middleware"

	"github.com/gin-gonic/gin"
)

// ---- shared process-wide stores ---------------------------------------------

func inviteDBPath() string {
	if v := os.Getenv("VULOS_INVITES_DB"); v != "" {
		return v
	}
	return "./data/invites.db"
}

func auditDBPath() string {
	if v := os.Getenv("VULOS_AUDIT_DB"); v != "" {
		return v
	}
	return "./data/audit.db"
}

var (
	defaultInviteStore invites.Store
	inviteStoreOnce    sync.Once
	defaultAuditStore  audit.Store
	auditStoreOnce     sync.Once
)

// SharedInviteStore returns a process-wide invite store backed by durable
// SQLite, falling back to in-memory (degraded) if the DB cannot be opened.
func SharedInviteStore() invites.Store {
	inviteStoreOnce.Do(func() {
		if st, err := invites.NewSQLiteStore(inviteDBPath()); err == nil {
			defaultInviteStore = st
		} else {
			defaultInviteStore = invites.NewNullStore()
		}
	})
	return defaultInviteStore
}

// SharedAuditStore returns a process-wide append-only audit store backed by
// durable SQLite, falling back to in-memory (degraded) if it cannot be opened.
func SharedAuditStore() audit.Store {
	auditStoreOnce.Do(func() {
		if st, err := audit.NewSQLiteStore(auditDBPath()); err == nil {
			defaultAuditStore = st
		} else {
			defaultAuditStore = audit.NewNullStore()
		}
	})
	return defaultAuditStore
}

// recordAudit is a fire-and-forget helper used across handlers. A nil store or
// a write error never blocks the primary operation.
func recordAudit(st audit.Store, actor string, action audit.Action, target, detail string) {
	if st == nil {
		return
	}
	_ = st.Append(audit.Entry{Actor: actor, Action: action, Target: target, Detail: detail})
}

// ---- AdminHandler -----------------------------------------------------------

type AdminHandler struct {
	invites invites.Store
	audit   audit.Store
}

func NewAdminHandler() *AdminHandler {
	return &AdminHandler{invites: SharedInviteStore(), audit: SharedAuditStore()}
}

// NewAdminHandlerWith builds a handler over caller-supplied stores (tests).
func NewAdminHandlerWith(inv invites.Store, aud audit.Store) *AdminHandler {
	return &AdminHandler{invites: inv, audit: aud}
}

// requireAdmin enforces the admin scope; writes 403 and returns false otherwise.
func requireAdmin(c *gin.Context) bool {
	if c.GetBool(middleware.CtxIsAdmin) {
		return true
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "admin privileges required"})
	return false
}

// MintInvite POST /api/admin/invites
//
//	body: { "note": "alice@vulos.org", "max_uses": 1, "ttl_hours": 168 }
//
// Returns the RAW token exactly once (never stored). max_uses<=0 → single use;
// ttl_hours<=0 → never expires.
func (h *AdminHandler) MintInvite(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	var req struct {
		Note     string `json:"note"`
		MaxUses  int    `json:"max_uses"`
		TTLHours int    `json:"ttl_hours"`
	}
	_ = c.ShouldBindJSON(&req)
	ttl := time.Duration(req.TTLHours) * time.Hour
	actor := requesterID(c)
	raw, inv, err := h.invites.Mint(actor, req.Note, req.MaxUses, ttl)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	recordAudit(h.audit, actor, audit.ActionInviteMint, inv.ID, "note="+req.Note)
	// token is the ONLY time the raw secret is returned.
	c.JSON(http.StatusCreated, gin.H{"token": raw, "invite": inv})
}

// ListInvites GET /api/admin/invites — metadata only (never the raw token).
func (h *AdminHandler) ListInvites(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	list, err := h.invites.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if list == nil {
		list = []invites.Invite{}
	}
	c.JSON(http.StatusOK, list)
}

// RevokeInvite DELETE /api/admin/invites/:id
func (h *AdminHandler) RevokeInvite(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	id := c.Param("id")
	if err := h.invites.Revoke(id); err != nil {
		if err == invites.ErrNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "invite not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	recordAudit(h.audit, requesterID(c), audit.ActionInviteRevoke, id, "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ListAudit GET /api/admin/audit?limit=N — append-only log, newest first.
func (h *AdminHandler) ListAudit(c *gin.Context) {
	if !requireAdmin(c) {
		return
	}
	limit := parseLimit(c.Query("limit"), 200)
	entries, err := h.audit.List(limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if entries == nil {
		entries = []audit.Entry{}
	}
	c.JSON(http.StatusOK, entries)
}

func parseLimit(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return def
		}
		n = n*10 + int(r-'0')
		if n > 5000 {
			return 5000
		}
	}
	if n == 0 {
		return def
	}
	return n
}
