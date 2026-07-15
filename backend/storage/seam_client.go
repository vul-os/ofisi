// seam_client.go — UNIFIED-STORAGE-01: per-request object-store client built
// from the credentials the Vulos OS gateway injects on every request.
//
// When Office runs behind the OS gateway, each request carries a set of
// X-Vulos-Storage-* headers describing a short-lived, per-user S3 endpoint +
// bucket + prefix (a slice of the shared per-user bucket). Office must scope its
// blob writes to THAT bucket/prefix instead of the process-wide org client, and
// it must do so per-request because the credentials are per-user and rotate.
//
// This file owns the storage-package side: turning the injected values into an
// *OfficeS3Client whose prefix namespaces all office objects under
// "<injected-prefix>/office". The handlers package reads the headers off the
// request and calls SeamS3Client; when no endpoint is injected it falls back to
// the existing OrgBucketClient()/no-op behavior.
package storage

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"sync"
)

// SeamObjectNamespace is the key sub-space office claims inside the injected
// per-user prefix. All office blobs land under "<prefix>/office/...".
const SeamObjectNamespace = "office"

// SeamBrokerSecretEnv gates the whole injected-seam path. The OS gateway is
// configured with the same secret and presents it on every proxied request as
// the X-Vulos-Storage-Broker-Auth header. When this env var is empty the seam
// headers are NEVER trusted (standalone behaviour), mirroring lilmail's
// LILMAIL_BROKER_SECRET mail-broker gate.
const SeamBrokerSecretEnv = "VULOS_STORAGE_BROKER_SECRET"

// SeamStorageConfig is the per-request storage seam, populated from the
// X-Vulos-Storage-* request headers injected by the OS gateway. An empty
// Endpoint means the seam is absent (not running behind the gateway) and the
// caller must fall back to the process-wide client.
type SeamStorageConfig struct {
	Endpoint     string // X-Vulos-Storage-Endpoint (S3 base URL)
	Bucket       string // X-Vulos-Storage-Bucket
	Prefix       string // X-Vulos-Storage-Prefix (per-user space)
	Region       string // X-Vulos-Storage-Region
	AccessKey    string // X-Vulos-Storage-Access-Key
	SecretKey    string // X-Vulos-Storage-Secret-Key
	SessionToken string // X-Vulos-Storage-Session-Token (optional, STS temp creds)
	BrokerAuth   string // X-Vulos-Storage-Broker-Auth (shared secret proving the
	// request came from the trusted OS gateway; gates the whole seam path)
}

// Present reports whether the seam was injected on this request.
func (c SeamStorageConfig) Present() bool {
	return strings.TrimSpace(c.Endpoint) != ""
}

// Trusted reports whether the injected seam headers may be honored. On their own
// the X-Vulos-Storage-* headers are spoofable by any client that can reach
// Office, so they are trusted ONLY when:
//
//  1. the env SeamBrokerSecretEnv is configured (we are deployed behind the OS
//     gateway), AND
//  2. the request's X-Vulos-Storage-Broker-Auth header matches that secret via a
//     constant-time compare.
//
// When either condition fails, callers MUST ignore every seam header and fall
// back to the standalone OrgBucketClient()/no-op path. This mirrors lilmail's
// mail-broker secret gate (handlers/jsonapi/broker.go).
func (c SeamStorageConfig) Trusted() bool {
	if !c.Present() {
		return false
	}
	secret := strings.TrimSpace(os.Getenv(SeamBrokerSecretEnv))
	if secret == "" {
		return false // gate disabled — never trust injected headers
	}
	presented := strings.TrimSpace(c.BrokerAuth)
	if presented == "" {
		return false
	}
	// Compare fixed-width sha256 digests rather than the raw secrets: a direct
	// ConstantTimeCompare over the raw bytes short-circuits on a length mismatch,
	// leaking the configured secret's byte-length as a timing side-channel.
	// Hashing both sides to 32 bytes first removes that leak (correct secret
	// still accepted, wrong still rejected). Mirrors sibling Talk's broker gate.
	ph := sha256.Sum256([]byte(presented))
	sh := sha256.Sum256([]byte(secret))
	return subtle.ConstantTimeCompare(ph[:], sh[:]) == 1
}

// officePrefix returns the key prefix under which office namespaces its blobs:
// "<injected-prefix>/office" (or just "office" when no prefix was injected).
func (c SeamStorageConfig) officePrefix() string {
	p := strings.Trim(strings.TrimSpace(c.Prefix), "/")
	if p == "" {
		return SeamObjectNamespace
	}
	return p + "/" + SeamObjectNamespace
}

// fingerprint is a stable hash of the credential material + scope so equivalent
// requests reuse one cached client instead of rebuilding the struct each time.
func (c SeamStorageConfig) fingerprint() string {
	h := sha256.New()
	for _, s := range []string{
		c.Endpoint, c.Bucket, c.officePrefix(), c.Region,
		c.AccessKey, c.SecretKey, c.SessionToken,
	} {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

var (
	seamClientCacheMu sync.Mutex
	seamClientCache   = map[string]*OfficeS3Client{}
)

// seamClientCacheCap bounds the per-process cache so rotating temp credentials
// cannot grow it without limit. When exceeded the cache is dropped wholesale —
// clients are cheap to rebuild, so a periodic flush is acceptable.
const seamClientCacheCap = 256

// SeamS3Client builds (or returns a cached) S3 client scoped to the injected
// per-request bucket/credentials, with office blobs namespaced under
// "<prefix>/office". It returns (nil, nil) when the seam is absent so callers
// can fall back to the process-wide client. The returned client is safe for
// concurrent use (it only wraps immutable config + the shared http client).
func SeamS3Client(cfg SeamStorageConfig) (*OfficeS3Client, error) {
	if !cfg.Present() {
		return nil, nil
	}

	// Endpoint safety (M1): reject arbitrary external http:// endpoints even
	// though we deliberately bypass the BYO-MinIO https-only Validate() for
	// gateway-supplied URLs. https is always fine; http only for on-box hosts.
	if err := ValidateSeamEndpoint(cfg.Endpoint); err != nil {
		return nil, err
	}

	fp := cfg.fingerprint()
	seamClientCacheMu.Lock()
	defer seamClientCacheMu.Unlock()
	if cl, ok := seamClientCache[fp]; ok {
		return cl, nil
	}

	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "auto"
	}

	// Build the struct directly (not via NewOfficeS3Client): the gateway may
	// inject an on-box http MinIO endpoint, so we can't impose the BYO-MinIO
	// "https only" Validate(); instead the endpoint passed ValidateSeamEndpoint
	// above (https, or http only for loopback/private hosts).
	client := &OfficeS3Client{
		endpoint:        strings.TrimSuffix(strings.TrimSpace(cfg.Endpoint), "/"),
		region:          region,
		bucket:          strings.TrimSpace(cfg.Bucket),
		prefix:          cfg.officePrefix(),
		accessKeyID:     strings.TrimSpace(cfg.AccessKey),
		secretAccessKey: cfg.SecretKey,
		sessionToken:    strings.TrimSpace(cfg.SessionToken),
		httpClient:      http.DefaultClient,
	}

	if len(seamClientCache) >= seamClientCacheCap {
		seamClientCache = map[string]*OfficeS3Client{}
	}
	seamClientCache[fp] = client
	return client, nil
}
