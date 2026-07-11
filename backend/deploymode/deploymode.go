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
// boot. It never fails the boot — DEPLOY_MODE is advisory config, not a hard
// gate; callers that need hard gating (e.g. storage isolation) enforce that
// separately and explicitly.
func Load() Mode {
	m, err := FromEnv()
	if err != nil {
		log.Printf("[deploymode] %v", err)
	}
	m.checkCoherence()
	log.Printf("[deploymode] running as %q (%s=%q)", m, EnvVar, os.Getenv(EnvVar))
	return m
}

// checkCoherence logs (non-fatal) warnings when the resolved mode's config looks
// incomplete, so an operator notices a half-configured cloud/os box early rather
// than discovering a silent fail-open/fail-closed surprise later.
func (m Mode) checkCoherence() {
	cp := strings.TrimSpace(os.Getenv("VULOS_CP_BASE_URL"))
	brokerSecret := strings.TrimSpace(os.Getenv("VULOS_STORAGE_BROKER_SECRET"))
	presignURL := strings.TrimSpace(os.Getenv(EnvPresignURL))

	switch m {
	case Cloud:
		if presignURL == "" {
			log.Printf("[deploymode] WARNING: DEPLOY_MODE=cloud but %s is unset — "+
				"Office cannot mint per-object presigned URLs and blob writes will "+
				"fall back to the local object client (or no-op). Set it to the OS "+
				"gateway base URL (e.g. https://app.vulos.org).", EnvPresignURL)
		}
	case OS:
		if brokerSecret == "" {
			log.Printf("[deploymode] WARNING: DEPLOY_MODE=os but VULOS_STORAGE_BROKER_SECRET is unset — "+
				"gateway-injected X-Vulos-Storage-* headers will NOT be trusted, so per-user "+
				"scoped storage is inactive (Office falls back to its process-wide object client).")
		}
	case Standalone:
		if cp != "" {
			log.Printf("[deploymode] NOTE: DEPLOY_MODE=standalone (or unset) with VULOS_CP_BASE_URL set — "+
				"vk_ API-key auth is active, but entitlement gating stays OPEN because this box is standalone "+
				"(set DEPLOY_MODE=os or DEPLOY_MODE=cloud to enforce it).")
		}
	}
}

// EnvPresignURL is the base URL of the OS gateway that exposes
// POST /api/storage/presign. Consumed by the cloud storage path (see
// backend/storage/presign.go). Defined here so checkCoherence can warn on a
// half-configured cloud deployment.
const EnvPresignURL = "VULOS_STORAGE_PRESIGN_URL"
