package handlers

import (
	"crypto/subtle"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"vulos-office/backend/audit"
	"vulos-office/backend/config"
	"vulos-office/backend/invites"
	"vulos-office/backend/middleware"
	"vulos-office/backend/models"
	"vulos-office/backend/userauth"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

type attemptRecord struct {
	count      int
	lockedUntil time.Time
}

type AuthHandler struct {
	cfg      *config.Config
	mu       sync.Mutex
	attempts map[string]*attemptRecord
	// creds is the per-user credential store. When it holds registered users,
	// login verifies against it and the JWT subject is bound to the
	// authenticated account (no longer self-asserted by the client).
	creds userauth.Store
	// invites mints/consumes single-use registration invite tokens (additive to
	// the static VULOS_OFFICE_REGISTRATION_TOKEN + admin-JWT paths).
	invites invites.Store
	// audit records registration / invite-consume events (append-only).
	audit audit.Store
}

// userAuthDBPath resolves the credential SQLite DSN from env.
func userAuthDBPath() string {
	if v := os.Getenv("VULOS_USERAUTH_DB"); v != "" {
		return v
	}
	return "./data/userauth.db"
}

func NewAuthHandler(cfg *config.Config) *AuthHandler {
	var creds userauth.Store
	if st, err := userauth.NewSQLiteStore(userAuthDBPath()); err == nil {
		creds = st
	} else {
		log.Printf("auth: per-user credential store unavailable (%v); falling back to in-memory store", err)
		creds = userauth.NewNullStore()
	}
	return &AuthHandler{
		cfg:      cfg,
		attempts: make(map[string]*attemptRecord),
		creds:    creds,
		invites:  SharedInviteStore(),
		audit:    SharedAuditStore(),
	}
}

// NewAuthHandlerWithCreds builds a handler over a caller-supplied credential
// store (tests use an in-memory NullStore). Invite + audit stores default to
// in-memory NullStores; use NewAuthHandlerWithStores to inject them.
func NewAuthHandlerWithCreds(cfg *config.Config, creds userauth.Store) *AuthHandler {
	return &AuthHandler{
		cfg:      cfg,
		attempts: make(map[string]*attemptRecord),
		creds:    creds,
		invites:  invites.NewNullStore(),
		audit:    audit.NewNullStore(),
	}
}

// NewAuthHandlerWithStores builds a handler over caller-supplied credential,
// invite, and audit stores (tests).
func NewAuthHandlerWithStores(cfg *config.Config, creds userauth.Store, inv invites.Store, aud audit.Store) *AuthHandler {
	return &AuthHandler{
		cfg:      cfg,
		attempts: make(map[string]*attemptRecord),
		creds:    creds,
		invites:  inv,
		audit:    aud,
	}
}

func (h *AuthHandler) Status(c *gin.Context) {
	authenticated := false
	if h.cfg.Auth.Enabled {
		token := c.GetHeader("Authorization")
		if len(token) > 7 {
			token = token[7:]
		}
		if token == "" {
			if cookie, err := c.Cookie("session"); err == nil {
				token = cookie
			}
		}
		if token != "" {
			if secret, serr := middleware.JWTSecret(); serr == nil {
				claims := &jwt.RegisteredClaims{}
				parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
					if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
						return nil, jwt.ErrTokenSignatureInvalid
					}
					return secret, nil
				})
				authenticated = err == nil && parsed.Valid
			}
		}
	} else {
		authenticated = true
	}

	c.JSON(http.StatusOK, models.AuthStatusResponse{
		Enabled:       h.cfg.Auth.Enabled,
		Authenticated: authenticated,
	})
}

