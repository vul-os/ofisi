// presign.go — CLOUD storage seam (two-class app model, PRESIGN path).
//
// In CLOUD mode (DEPLOY_MODE=cloud) Office runs multi-tenant against Tigris,
// which has NO STS AssumeRole surface. The header-injection seam (seam_client.go)
// therefore cannot hand Office prefix-scoped credentials, and the contract is
// explicit that Office must NEVER hold raw AccessKey/Secret in cloud mode.
//
// Instead Office asks the OS gateway to mint a short-lived, OBJECT-scoped
// presigned URL per object and performs the blob I/O against THAT URL:
//
//	POST {VULOS_STORAGE_PRESIGN_URL}/api/storage/presign
//	  Cookie: vc_session=<the end-user's session>   (forwarded from the request
//	          Office is currently serving — the gateway validates it and derives
//	          the userID itself, so Office cannot presign for another user)
//	  Body:   {"app_id":"office","method":"GET"|"PUT","key":"file/<id>"}
//	  200:    storage.ObjectGrant {type,method,bucket,key,url|creds,expires_at}
//
// The caller-supplied "key" is RELATIVE to Office's own namespace; the gateway
// composes the full object key "<userID>/office/<key>" itself, so Office can
// never name an object outside its own per-user/per-app prefix. Office holds
// only the resulting short-lived presigned URL (or, if the gateway is on a
// store WITH STS, a per-OBJECT-scoped short-lived cred — still never a
// full-bucket cred), matching the "never hold raw bucket creds in cloud" rule.
//
// DELETE has no presign surface (an S3 presigned URL signs a single method, and
// Office must never hold a bucket-wide DELETE credential), so it uses a
// separate, server-MEDIATED endpoint instead of a minted grant:
//
//	POST {VULOS_STORAGE_PRESIGN_URL}/api/storage/delete
//	  Cookie: vc_session=<the end-user's session>   (forwarded, same as above)
//	  Body:   {"app_id":"office","key":"file/<id>"}
//	  204:    deleted (or already absent — idempotent)
//
// The gateway itself performs the delete server-side after composing
// "<userID>/office/<key>" and validating the session, so Office never touches
// the object store directly for this call either.
//
// A gateway that answers type="local" (standalone gateway, no object store) is
// treated as "no cloud blob store": Office falls back to its own local/SQLite
// document store, so the presign path degrades safely.
package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// EnvPresignURL is the base URL of the OS gateway exposing /api/storage/presign.
// Kept in sync with backend/deploymode.EnvPresignURL (duplicated rather than
// imported to avoid a storage→deploymode dependency cycle at the composition
// root).
const EnvPresignURL = "VULOS_STORAGE_PRESIGN_URL"

// PresignAppID is the app_id Office presents to the gateway presign endpoint.
// The gateway pins the composed key to "<userID>/<app_id>/…", so this string is
// the ONLY prefix Office can ever reach — it can never smuggle another app's id.
const PresignAppID = "office"

// presignGrantType mirrors the OS gateway's storage.GrantType wire values.
type presignGrantType string

const (
	grantPresigned presignGrantType = "presigned"
	grantSTS       presignGrantType = "sts"
	grantLocal     presignGrantType = "local"
)

// objectGrant mirrors the OS gateway's storage.ObjectGrant JSON shape. Only the
// fields Office consumes are modelled.
type objectGrant struct {
	Type      presignGrantType `json:"type"`
	Method    string           `json:"method"`
	Bucket    string           `json:"bucket"`
	Key       string           `json:"key"`
	URL       string           `json:"url,omitempty"`
	Endpoint  string           `json:"endpoint,omitempty"`
	Region    string           `json:"region,omitempty"`
	Creds     scopedCreds      `json:"creds,omitempty"`
	LocalPath string           `json:"local_path,omitempty"`
	ExpiresAt time.Time        `json:"expires_at"`
}

