package handlers

// system.go — standalone, server-honest system surface for the self-hosted
// Settings/Admin UI.
//
//   GET  /api/system/info     runtime facts: version, storage backend, auth
//                             mode, registered-user count, integration mode,
//                             and the caller's identity / admin status.
//   POST /api/auth/password   authenticated self-service password change. Works
//                             against the per-user credential store; in legacy
//                             shared-password mode it returns an honest error
//                             pointing at config.yaml (no silent no-op).
//
// Everything reported here is derived from the live config + stores, never
// hardcoded, so a self-hoster sees what their instance is ACTUALLY doing.

import (
	"net/http"

	"vulos-office/backend/config"
	"vulos-office/backend/middleware"
	"vulos-office/backend/storage"
	"vulos-office/backend/userauth"

	"github.com/gin-gonic/gin"
)

type SystemHandler struct {
	cfg     *config.Config
	version string
	// mode is the integration mode resolved at startup ("standalone" | "cloud").
	mode  string
	creds userauth.Store
}

func NewSystemHandler(cfg *config.Config, version, mode string) *SystemHandler {
	return &SystemHandler{cfg: cfg, version: version, mode: mode, creds: SharedCredsStore()}
}

// authMode classifies how login is enforced for this instance.
//   - "disabled"  auth.enabled is false (single-user / local mode)
//   - "per-user"  per-user credentials are registered (the modern path)
//   - "shared"    auth on, but only the legacy shared config.yaml password exists
func (h *SystemHandler) authMode() (mode string, userCount int64) {
	if !h.cfg.Auth.Enabled {
		return "disabled", 0
	}
	if h.creds != nil {
		if n, err := h.creds.CountUsers(); err == nil {
			userCount = n
			if n > 0 {
				return "per-user", n
			}
		}
	}
	return "shared", userCount
}

// Info GET /api/system/info
func (h *SystemHandler) Info(c *gin.Context) {
	mode, userCount := h.authMode()

	c.JSON(http.StatusOK, gin.H{
		"version":          h.version,
		"integration_mode": h.mode, // "standalone" | "cloud"
		"account_id":       requesterID(c),
		"is_admin":         c.GetBool(middleware.CtxIsAdmin),
		"auth": gin.H{
			"enabled":    h.cfg.Auth.Enabled,
			"mode":       mode,
			"user_count": userCount,
		},
		"storage": gin.H{
			"backend":      h.cfg.Storage.Type, // "local" | "postgres"
			"data_dir":     h.cfg.Server.DataDir,
			"uploads_dir":  h.cfg.Server.UploadsDir,
			"object_store": storage.DescribeObjectStore(),
		},
	})
}

// ChangePassword POST /api/auth/password
//
//	body: { "current_password": "...", "new_password": "..." }
//
// Authenticated self-service: the session proves identity, and the current
// password is re-verified before the change (so a hijacked-but-idle session
// cannot silently rotate the credential). Per-user store only; shared-password
// mode is reported honestly rather than pretending to succeed.
func (h *SystemHandler) ChangePassword(c *gin.Context) {
	if !h.cfg.Auth.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "authentication is disabled; this instance does not use passwords (set auth.enabled: true in config.yaml)",
		})
		return
	}

	var req struct {
		// Accept both "current_password"/"new_password" and the legacy single
		// "password" field so older clients degrade gracefully.
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
		Password        string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	newPw := req.NewPassword
	if newPw == "" {
		newPw = req.Password
	}

	if h.creds == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "credential store unavailable"})
		return
	}
	hasUsers, err := h.creds.HasUsers()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "cannot determine credential state; try again"})
		return
	}
	if !hasUsers {
		// Legacy shared-password mode — there is no per-user credential to update.
		c.JSON(http.StatusConflict, gin.H{
			"error": "this instance uses the shared password from config.yaml (auth.password). " +
				"Change it there and restart, or register a per-user account to enable self-service password changes.",
		})
		return
	}

	subject := requesterID(c)
	if subject == "" || subject == "self" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "no authenticated account for this session"})
		return
	}

	// Re-verify the current password before allowing the change.
	if _, verr := h.creds.Verify(subject, req.CurrentPassword); verr != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "current password is incorrect"})
		return
	}
	if reason := passwordPolicyError(newPw); reason != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": reason})
		return
	}

	switch err := h.creds.UpdatePassword(subject, newPw); err {
	case nil:
		recordAudit(SharedAuditStore(), subject, "auth.password_change", subject, "self-service")
		c.JSON(http.StatusOK, gin.H{"message": "password updated"})
	case userauth.ErrUserNotFound:
		c.JSON(http.StatusNotFound, gin.H{"error": "account not found"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update password"})
	}
}
