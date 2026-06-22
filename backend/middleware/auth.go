package middleware

import (
	"net/http"
	"strings"

	"vulos-office/backend/config"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Context keys set by Auth so downstream handlers can read the verified
// identity. Handlers must read the user/account id from context — never from
// the client-supplied X-Account-ID header.
const (
	CtxAuthenticated = "authenticated"
	CtxUserID        = "userID"   // verified account id from the JWT subject
	CtxIsAdmin       = "isAdmin"  // true if the JWT carries the admin scope
)

// Auth validates the session JWT, and on success sets the verified identity
// (CtxUserID) into the gin context from the token's Subject claim.
//
// When auth is disabled (cfg.Auth.Enabled == false) the request proceeds, but
// CtxUserID is left empty and CtxAuthenticated is false; handlers fall back to
// a safe "local single-user" identity in that mode.
func Auth(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !cfg.Auth.Enabled {
			c.Next()
			return
		}

		token := extractToken(c)
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
			return
		}

		secret, err := JWTSecret()
		if err != nil {
			// Fail closed: no usable signing secret → reject all tokens.
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "server auth not configured"})
			return
		}

		claims := &jwt.RegisteredClaims{}
		parsed, perr := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
			// Pin the signing method to HMAC to reject alg-confusion attacks.
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrTokenSignatureInvalid
			}
			return secret, nil
		})

		if perr != nil || !parsed.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired session"})
			return
		}

		c.Set(CtxAuthenticated, true)
		// Derive identity from the verified token, NOT from any client header.
		c.Set(CtxUserID, claims.Subject)
		// Admin scope is conveyed via the "vulos:admin" audience entry.
		for _, aud := range claims.Audience {
			if aud == "vulos:admin" {
				c.Set(CtxIsAdmin, true)
				break
			}
		}
		c.Next()
	}
}

func extractToken(c *gin.Context) string {
	// Check Authorization header
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	// Check cookie
	if cookie, err := c.Cookie("session"); err == nil {
		return cookie
	}
	// NOTE: the ?token= query-param path was intentionally REMOVED. JWTs in the
	// URL leak into server/proxy access logs, browser history, and Referer
	// headers, so the session token is accepted only via the Authorization
	// header or the HttpOnly session cookie.
	return ""
}
