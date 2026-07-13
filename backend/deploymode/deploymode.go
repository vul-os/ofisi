// Package deploymode provides a single typed DEPLOY_MODE enum for Vulos Office,
// per the cross-repo "two-class app model" contract:
//
//	DEPLOY_MODE = standalone|os|cloud
//	Each app reads it once, validates coherent config, and self-reports at boot.
//	Unset => standalone.
//
// This mirrors the OS backend's vulos/backend/internal/deploymode package byte
// for byte in intent (office is a separate MIT repo, so it cannot import that
// module — the contract is duplicated, not shared code). The three values
// describe WHERE and HOW this Office binary is running:
//
//   - Standalone: a fully sovereign, self-hosted Office with no cloud control
//     plane and no OS gateway in front. Today's default behaviour — unchanged.
//     All features open; no billing/entitlement gating; blob I/O uses the local
//     process-wide object client (or a silent no-op when none is configured).
//   - OS: Office running as an app BEHIND a Vulos OS box gateway. The gateway
//     injects per-request scoped X-Vulos-Storage-* headers (STS-scoped, gated by
//     VULOS_STORAGE_BROKER_SECRET) so Office never holds full-bucket creds, and
//     it may broker identity/entitlements via a CP. Storage isolation is the
//     gateway-header seam.
//   - Cloud: the multi-tenant cloud-hosted deployment (Office served at
//     office.vulos.org behind the CP front door). Tigris has no STS, so Office
//     MUST NOT hold raw bucket credentials; instead it requests a short-lived,
//     per-object PRESIGNED URL from the gateway's POST /api/storage/presign
//     endpoint (app_id="office"). See backend/storage/presign.go.
package deploymode

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// Mode is the typed DEPLOY_MODE value.
type Mode string

const (
	// Standalone is the fully sovereign self-host default (DEPLOY_MODE unset).
	Standalone Mode = "standalone"
	// OS is Office running behind a Vulos OS box gateway (scoped-header seam).
	OS Mode = "os"
	// Cloud is the multi-tenant cloud deployment (presign seam; no raw creds).
	Cloud Mode = "cloud"
)

// EnvVar is the environment variable name read by FromEnv.
const EnvVar = "DEPLOY_MODE"

// Valid reports whether m is one of the three recognised values.
func (m Mode) Valid() bool {
	switch m {
	case Standalone, OS, Cloud:
		return true
	default:
		return false
	}
}

// IsCloudAdjacent reports whether CP-brokered features (entitlement gating,
// vk_ keys, cloud login) should be treated as ACTIVE for this mode: true for
// both OS and Cloud, false for Standalone.
func (m Mode) IsCloudAdjacent() bool {
	return m == OS || m == Cloud
}

// UsesPresignStorage reports whether blob I/O must go through the per-object
// presign seam (cloud, where Tigris has no STS) rather than the gateway-injected
// scoped-header seam (os) or the process-wide client (standalone).
func (m Mode) UsesPresignStorage() bool {
	return m == Cloud
}

// String implements fmt.Stringer.
func (m Mode) String() string { return string(m) }

// FromEnv reads DEPLOY_MODE once, validating it. An unset value returns
// (Standalone, nil) — today's default behaviour unchanged. An explicit but
// unrecognised value returns (Standalone, err): the caller should log the error
// and continue in the safe (Standalone/fully-open) default rather than fail to
// boot over a typo.
func FromEnv() (Mode, error) {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(EnvVar)))
	if raw == "" {
		return Standalone, nil
	}
	m := Mode(raw)
	if !m.Valid() {
		return Standalone, fmt.Errorf("deploymode: invalid %s=%q (want %q, %q, or %q) — falling back to %q",
			EnvVar, raw, Standalone, OS, Cloud, Standalone)
	}
	return m, nil
}

// Load resolves DEPLOY_MODE via FromEnv, logs any validation problem, runs a
// light coherence check appropriate to the resolved mode, and self-reports at
// boot. An unrecognised DEPLOY_MODE value never fails the boot — it degrades to
// the safe Standalone default. However a resolved CLOUD mode with no presign
// storage seam configured (validateCloud) IS a hard boot gate: Tigris has no
// STS, so a cloud process with no presign path would otherwise silently fall
// back to holding raw, suite-wide bucket credentials in a multi-tenant process
// (see validateCloud). We fail closed (log.Fatalf) rather than boot into that
// posture.
func Load() Mode {
	m, err := FromEnv()
	if err != nil {
		log.Printf("[deploymode] %v", err)
	}
	if verr := m.validateCloud(); verr != nil {
		log.Fatalf("[deploymode] %v", verr)
	}
	m.checkCoherence()
	log.Printf("[deploymode] running as %q (%s=%q)", m, EnvVar, os.Getenv(EnvVar))
	return m
}