func (h *AuthHandler) Login(c *gin.Context) {
	if !h.cfg.Auth.Enabled {
		c.JSON(http.StatusOK, models.LoginResponse{Message: "auth not required"})
		return
	}

	ip := c.ClientIP()

	h.mu.Lock()
	rec, ok := h.attempts[ip]
	if !ok {
		rec = &attemptRecord{}
		h.attempts[ip] = rec
	}

	// Check lockout
	if time.Now().Before(rec.lockedUntil) {
		h.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, models.ErrorResponse{
			Error:       "account locked",
			LockedUntil: rec.lockedUntil.Format(time.RFC3339),
		})
		return
	}
	h.mu.Unlock()

	var req models.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: "invalid request"})
		return
	}

	// Determine the verified subject for the JWT.
	//
	//   - If any per-user credentials are registered, login MUST authenticate
	//     against the credential store and the subject becomes the *canonical*
	//     account id returned by Verify — never the client-supplied AccountID.
	//   - Otherwise (no users registered) fall back to the legacy shared-password
	//     path for OSS single-user / local mode. In that mode the subject is the
	//     supplied AccountID (or "self"), which is acceptable because there is no
	//     multi-user store to protect.
	subject := req.AccountID
	authOK := false
	hasUsers := false
	if h.creds != nil {
		if hu, err := h.creds.HasUsers(); err == nil {
			hasUsers = hu
		}
	}
	if hasUsers {
		if canonical, err := h.creds.Verify(req.AccountID, req.Password); err == nil {
			subject = canonical
			authOK = true
		}
	} else {
		// Shared-password fallback (legacy single-user mode).
		authOK = req.Password == h.cfg.Auth.Password
		if subject == "" {
			subject = "self"
		}
	}

	if !authOK {
		h.mu.Lock()
		rec.count++
		remaining := h.cfg.Auth.MaxAttempts - rec.count
		if remaining <= 0 {
			rec.lockedUntil = time.Now().Add(time.Duration(h.cfg.Auth.LockoutMinutes) * time.Minute)
			rec.count = 0
			remaining = 0
		}
		h.mu.Unlock()

		status := http.StatusUnauthorized
		if remaining == 0 {
			status = http.StatusTooManyRequests
		}
		c.JSON(status, models.ErrorResponse{
			Error:             "incorrect password",
			RemainingAttempts: remaining,
		})
		return
	}

	// Success — reset attempts
	h.mu.Lock()
	rec.count = 0
	rec.lockedUntil = time.Time{}
	h.mu.Unlock()

	expiry := time.Duration(h.cfg.Auth.SessionHours) * time.Hour
	if expiry == 0 {
		expiry = 24 * time.Hour
	}

	secret, serr := middleware.JWTSecret()
	if serr != nil {
		c.JSON(http.StatusServiceUnavailable, models.ErrorResponse{Error: "server auth not configured"})
		return
	}

	claims := jwt.RegisteredClaims{
		// Subject carries the VERIFIED account id (from the credential store when
		// per-user auth is active, otherwise the shared-mode subject). Downstream
		// handlers read it from context instead of trusting any client header,
		// and it is no longer self-asserted when real credentials exist.
		Subject:   subject,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(expiry)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(secret)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{Error: "failed to create session"})
		return
	}

	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "session",
		Value:    signed,
		MaxAge:   int(expiry.Seconds()),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// Secure should be true in production (HTTPS). Set via env/config if needed.
	})
	// Return only a success message — never expose the token in the response body
	// so JavaScript cannot read it.
	c.JSON(http.StatusOK, models.LoginResponse{Message: "logged in"})
}

// EnvRegistrationToken is the env var holding the registration/invite token. It
// gates registration once the instance is bootstrapped (≥1 user) so a stranger
// cannot register new accounts on a running multi-user instance. The token is
// supplied by the client via the X-Registration-Token header.
const EnvRegistrationToken = "VULOS_OFFICE_REGISTRATION_TOKEN"

// reservedPrivilegedID reports whether accountID looks like a privileged /
// system identity that must NOT be self-registered by an unauthenticated or
// non-admin caller (e.g. admin@, root@, the bare "self"/"system" handles, or any
// "admin"/"root" local-part). This blocks the "register admin@vulos.org while
// HasUsers==false" privilege grab — only the holder of the registration token
// may claim such an id.
func reservedPrivilegedID(accountID string) bool {
	id := strings.ToLower(strings.TrimSpace(accountID))
	if id == "" {
		return false
	}
	if id == "self" || id == "system" || id == "admin" || id == "root" {
		return true
	}
	local := id
	if at := strings.Index(id, "@"); at >= 0 {
		local = id[:at]
	}
	switch local {
	case "admin", "administrator", "root", "superuser", "system", "postmaster", "security":
		return true
	}
	return false
}

