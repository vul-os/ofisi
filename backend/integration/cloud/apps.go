package cloud

// apps.go is the OPTIONAL vulos-cloud control-plane registry for the shared
// Apps & Bots platform. It implements appsplatform.Registry by brokering every
// operation to the control plane over HTTP, so installs/tokens/secrets are
// org-scoped and centrally audited rather than living in each box's local
// SQLite.
//
// Open-core discipline (identical to the rest of this package):
//
//   - The office CORE never imports this. Only the composition root (main.go)
//     references it, and only when the cloud apps registry is explicitly
//     enabled via env (AppsRegistryEnabled). The default is the in-tree
//     appsplatform.NewStandaloneRegistry (pure-Go SQLite).
//   - Deleting this file/package must never break the standalone build; the data
//     plane (handler set, dispatcher, signing) depends only on the
//     appsplatform.Registry interface.
//
// The control-plane contract mirrors the platform's own management surface
// (the seam doc: "the cloud implements the SAME interface"), under {cp}/api/apps,
// authenticated with the shared X-Relay-Auth service token. Internal lookups the
// data plane needs (by token hash, by incoming-webhook id) return the FULL app
// record including secrets so outbound events can still be signed.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/vul-os/vulos-apps/appsplatform"
)

// EnvAppsControlPlane, when truthy ("1"/"true") AND a control-plane base URL is
// configured (EnvCPBaseURL), routes the Apps & Bots registry to the cloud
// control plane instead of local SQLite. Absent → standalone default.
const EnvAppsControlPlane = "VULOS_APPS_CONTROL_PLANE"

// AppsRegistryEnabled reports whether the cloud apps registry should be wired.
// It requires BOTH a control-plane base URL (so we know where to broker) and the
// explicit opt-in flag, so merely enabling cloud entitlements never silently
// moves app installs off the local box.
func AppsRegistryEnabled() bool {
	if !Enabled() {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvAppsControlPlane))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// appsRegistry is the HTTP broker to the control-plane apps surface.
type appsRegistry struct {
	cfg  Config
	http *http.Client
}

var _ appsplatform.Registry = (*appsRegistry)(nil)

// NewAppsRegistry builds a control-plane-backed appsplatform.Registry. Callers
// gate construction behind AppsRegistryEnabled.
func NewAppsRegistry(cfg Config) (appsplatform.Registry, error) {
	if cfg.BaseURL == "" {
		return nil, errors.New("cloud: apps registry requires a control-plane base URL")
	}
	return &appsRegistry{cfg: cfg, http: &http.Client{Timeout: 5 * time.Second}}, nil
}

// wireApp is the on-the-wire app record. It embeds the platform App (whose
// secret fields are json:"-") and re-adds the secrets under explicit keys so the
// control plane can hand back the signing secret / token hash the data plane
// needs.
type wireApp struct {
	appsplatform.App
	TokenHashWire     string `json:"token_hash"`
	SigningSecretWire string `json:"signing_secret"`
}

func (w *wireApp) toApp() *appsplatform.App {
	a := w.App
	a.TokenHash = w.TokenHashWire
	a.SigningSecret = w.SigningSecretWire
	return &a
}