// validateCloud is the hard (fatal) gate for cloud mode: it returns a non-nil
// error when DEPLOY_MODE=cloud but no presign storage seam is configured.
// Standalone and OS are never affected — this is a pure function so the check
// itself is unit-testable without exercising the log.Fatalf call site in Load.
func (m Mode) validateCloud() error {
	if m != Cloud {
		return nil
	}
	presignURL := strings.TrimSpace(os.Getenv(EnvPresignURL))
	if presignURL == "" {
		return fmt.Errorf("DEPLOY_MODE=cloud requires %s (cloud has no per-tenant bucket "+
			"credentials to fall back to; without the presign seam Office would otherwise hold "+
			"raw, suite-wide bucket credentials in a multi-tenant process). Set it to the OS "+
			"gateway base URL (e.g. https://app.vulos.org), or use DEPLOY_MODE=os/standalone",
			EnvPresignURL)
	}
	return nil
}

// RequireAuthPosture is the multi-tenant boot gate (fail-closed). A hosted /
// cloud-adjacent deployment (DEPLOY_MODE=os or =cloud) MUST come up with an
// authenticated posture: EITHER native product-JWT auth (authEnabled) OR a
// wired session introspector (hasIntrospector — IDENTITY_URL set). This mirrors
// the EXACT condition the protected/write route groups use to install their auth
// middleware (cfg.Auth.Enabled || sessionIntrospector != nil): when neither is
// present those groups install NO auth middleware, so every caller collapses to
// the single shared "self" identity — a silent multi-tenant fail-OPEN where all
// tenants' data lands under one identity and any create/upload is anonymous.
//
// It returns a non-nil error naming the missing config when a hosted mode would
// otherwise boot with no auth wall; the caller (Load / main) turns that into a
// fatal so the process REFUSES TO BOOT rather than come up fully open.
// Standalone single-tenant self-host is unaffected — it may legitimately run
// without the auth wall — so this is a pure no-op there. Kept a pure function so
// the decision is unit-testable without exercising the fatal call site.
func (m Mode) RequireAuthPosture(authEnabled, hasIntrospector bool) error {
	if !m.IsCloudAdjacent() {
		return nil
	}
	if authEnabled || hasIntrospector {
		return nil
	}
	return fmt.Errorf("DEPLOY_MODE=%s is a hosted, multi-tenant deployment but NO auth wall is "+
		"configured: native auth is disabled (auth.enabled=false) AND no session introspector is "+
		"wired (%s is unset). Booting would install no auth middleware on the protected/write API, "+
		"collapsing every caller to a single shared identity (all tenants' data under one identity, "+
		"any create/upload anonymous). Refusing to boot. Set auth.enabled=true (with %s), or set %s "+
		"to the identity provider base URL, or use DEPLOY_MODE=standalone for single-tenant self-host",
		m, session_EnvIdentityURL, "VULOS_OFFICE_JWT_SECRET", session_EnvIdentityURL)
}

// session_EnvIdentityURL names the session-introspection provider env var in
// this package's error text WITHOUT importing backend/session (deploymode
// imports nothing from the rest of office, by design). Kept in sync with
// session.EnvIdentityURL.
const session_EnvIdentityURL = "IDENTITY_URL"

// checkCoherence logs (non-fatal) warnings when the resolved mode's config looks
// incomplete, so an operator notices a half-configured os box early rather than
// discovering a silent fail-open/fail-closed surprise later. The cloud+no-presign
// case is NOT handled here — it is a hard boot gate, see validateCloud.
func (m Mode) checkCoherence() {
	cp := strings.TrimSpace(os.Getenv("VULOS_CP_BASE_URL"))
	brokerSecret := strings.TrimSpace(os.Getenv("VULOS_STORAGE_BROKER_SECRET"))

	switch m {
	case OS:
		if brokerSecret == "" {
			log.Printf("[deploymode] WARNING: DEPLOY_MODE=os but VULOS_STORAGE_BROKER_SECRET is unset — " +
				"gateway-injected X-Vulos-Storage-* headers will NOT be trusted, so per-user " +
				"scoped storage is inactive (Office falls back to its process-wide object client).")
		}
	case Standalone:
		if cp != "" {
			log.Printf("[deploymode] NOTE: DEPLOY_MODE=standalone (or unset) with VULOS_CP_BASE_URL set — " +
				"vk_ API-key auth is active, but entitlement gating stays OPEN because this box is standalone " +
				"(set DEPLOY_MODE=os or DEPLOY_MODE=cloud to enforce it).")
		}
	}
}

// EnvPresignURL is the base URL of the OS gateway that exposes
// POST /api/storage/presign. Consumed by the cloud storage path (see
// backend/storage/presign.go). Defined here so checkCoherence can warn on a
// half-configured cloud deployment.
const EnvPresignURL = "VULOS_STORAGE_PRESIGN_URL"
