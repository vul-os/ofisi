package handlers

import (
	"vulos-office/backend/middleware"

	"github.com/gin-gonic/gin"
)

// requesterID returns the verified account id for the current request.
//
// Identity is derived from the JWT subject (set by middleware.Auth into the
// request context) — NOT from the client-supplied X-Account-ID header, which
// is forgeable. The header is honored only as an *admin impersonation* hint:
// an authenticated admin may act on behalf of another account by sending
// X-Account-ID. For everyone else the header is ignored.
//
// When auth is disabled (single-user / OSS self-host local mode) there is no
// token; we fall back to the local "self" identity so the app keeps working.
func requesterID(c *gin.Context) string {
	uid := c.GetString(middleware.CtxUserID)

	// Admin override: only a verified admin may impersonate via the header.
	if c.GetBool(middleware.CtxIsAdmin) {
		if hdr := c.GetHeader("X-Account-ID"); hdr != "" {
			return hdr
		}
	}

	if uid != "" {
		return uid
	}

	// Auth disabled or no subject in token: local single-user identity.
	// (Never read X-Account-ID here — that would re-open the forgery hole.)
	if c.GetBool(middleware.CtxAuthenticated) {
		// Authenticated session but token had no subject — treat as the shared
		// local account rather than honoring a forgeable header.
		return "self"
	}
	return "self"
}