// do performs an authenticated JSON round-trip to {cp}{path}. A 404 maps to
// appsplatform.ErrNotFound; out (when non-nil) receives the decoded body.
func (r *appsRegistry) do(method, path string, in, out any) error {
	var body *bytes.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	} else {
		body = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, r.cfg.BaseURL+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.cfg.Token != "" {
		req.Header.Set(HeaderRelayAuth, r.cfg.Token)
	}
	if r.cfg.OrgID != "" {
		req.Header.Set("X-Org-ID", r.cfg.OrgID)
	}
	resp, err := r.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return appsplatform.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("cloud apps registry: %s %s → status %d", method, path, resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (r *appsRegistry) Create(p appsplatform.CreateParams) (*appsplatform.Created, error) {
	var resp struct {
		App           wireApp `json:"app"`
		Token         string  `json:"token"`
		SigningSecret string  `json:"signing_secret"`
	}
	if err := r.do(http.MethodPost, "/api/apps", p, &resp); err != nil {
		return nil, err
	}
	return &appsplatform.Created{
		App:           resp.App.toApp(),
		Token:         resp.Token,
		SigningSecret: resp.SigningSecret,
	}, nil
}

func (r *appsRegistry) Get(id string) (*appsplatform.App, error) {
	var w wireApp
	if err := r.do(http.MethodGet, "/api/apps/"+url.PathEscape(id), nil, &w); err != nil {
		return nil, err
	}
	return w.toApp(), nil
}

func (r *appsRegistry) GetByTokenHash(tokenHash string) (*appsplatform.App, error) {
	var w wireApp
	if err := r.do(http.MethodGet, "/api/apps/lookup/by-token-hash?hash="+url.QueryEscape(tokenHash), nil, &w); err != nil {
		return nil, err
	}
	return w.toApp(), nil
}

func (r *appsRegistry) GetByIncomingWebhookID(webhookID string) (*appsplatform.App, error) {
	var w wireApp
	if err := r.do(http.MethodGet, "/api/apps/lookup/by-webhook/"+url.PathEscape(webhookID), nil, &w); err != nil {
		return nil, err
	}
	return w.toApp(), nil
}

func (r *appsRegistry) List(owner string, isAdmin bool) ([]*appsplatform.App, error) {
	q := url.Values{}
	q.Set("owner", owner)
	if isAdmin {
		q.Set("admin", "1")
	}
	var ws []wireApp
	if err := r.do(http.MethodGet, "/api/apps/registry?"+q.Encode(), nil, &ws); err != nil {
		return nil, err
	}
	out := make([]*appsplatform.App, 0, len(ws))
	for i := range ws {
		out = append(out, ws[i].toApp())
	}
	return out, nil
}

func (r *appsRegistry) Update(id string, p appsplatform.UpdateParams) (*appsplatform.App, error) {
	var w wireApp
	if err := r.do(http.MethodPut, "/api/apps/"+url.PathEscape(id), p, &w); err != nil {
		return nil, err
	}
	return w.toApp(), nil
}

func (r *appsRegistry) Delete(id string) error {
	return r.do(http.MethodDelete, "/api/apps/"+url.PathEscape(id), nil, nil)
}

func (r *appsRegistry) RotateToken(id string) (string, error) {
	var resp struct {
		Token string `json:"token"`
	}
	if err := r.do(http.MethodPost, "/api/apps/"+url.PathEscape(id)+"/rotate/token", nil, &resp); err != nil {
		return "", err
	}
	return resp.Token, nil
}

func (r *appsRegistry) RotateSecret(id string) (string, error) {
	var resp struct {
		SigningSecret string `json:"signing_secret"`
	}
	if err := r.do(http.MethodPost, "/api/apps/"+url.PathEscape(id)+"/rotate/secret", nil, &resp); err != nil {
		return "", err
	}
	return resp.SigningSecret, nil
}

func (r *appsRegistry) ResolveSlashCommand(product, name string) (*appsplatform.App, *appsplatform.SlashCommand, bool) {
	q := url.Values{}
	q.Set("product", product)
	q.Set("name", name)
	var resp struct {
		App     *wireApp                   `json:"app"`
		Command *appsplatform.SlashCommand `json:"command"`
	}
	if err := r.do(http.MethodGet, "/api/apps/lookup/slash?"+q.Encode(), nil, &resp); err != nil || resp.App == nil || resp.Command == nil {
		return nil, nil, false
	}
	return resp.App.toApp(), resp.Command, true
}

func (r *appsRegistry) AllSlashCommands(product string) []appsplatform.RegisteredCommand {
	var cmds []appsplatform.RegisteredCommand
	if err := r.do(http.MethodGet, "/api/apps/commands?product="+url.QueryEscape(product), nil, &cmds); err != nil {
		return nil
	}
	return cmds
}
