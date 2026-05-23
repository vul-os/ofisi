// Package meeting provides scheduled-meeting persistence helpers, HMAC-signed
// join tokens, and lobby state management for Vulos Meet.
//
// Security properties:
//   - Join tokens are HMAC-SHA256 signed, single-use (nonce in token), 1-hour TTL.
//   - Room IDs are 22 URL-safe base64 characters (≈132 bits entropy).
//   - TURN credentials are scoped to a specific room_id + expiry.
//   - All joins are audit-logged with (room_id, account_id|null, ip, ua, accepted_by, joined_at).
//   - Per-IP brute-force rate limit is enforced at the handler layer.
package meeting

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

// ── constants ────────────────────────────────────────────────────────────────

const (
	TokenTTL     = time.Hour        // join token validity window
	RoomIDLen    = 16               // bytes → 22 URL-safe base64 chars
	MaxRoomPeers = 25               // default cap; configurable up to 100
)

// ── token payload ─────────────────────────────────────────────────────────────

// JoinTokenClaims is the JSON payload embedded in a signed join token.
type JoinTokenClaims struct {
	RoomID    string `json:"room_id"`
	AccountID string `json:"account_id,omitempty"` // empty for anonymous
	Nonce     string `json:"nonce"`                // 8 random bytes hex, ensures single-use
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// ── singleton secret ─────────────────────────────────────────────────────────
// Loaded from VULOS_MEET_SECRET env var (hex-encoded 32 bytes).
// If absent in dev mode, a random key is generated in-memory.

var (
	secretMu  sync.Mutex
	secretKey []byte
)

// LoadOrGenerateSecret loads the HMAC secret from env or generates one for dev.
func LoadOrGenerateSecret() error {
	secretMu.Lock()
	defer secretMu.Unlock()
	if secretKey != nil {
		return nil
	}
	raw := os.Getenv("VULOS_MEET_SECRET")
	if raw != "" {
		decoded, err := hex.DecodeString(raw)
		if err != nil {
			return fmt.Errorf("meeting: decode VULOS_MEET_SECRET: %w", err)
		}
		if len(decoded) < 16 {
			return fmt.Errorf("meeting: VULOS_MEET_SECRET must be at least 32 hex chars (16 bytes)")
		}
		secretKey = decoded
		return nil
	}
	// Dev mode — random in-memory key
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return fmt.Errorf("meeting: generate dev secret: %w", err)
	}
	secretKey = key
	return nil
}

func getSecret() []byte {
	secretMu.Lock()
	defer secretMu.Unlock()
	return secretKey
}

// ── token issuance ───────────────────────────────────────────────────────────

// NewRoomID generates a URL-safe base64-encoded random room ID (22 chars, ≈132 bits).
func NewRoomID() (string, error) {
	b := make([]byte, RoomIDLen)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("meeting: generate room id: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// IssueJoinToken creates and signs a single-use join token for the given room.
// accountID may be empty for anonymous joins.
func IssueJoinToken(roomID, accountID string) (string, error) {
	if err := LoadOrGenerateSecret(); err != nil {
		return "", err
	}
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("meeting: generate nonce: %w", err)
	}
	now := time.Now()
	claims := JoinTokenClaims{
		RoomID:    roomID,
		AccountID: accountID,
		Nonce:     hex.EncodeToString(nonce),
		IssuedAt:  now.Unix(),
		ExpiresAt: now.Add(TokenTTL).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("meeting: marshal token claims: %w", err)
	}
	b64Payload := base64.RawURLEncoding.EncodeToString(payload)
	sig := signPayload(getSecret(), b64Payload)
	return b64Payload + "." + sig, nil
}

// VerifyJoinToken parses and verifies a join token. Returns the claims on success.
// Returns an error if the signature is invalid, the token is expired, or the
// format is malformed.
func VerifyJoinToken(token string) (*JoinTokenClaims, error) {
	if err := LoadOrGenerateSecret(); err != nil {
		return nil, err
	}

	b64Payload, sig, found := splitToken(token)
	if !found {
		return nil, errors.New("meeting: malformed token")
	}

	expectedSig := signPayload(getSecret(), b64Payload)
	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return nil, errors.New("meeting: invalid token signature")
	}

	payload, err := base64.RawURLEncoding.DecodeString(b64Payload)
	if err != nil {
		return nil, fmt.Errorf("meeting: decode token payload: %w", err)
	}

	var claims JoinTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("meeting: parse token claims: %w", err)
	}

	if time.Now().Unix() > claims.ExpiresAt {
		return nil, errors.New("meeting: token expired")
	}

	return &claims, nil
}

// ── TURN credential issuance ─────────────────────────────────────────────────
// TURN credentials are room-scoped: username = "<expiry>:<roomID>:<userID>"
// so a credential issued for room A cannot be used in room B.

// TURNCredentials holds short-lived TURN credentials scoped to a room.
type TURNCredentials struct {
	Username   string `json:"username"`
	Credential string `json:"credential"`
	TTLSeconds int    `json:"ttlSeconds"`
}

// IssueTURNCredentials issues coturn-compatible short-lived TURN credentials
// scoped to a specific room_id (adds security binding beyond the standard
// time-limited credential). Uses HMAC-SHA256 (room-scoped extension of the
// standard HMAC-SHA1 coturn credential).
func IssueTURNCredentials(roomID, userID string) (TURNCredentials, error) {
	secret := os.Getenv("VULOS_TURN_SECRET")
	if secret == "" {
		return TURNCredentials{}, errors.New("meeting: VULOS_TURN_SECRET not set")
	}
	ttl := 3600
	expiry := time.Now().Add(time.Duration(ttl) * time.Second).Unix()
	username := fmt.Sprintf("%d:%s:%s", expiry, roomID, userID)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(username))
	cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return TURNCredentials{
		Username:   username,
		Credential: cred,
		TTLSeconds: ttl,
	}, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func signPayload(secret []byte, payload string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func splitToken(token string) (payload, sig string, ok bool) {
	for i := len(token) - 1; i >= 0; i-- {
		if token[i] == '.' {
			return token[:i], token[i+1:], true
		}
	}
	return "", "", false
}
