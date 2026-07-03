package signing

// crypto_key_internal_test.go — WAVE32 coverage. Internal test (package signing)
// so it can reset the package key globals and exercise the env-sourced key
// branches of LoadOrGenerateKey (32-byte seed, 64-byte full key, invalid
// length, bad base64) plus PublicKeyBase64 — none of which the external
// signing_test package can reach once a key is already loaded.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

// resetKey clears the package key material so a test can drive
// LoadOrGenerateKey from a known-empty state. Guarded by the same mutex the
// production code uses.
func resetKey() {
	mu.Lock()
	privateKey = nil
	publicKey = nil
	mu.Unlock()
}

func TestPublicKeyBase64_UninitialisedErrors(t *testing.T) {
	resetKey()
	defer resetKey()
	if _, err := PublicKeyBase64(); err == nil {
		t.Fatal("PublicKeyBase64 before init should error")
	}
}

func TestLoadOrGenerateKey_DevGenerate(t *testing.T) {
	resetKey()
	defer resetKey()
	t.Setenv("SIGNING_PRIVATE_KEY", "")
	if err := LoadOrGenerateKey(); err != nil {
		t.Fatalf("dev generate: %v", err)
	}
	pub, err := PublicKeyBase64()
	if err != nil {
		t.Fatalf("PublicKeyBase64: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(pub)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		t.Fatalf("generated public key wrong shape: len=%d err=%v", len(raw), err)
	}
	// Idempotent: a second call must NOT regenerate (same key).
	if err := LoadOrGenerateKey(); err != nil {
		t.Fatalf("second LoadOrGenerateKey: %v", err)
	}
	if pub2, _ := PublicKeyBase64(); pub2 != pub {
		t.Error("LoadOrGenerateKey not idempotent: key changed on second call")
	}
}

func TestLoadOrGenerateKey_FromSeed32(t *testing.T) {
	resetKey()
	defer resetKey()
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	t.Setenv("SIGNING_PRIVATE_KEY", base64.StdEncoding.EncodeToString(seed))
	if err := LoadOrGenerateKey(); err != nil {
		t.Fatalf("load from 32-byte seed: %v", err)
	}
	// Public key must match the one derived from the seed directly.
	want := base64.StdEncoding.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	if got, _ := PublicKeyBase64(); got != want {
		t.Errorf("seed-derived public key = %q; want %q", got, want)
	}
}

func TestLoadOrGenerateKey_FromFull64(t *testing.T) {
	resetKey()
	defer resetKey()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	t.Setenv("SIGNING_PRIVATE_KEY", base64.StdEncoding.EncodeToString(priv))
	if err := LoadOrGenerateKey(); err != nil {
		t.Fatalf("load from 64-byte key: %v", err)
	}
	want := base64.StdEncoding.EncodeToString(pub)
	if got, _ := PublicKeyBase64(); got != want {
		t.Errorf("full-key public key mismatch: got %q want %q", got, want)
	}
}

func TestLoadOrGenerateKey_InvalidLength(t *testing.T) {
	resetKey()
	defer resetKey()
	t.Setenv("SIGNING_PRIVATE_KEY", base64.StdEncoding.EncodeToString([]byte("too-short")))
	if err := LoadOrGenerateKey(); err == nil {
		t.Fatal("wrong-length key should error")
	}
}

func TestLoadOrGenerateKey_BadBase64(t *testing.T) {
	resetKey()
	defer resetKey()
	t.Setenv("SIGNING_PRIVATE_KEY", "!!!not-base64!!!")
	if err := LoadOrGenerateKey(); err == nil {
		t.Fatal("invalid base64 key should error")
	}
}
