package handlers

// rendezvous_proxy.go — the SAME-ORIGIN pass-through to a configured
// `vulos-relayd` rendezvous surface.
//
// ── Why this exists (a measured browser fact, not a preference) ──────────────
//
// The OS-free P2P story is: a standalone Ofisi (which mounts no
// `/api/peering/*`) points `collab.rendezvous_url` at any self-hosted
// `vulos-relayd` and the browser gets real peer discovery — no Vulos OS, no
// account. The original design had the BROWSER call that relayd DIRECTLY.
//
// That cannot work, and it is the relay's choice not to allow it: relayd's
// rendezvous surface (tunnel/rendezvous/service.go) emits NO CORS headers at
// all and answers a preflight `OPTIONS /rendezvous/announce` with `405 Method
// Not Allowed`. A cross-origin `fetch()` from Ofisi's origin to the relayd's
// origin therefore fails at the browser before it ever reaches the network —
// verified in real Chromium, and locked down by an assertion in
// e2e-p2p/rendezvous-p2p.e2e.js so a future relayd that DOES send CORS is
// noticed rather than silently assumed.
//
// Since Ofisi must not modify the relay, the browser talks to ITS OWN origin
// (`/api/rendezvous/*`) and this handler forwards the byte-identical request to
// the configured relayd. CORS never enters the picture.
//
// ── What this does and does not change about the trust model ────────────────
//
//   - Ofisi's server sees the rendezvous ENVELOPES it forwards: a room's derived
//     id, Ed25519 addresses, timing, sizes. That is the same metadata the relayd
//     itself sees, and it is metadata only.
//   - It stays CONTENT-BLIND. Every signal/mailbox payload is opaque base64url
//     bytes sealed by the room key, which lives only in the invite-link URL
//     fragment and is never sent to any server. Proxying ciphertext does not
//     make it readable.
//   - Live document edits still NEVER traverse this path — they ride the WebRTC
//     data channel (or the relay's content-blind circuit). This is discovery
//     only, exactly as before.
//   - It remains true that no Vulos OS, no account and no host box are needed.
//     What changed is that the standalone Ofisi binary you are already trusting
//     to serve you the app also carries your discovery traffic.
//
// See docs/COLLABORATION.md §3.
//
// ── Safety posture ──────────────────────────────────────────────────────────
//
// This is a proxy, so it is treated as attacker-facing:
//
//   - The upstream ORIGIN is fixed by the operator's config. Nothing in the
//     request can redirect it elsewhere — no SSRF pivot.
//   - The path is allow-listed to the rendezvous verbs; anything else is 404.
//     Traversal (`..`, encoded or not) is rejected before the URL is built.
//   - Redirects are never followed (a 3xx upstream would otherwise be a
//     redirect-to-anywhere primitive); the status is passed through as-is.
//   - No credentials leak upstream: Cookie / Authorization / and every other
//     header except a small allow-list are dropped. The relay authenticates
//     writes with Ed25519 signatures inside the body; it needs nothing from
//     Ofisi's session.
//   - Bodies are capped and the whole exchange is deadlined. The deadline is
//     generous because the rendezvous poll is a LONG-POLL (the client asks the
//     relay to hold the request for up to ~20s).
//   - When `collab.rendezvous_url` is unset the routes are not mounted at all,
//     so "local-only" stays honestly local-only.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// RendezvousProxyPrefix is the same-origin mount point the browser talks to.
// It must match RENDEZVOUS_PROXY_PREFIX in src/lib/collab/transportSelection.js.
const RendezvousProxyPrefix = "/rendezvous" // under the /api group => /api/rendezvous

// rendezvousUpstreamPrefix is the relayd-side mount prefix. It is relayd's
// default (`-rendezvous-prefix`), and it is what `collab.rendezvous_url` is
// documented to sit in front of.
const rendezvousUpstreamPrefix = "/rendezvous"

// maxRendezvousBody bounds a forwarded request body. Rendezvous payloads are
// small signed envelopes (offer/answer/ICE, mailbox blobs); the relay's own caps
// are far below this, so this is a coarse anti-abuse ceiling, not a protocol
// limit.
const maxRendezvousBody = 1 << 20 // 1 MiB

// rendezvousProxyTimeout must exceed the client's long-poll wait (POLL_WAIT_S =
// 20s in rendezvousSignaling.js) plus the relay's own MaxPollWait slack, or
// idle signaling polls would be cut off mid-flight and look like an outage.
const rendezvousProxyTimeout = 60 * time.Second

// rendezvousRoutes is the exact set of upstream verbs this proxy will forward,
// keyed by the FIRST path segment. Everything else is 404 — the proxy exposes
// the rendezvous protocol and nothing else the relay might ever mount.
var rendezvousRoutes = map[string]struct{}{
	"announce": {},
	"withdraw": {},
	"resolve":  {},
	"signal":   {},
	"mailbox":  {},
	"ice":      {},
	"healthz":  {},
}