// passwordPolicyError returns a non-empty reason when pw fails the minimal
// password policy: ≥10 chars and at least two distinct character classes
// (lower / upper / digit / symbol). Rejects trivially weak passwords like
// "password" or "12345678" without being onerous for a self-host operator.
func passwordPolicyError(pw string) string {
	if len(pw) < 10 {
		return "password must be at least 10 characters"
	}
	var hasLower, hasUpper, hasDigit, hasSymbol bool
	for _, r := range pw {
		switch {
		case r >= 'a' && r <= 'z':
			hasLower = true
		case r >= 'A' && r <= 'Z':
			hasUpper = true
		case r >= '0' && r <= '9':
			hasDigit = true
		default:
			hasSymbol = true
		}
	}
	classes := 0
	for _, ok := range []bool{hasLower, hasUpper, hasDigit, hasSymbol} {
		if ok {
			classes++
		}
	}
	if classes < 2 {
		return "password must mix at least two of: lowercase, uppercase, digits, symbols"
	}
	return ""
}

// registrationTokenOK reports whether the request carries the configured
// registration/invite token. Returns (configured, valid):
//   - configured=false → no token is set in the environment (registration on a
//     bootstrapped instance is then closed entirely; only first-user bootstrap
//     is allowed).
//   - valid=true → the supplied X-Registration-Token matched (constant-time).
func registrationTokenOK(c *gin.Context) (configured, valid bool) {
	want := strings.TrimSpace(os.Getenv(EnvRegistrationToken))
	if want == "" {
		return false, false
	}
	got := strings.TrimSpace(c.GetHeader("X-Registration-Token"))
	if got == "" {
		return true, false
	}
	return true, subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// requestIsAdmin validates an optional session JWT on the request and reports
// whether it carries the "vulos:admin" audience. Used by Register (which is
// mounted unauthenticated) so an admin can provision accounts even though the
// route did not pass through middleware.Auth. Mirrors the verification in
// middleware.Auth (HMAC pinned to reject alg-confusion).
func (h *AuthHandler) requestIsAdmin(c *gin.Context) bool {
	token := c.GetHeader("Authorization")
	if strings.HasPrefix(token, "Bearer ") {
		token = strings.TrimPrefix(token, "Bearer ")
	} else if cookie, err := c.Cookie("session"); err == nil {
		token = cookie
	} else {
		return false
	}
	if token == "" {
		return false
	}
	secret, err := middleware.JWTSecret()
	if err != nil {
		return false
	}
	claims := &jwt.RegisteredClaims{}
	parsed, perr := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrTokenSignatureInvalid
		}
		return secret, nil
	})
	if perr != nil || !parsed.Valid {
		return false
	}
	for _, aud := range claims.Audience {
		if aud == "vulos:admin" {
			return true
		}
	}
	return false
}

