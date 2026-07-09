package signing

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
)

// GenerateShareLinkToken mints an opaque, unguessable credential for an
// anonymous read-only document share link.
//
// Unlike the Ed25519 signer tokens (which embed signed claims), a share-link
// token is a pure random capability: 32 bytes of cryptographic randomness,
// base64url-encoded WITHOUT padding so it is a single URL/path-safe segment
// (matching the storage layer's validID charset [A-Za-z0-9_-]). The token is
// the lookup key; the record it resolves to carries the file id, expiry,
// password hash, and revoked flag. Security therefore rests on the token being
// unguessable (256 bits of entropy) and revocable — NOT on it being unforgeable
// in the signature sense, because there is nothing to forge: an attacker cannot
// invent a token that maps to a stored record.
func GenerateShareLinkToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("signing: generate share-link token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