// scopedCreds mirrors the gateway's storage.ScopedCreds (object-scoped, short
// lived — the same trust level as the header-seam creds; NEVER a full-bucket
// long-lived credential).
type scopedCreds struct {
	AccessKey    string `json:"AccessKey"`
	SecretKey    string `json:"SecretKey"`
	SessionToken string `json:"SessionToken"`
}

// PresignClient talks to the OS gateway's /api/storage/presign endpoint and
// performs object I/O against the minted grants. It is safe for concurrent use.
type PresignClient struct {
	baseURL string
	http    *http.Client
}

// NewPresignClient builds a PresignClient from a gateway base URL. Returns nil
// when baseURL is empty so callers can detect "presign not configured" and fall
// back to the standalone client.
func NewPresignClient(baseURL string) *PresignClient {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	return &PresignClient{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

// PresignClientFromEnv builds a PresignClient from VULOS_STORAGE_PRESIGN_URL, or
// nil when it is unset.
func PresignClientFromEnv() *PresignClient {
	return NewPresignClient(os.Getenv(EnvPresignURL))
}

// mintGrant requests a presigned grant for (method, relKey), forwarding the
// end-user's session cookie so the gateway derives the userID and composes the
// "<userID>/office/<relKey>" object key itself.
func (p *PresignClient) mintGrant(ctx context.Context, sessionCookie, method, relKey string) (objectGrant, error) {
	body, _ := json.Marshal(map[string]string{
		"app_id": PresignAppID,
		"method": method,
		"key":    relKey,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/api/storage/presign", bytes.NewReader(body))
	if err != nil {
		return objectGrant{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if sessionCookie != "" {
		// Forward ONLY the vc_session cookie — the gateway authenticates the
		// presign request as the end-user (never Office itself), so Office can
		// never mint a grant for a user other than the one it is serving.
		req.AddCookie(&http.Cookie{Name: "vc_session", Value: sessionCookie})
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return objectGrant{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return objectGrant{}, fmt.Errorf("storage: presign %s %q: gateway status %d", method, relKey, resp.StatusCode)
	}
	var g objectGrant
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&g); err != nil {
		return objectGrant{}, fmt.Errorf("storage: presign decode: %w", err)
	}
	return g, nil
}

// Put uploads data for relKey via a minted PUT grant. Returns (false, nil) when
// the gateway has no object store (type="local") so the caller can treat the
// local/SQLite store as authoritative.
func (p *PresignClient) Put(ctx context.Context, sessionCookie, relKey string, data []byte, contentType string) (stored bool, err error) {
	g, err := p.mintGrant(ctx, sessionCookie, http.MethodPut, relKey)
	if err != nil {
		return false, err
	}
	switch g.Type {
	case grantLocal:
		return false, nil // gateway has no object store — caller uses local store
	case grantPresigned:
		return true, p.putURL(ctx, g.URL, data, contentType)
	case grantSTS:
		cl, key, cerr := clientFromGrant(g)
		if cerr != nil {
			return false, cerr
		}
		return true, cl.Put(key, data) // grant.Key is the full object key
	default:
		return false, fmt.Errorf("storage: presign put: unknown grant type %q", g.Type)
	}
}

// Get downloads relKey via a minted GET grant. Returns (nil, false, nil) when
// the gateway has no object store (type="local").
func (p *PresignClient) Get(ctx context.Context, sessionCookie, relKey string) (data []byte, stored bool, err error) {
	g, err := p.mintGrant(ctx, sessionCookie, http.MethodGet, relKey)
	if err != nil {
		return nil, false, err
	}
	switch g.Type {
	case grantLocal:
		return nil, false, nil
	case grantPresigned:
		b, gerr := p.getURL(ctx, g.URL)
		return b, true, gerr
	case grantSTS:
		cl, key, cerr := clientFromGrant(g)
		if cerr != nil {
			return nil, false, cerr
		}
		rc, gerr := cl.Get(key)
		if gerr != nil {
			return nil, true, gerr
		}
		defer rc.Close()
		b, rerr := io.ReadAll(rc)
		return b, true, rerr
	default:
		return nil, false, fmt.Errorf("storage: presign get: unknown grant type %q", g.Type)
	}
}

// Delete removes relKey via the gateway's server-mediated delete endpoint.
// Unlike Put/Get there is no presigned-URL grant to mint (S3 presigned URLs
// sign a single method, and Office must never hold a bucket-wide DELETE
// credential): the gateway itself performs the delete after composing
// "<userID>/office/<relKey>" from the forwarded session and validating that
// Office may only reach its own app prefix. A 404 from the gateway is treated
// as success (idempotent — "already gone"), matching OfficeS3Client.Delete.
func (p *PresignClient) Delete(ctx context.Context, sessionCookie, relKey string) error {
	body, _ := json.Marshal(map[string]string{
		"app_id": PresignAppID,
		"key":    relKey,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/api/storage/delete", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if sessionCookie != "" {
		// Forward ONLY the vc_session cookie, exactly as mintGrant does — the
		// gateway authenticates the delete as the end-user and scopes it to
		// "<userID>/office/…", so Office can never delete another user's (or
		// another app's) object.
		req.AddCookie(&http.Cookie{Name: "vc_session", Value: sessionCookie})
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("storage: presign delete %q: %w", relKey, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil // idempotent — already absent
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("storage: presign delete %q: gateway status %d", relKey, resp.StatusCode)
	}
	return nil
}

// putURL performs a raw HTTP PUT against a presigned URL (the URL carries its own
// SigV4 signature, so no credentials are attached here).
func (p *PresignClient) putURL(ctx context.Context, url string, data []byte, contentType string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("storage: presigned PUT: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("storage: presigned PUT: status %d", resp.StatusCode)
	}
	return nil
}

// getURL performs a raw HTTP GET against a presigned URL. A 404 returns
// (nil, nil) — "no object", not an error — matching BucketStore.GetObject.
func (p *PresignClient) getURL(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("storage: presigned GET: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("storage: presigned GET: status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 128<<20))
}

// clientFromGrant builds a single-object OfficeS3Client from an STS grant and
// returns it alongside the full object key to address. The client is built with
// an EMPTY prefix so the returned key is used verbatim (the grant's Key is
// already the full composed "<userID>/office/…" object key). These credentials
// are OBJECT-scoped and short-lived (never full-bucket), so this stays within
// the "no raw bucket creds" contract.
func clientFromGrant(g objectGrant) (*OfficeS3Client, string, error) {
	if g.Endpoint == "" || g.Bucket == "" || g.Key == "" {
		return nil, "", fmt.Errorf("storage: sts grant missing endpoint/bucket/key")
	}
	region := g.Region
	if region == "" {
		region = "auto"
	}
	cl := &OfficeS3Client{
		endpoint:        strings.TrimSuffix(g.Endpoint, "/"),
		region:          region,
		bucket:          g.Bucket,
		prefix:          "",
		accessKeyID:     g.Creds.AccessKey,
		secretAccessKey: g.Creds.SecretKey,
		sessionToken:    g.Creds.SessionToken,
		httpClient:      http.DefaultClient,
	}
	return cl, g.Key, nil
}

// SanitizePresignRelKey normalises an Office object name into a safe RELATIVE
// key for the presign request: it strips backslashes/NUL and any ".." segment so
// the caller can never traverse out of Office's gateway-composed prefix. It
// preserves forward-slash subpaths ("file/<id>", "seal/<id>.pdf"), which the
// gateway's own sanitizer also permits.
func SanitizePresignRelKey(name string) string {
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "\x00", "")
	name = strings.TrimLeft(name, "/")
	segs := strings.Split(name, "/")
	out := segs[:0]
	for _, s := range segs {
		if s == "" || s == "." || s == ".." {
			continue
		}
		out = append(out, s)
	}
	return strings.Join(out, "/")
}