// Register creates a per-user credential (account id + bcrypt password hash).
//
//	POST /api/auth/register  { "account_id": "alice@vulos.org", "password": "..." }
//	  (optional header) X-Registration-Token: <invite/admin token>
//
// Gating (closes the unauthenticated-registration + first-user TOCTOU +
// arbitrary-privileged-id holes):
//
//   - FIRST USER (atomic bootstrap): when the credential store is empty the very
//     first registration is allowed without a token via the store's atomic
//     RegisterFirst (a transaction-guarded count-then-insert), so two concurrent
//     callers cannot both win the bootstrap. A reserved/privileged id
//     (admin@, root@, …) still requires the registration token even as the first
//     user, so the first account is a normal user unless the operator opts in.
//
//   - BOOTSTRAPPED INSTANCE (≥1 user): registration REQUIRES the configured
//     registration/invite token (X-Registration-Token, validated constant-time).
//     If no token is configured, registration is CLOSED on a running instance —
//     a stranger can no longer self-register. An admin JWT also satisfies the
//     gate (an admin may provision accounts).
//
//   - Password policy is enforced for every registration.
func (h *AuthHandler) Register(c *gin.Context) {
	if !h.cfg.Auth.Enabled {
		c.JSON(http.StatusOK, models.LoginResponse{Message: "auth not required"})
		return
	}
	if h.creds == nil {
		c.JSON(http.StatusServiceUnavailable, models.ErrorResponse{Error: "credential store unavailable"})
		return
	}
	var req models.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: "invalid request"})
		return
	}
	if strings.TrimSpace(req.AccountID) == "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: "account_id required"})
		return
	}
	if reason := passwordPolicyError(req.Password); reason != "" {
		c.JSON(http.StatusBadRequest, models.ErrorResponse{Error: reason})
		return
	}

	hasUsers := false
	if hu, err := h.creds.HasUsers(); err == nil {
		hasUsers = hu
	}

	// Token / admin authorization signal. Register is mounted on the
	// UNauthenticated route group (so the first user can bootstrap without a
	// token), therefore the admin scope is not present in context — detect it by
	// validating an optional admin JWT on the request directly.
	tokenConfigured, tokenValid := registrationTokenOK(c)
	isAdmin := c.GetBool(middleware.CtxIsAdmin) || h.requestIsAdmin(c)

	// Invite-token path (additive to the static token + admin JWT). The same
	// X-Registration-Token header may carry a single-use/expiring invite minted
	// by an admin. We only VALIDATE here (no consume yet) so a token is burned
	// only once the account is actually created below.
	headerTok := strings.TrimSpace(c.GetHeader("X-Registration-Token"))
	inviteValid := false
	if !tokenValid && !isAdmin && headerTok != "" && h.invites != nil {
		if _, err := h.invites.Valid(headerTok); err == nil {
			inviteValid = true
		}
	}

	authorized := tokenValid || isAdmin || inviteValid

	// consumeInvite burns the invite token after a successful create and records
	// it in the audit log. A no-op unless this registration was authorized by an
	// invite (not by the static token / admin).
	consumeInvite := func(accountID string) {
		if !inviteValid {
			return
		}
		if inv, err := h.invites.Consume(headerTok); err == nil {
			recordAudit(h.audit, accountID, audit.ActionInviteConsume, inv.ID, "account="+accountID)
		}
	}

	// A privileged/system id may only be claimed by an authorized caller (token
	// or admin) — never by anonymous self-registration, even as the first user.
	if reservedPrivilegedID(req.AccountID) && !authorized {
		c.JSON(http.StatusForbidden, models.ErrorResponse{Error: "this account id is reserved"})
		return
	}

	if !hasUsers && !authorized {
		// Unauthenticated FIRST-user bootstrap — atomic so the TOCTOU race is
		// closed. If another caller bootstrapped in the meantime, RegisterFirst
		// returns ErrNotFirstUser and we fall through to the gated requirement.
		switch err := h.creds.RegisterFirst(req.AccountID, req.Password); err {
		case nil:
			recordAudit(h.audit, req.AccountID, audit.ActionRegister, req.AccountID, "first-user bootstrap")
			c.JSON(http.StatusCreated, models.LoginResponse{Message: "registered"})
			return
		case userauth.ErrUserExists:
			c.JSON(http.StatusConflict, models.ErrorResponse{Error: "account already registered"})
			return
		case userauth.ErrNotFirstUser:
			// Lost the bootstrap race — now bootstrapped; require a token below.
		default:
			c.JSON(http.StatusInternalServerError, models.ErrorResponse{Error: "failed to register"})
			return
		}
	}

	// Bootstrapped instance: require an authorized caller.
	if !authorized {
		if !tokenConfigured {
			// No registration token configured → registration is closed.
			c.JSON(http.StatusForbidden, models.ErrorResponse{Error: "registration is closed; an invite token is required"})
			return
		}
		c.JSON(http.StatusUnauthorized, models.ErrorResponse{Error: "valid registration token required"})
		return
	}

	switch err := h.creds.Register(req.AccountID, req.Password); err {
	case nil:
		consumeInvite(req.AccountID)
		via := "static-token-or-admin"
		if inviteValid {
			via = "invite-token"
		}
		recordAudit(h.audit, req.AccountID, audit.ActionRegister, req.AccountID, "via="+via)
		c.JSON(http.StatusCreated, models.LoginResponse{Message: "registered"})
	case userauth.ErrUserExists:
		c.JSON(http.StatusConflict, models.ErrorResponse{Error: "account already registered"})
	default:
		c.JSON(http.StatusInternalServerError, models.ErrorResponse{Error: "failed to register"})
	}
}

func (h *AuthHandler) Logout(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     "session",
		Value:    "",
		MaxAge:   -1,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	c.JSON(http.StatusOK, gin.H{"message": "logged out"})
}