// forwardedRequestHeaders is the allow-list of headers copied TOWARD the relay.
// Cookie and Authorization are deliberately absent: the rendezvous protocol is
// self-authenticating (Ed25519 over a canonical message) and must never receive
// an Ofisi session.
var forwardedRequestHeaders = []string{"Content-Type", "Accept"}

// forwardedResponseHeaders is the allow-list copied BACK to the browser.
var forwardedResponseHeaders = []string{"Content-Type", "Cache-Control", "Retry-After"}

// RendezvousProxyHandler forwards the same-origin `/api/rendezvous/*` surface to
// the operator-configured relayd. Construct it with NewRendezvousProxyHandler;
// a nil handler means "not configured" and the routes must not be mounted.
type RendezvousProxyHandler struct {
	upstream *url.URL
	client   *http.Client
}

// NewRendezvousProxyHandler builds the proxy for a configured rendezvous base
// URL. It returns nil when the URL is empty or unusable (not absolute, or not
// http/https) — the caller MUST treat nil as "do not mount", which keeps an
// unset/broken config honestly local-only instead of half-working.
func NewRendezvousProxyHandler(rendezvousURL string) *RendezvousProxyHandler {
	raw := strings.TrimRight(strings.TrimSpace(rendezvousURL), "/")
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil
	}
	return &RendezvousProxyHandler{
		upstream: u,
		client: &http.Client{
			Timeout: rendezvousProxyTimeout,
			// Never follow a redirect: an upstream 3xx would otherwise let the
			// relay (or anything that can impersonate it) steer this server at
			// an arbitrary target. Pass the 3xx back untouched instead.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

// Upstream returns the configured relayd base URL (scheme://host[/path]) for
// honest reporting in /api/reachability. Empty for a nil handler.
func (h *RendezvousProxyHandler) Upstream() string {
	if h == nil {
		return ""
	}
	return strings.TrimRight(h.upstream.String(), "/")
}

// Proxy is the gin handler for ANY /api/rendezvous/*path request.
func (h *RendezvousProxyHandler) Proxy(c *gin.Context) {
	if h == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "rendezvous not configured"})
		return
	}

	rel, ok := sanitizeRendezvousPath(c.Param("path"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "unknown rendezvous route"})
		return
	}

	target := h.upstream.String() + rendezvousUpstreamPrefix + rel
	if q := c.Request.URL.RawQuery; q != "" {
		target += "?" + q
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), rendezvousProxyTimeout)
	defer cancel()

	var body io.Reader
	if c.Request.Body != nil {
		body = io.LimitReader(c.Request.Body, maxRendezvousBody)
	}
	req, err := http.NewRequestWithContext(ctx, c.Request.Method, target, body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "rendezvous upstream unreachable"})
		return
	}
	for _, k := range forwardedRequestHeaders {
		if v := c.GetHeader(k); v != "" {
			req.Header.Set(k, v)
		}
	}

	res, err := h.client.Do(req)
	if err != nil {
		// Fail CLOSED and honestly: a 502 makes the client report the transport
		// as down (and retry with backoff) rather than silently degrade.
		status := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		c.JSON(status, gin.H{"error": "rendezvous upstream unreachable"})
		return
	}
	defer res.Body.Close()

	for _, k := range forwardedResponseHeaders {
		if v := res.Header.Get(k); v != "" {
			c.Header(k, v)
		}
	}
	c.Status(res.StatusCode)
	// Stream the response through; rendezvous bodies are small, but streaming
	// keeps a long-poll's arrival latency at zero extra buffering.
	_, _ = io.Copy(c.Writer, io.LimitReader(res.Body, maxRendezvousBody))
}

// sanitizeRendezvousPath validates the wildcard path captured from
// /api/rendezvous/*path and returns the relative path to append upstream
// (always starting with "/"). It returns ok=false for anything that is not one
// of the allow-listed rendezvous verbs, or that attempts traversal.
//
// gin has already URL-decoded the wildcard, so a `%2e%2e` smuggling attempt
// arrives here as literal dots and is caught by the same check.
func sanitizeRendezvousPath(p string) (string, bool) {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return "", false
	}
	// Reject traversal and absolute/scheme-relative escapes outright rather than
	// trying to normalise them.
	if strings.Contains(p, "..") || strings.Contains(p, "//") || strings.Contains(p, "\\") {
		return "", false
	}
	segs := strings.Split(p, "/")
	if _, allowed := rendezvousRoutes[segs[0]]; !allowed {
		return "", false
	}
	// The rendezvous protocol is at most three segments deep
	// (e.g. signal/<key>/poll). Anything deeper is not part of it.
	if len(segs) > 3 {
		return "", false
	}
	for _, s := range segs[1:] {
		if s == "" {
			return "", false
		}
	}
	return "/" + p, true
}
