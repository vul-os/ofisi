package seam

import (
	"context"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// testSecret returns a fixed HS256 secret with no env / cloud dependency.
func testSecret() ([]byte, error) { return []byte("standalone-test-secret"), nil }

func mintToken(t *testing.T, secret []byte, subject string, admin bool) string {
	t.Helper()
	claims := jwt.RegisteredClaims{
		Subject:   subject,
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
	}
	if admin {
		claims.Audience = jwt.ClaimStrings{AdminAudience}
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString(secret)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// Standalone identity must work with NO cloud env: auth-disabled mode yields a
// usable "self" identity regardless of token.
func TestLocalIdentity_AuthDisabled_NoCloud(t *testing.T) {
	id := NewLocalIdentity(testSecret, false /* enabled */)
	if id.AuthEnabled() {
		t.Fatal("expected auth disabled")
	}
	got, err := id.Authenticate(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.AccountID != "self" || got.Authenticated {
		t.Fatalf("want self/unauthenticated, got %+v", got)
	}
}

func TestLocalIdentity_ValidToken(t *testing.T) {
	secret, _ := testSecret()
	id := NewLocalIdentity(testSecret, true)
	tok := mintToken(t, secret, "alice@example.com", false)

	got, err := id.Authenticate(context.Background(), tok)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.AccountID != "alice@example.com" || !got.Authenticated || got.IsAdmin {
		t.Fatalf("unexpected identity: %+v", got)
	}
}

func TestLocalIdentity_AdminAudience(t *testing.T) {
	secret, _ := testSecret()
	id := NewLocalIdentity(testSecret, true)
	tok := mintToken(t, secret, "root@example.com", true)

	got, err := id.Authenticate(context.Background(), tok)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.IsAdmin {
		t.Fatalf("expected admin scope, got %+v", got)
	}
}

func TestLocalIdentity_InvalidToken(t *testing.T) {
	id := NewLocalIdentity(testSecret, true)
	if _, err := id.Authenticate(context.Background(), "not-a-jwt"); err == nil {
		t.Fatal("expected error for invalid token")
	}
}

func TestLocalIdentity_WrongSecret(t *testing.T) {
	other := mintToken(t, []byte("a-different-secret"), "mallory", false)
	id := NewLocalIdentity(testSecret, true)
	if _, err := id.Authenticate(context.Background(), other); err == nil {
		t.Fatal("expected error for token signed with a different secret")
	}
}

func TestLocalIdentity_MissingTokenWhenEnabled(t *testing.T) {
	// A missing credential is not an error at the seam; the route layer decides.
	id := NewLocalIdentity(testSecret, true)
	got, err := id.Authenticate(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.AccountID != "self" || got.Authenticated {
		t.Fatalf("want unauthenticated self, got %+v", got)
	}
}

// Standalone entitlements must be permissive/unlimited by default.
func TestLocalEntitlements_UnlimitedByDefault(t *testing.T) {
	ent := NewLocalEntitlements(DefaultEntitlement())
	got, err := ent.For(context.Background(), "anyone")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Unlimited() {
		t.Fatalf("expected unlimited entitlement, got %+v", got)
	}
	if got.Tier != "self-hosted" {
		t.Fatalf("expected self-hosted tier, got %q", got.Tier)
	}
	if !ent.Allowed(context.Background(), "anyone", "signing") {
		t.Fatal("expected all features allowed by default")
	}
}

func TestLocalEntitlements_ExplicitFeatureDisable(t *testing.T) {
	ent := NewLocalEntitlements(Entitlement{
		Features: map[string]bool{"signing": false},
	})
	if ent.Allowed(context.Background(), "x", "signing") {
		t.Fatal("expected signing disabled")
	}
	// Absent key still defaults to allowed (generous-by-default).
	if !ent.Allowed(context.Background(), "x", "office") {
		t.Fatal("expected absent feature to default allowed")
	}
}

func TestNoopUsage_DoesNotPanic(t *testing.T) {
	u := NewNoopUsage()
	u.Report(context.Background(), UsageEvent{AccountID: "a", Kind: "file.create", Value: 1})
}

// The standalone provider must wire with no cloud configuration.
func TestNewStandaloneProvider(t *testing.T) {
	p := NewStandaloneProvider(testSecret, false)
	if p.Identity == nil || p.Entitlements == nil || p.Usage == nil {
		t.Fatal("standalone provider must populate all three seams")
	}
	if p.Identity.AuthEnabled() {
		t.Fatal("expected auth disabled in single-user mode")
	}
}
