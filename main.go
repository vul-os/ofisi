package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"vulos-office/backend/apikey"
	"vulos-office/backend/apps"
	"vulos-office/backend/billing"
	"vulos-office/backend/config"
	"vulos-office/backend/docsync"
	"vulos-office/backend/handlers"
	"vulos-office/backend/integration/cloud"
	"vulos-office/backend/middleware"
	"vulos-office/backend/obs"
	"vulos-office/backend/seam"
	"vulos-office/backend/session"
	"vulos-office/backend/storage"
	"vulos-office/backend/userauth"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/vul-os/vulos-apps/appsplatform"
	"github.com/vul-os/vulos-apps/mcp"
)

// Version is set at build time via -ldflags "-X main.Version=vX.Y.Z".
// It defaults to "dev" for local builds.
var Version = "dev"

//go:embed all:dist
var distFS embed.FS

// siteFS holds the small dark marketing landing served at "/" to logged-out
// visitors (the root auth-gate). Its assets are mounted at /site/ so the page's
// relative ./assets/… URLs resolve once a <base href="/site/"> is injected.
//
//go:embed all:site
var siteFS embed.FS

func main() {
	// One-shot CLI subcommand: migrate a legacy shared-password deploy to a
	// per-user credential so an upgrade doesn't silently lock everyone out.
	//
	//   vulos-office migrate-credential -admin you@vulos.org [-password PW]
	//
	// If -password is omitted the shared password from config.yaml (auth.password)
	// is used. Safe to run repeatedly: it is a no-op once any user exists.
	if len(os.Args) > 1 && os.Args[1] == "migrate-credential" {
		runMigrateCredential(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		runMigrate(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Println(Version)
		return
	}

	// CLI flags for the server process.
	noRateLimitWrites := flag.Bool("no-rate-limit-writes", false,
		"disable token-bucket rate limiting on write/collab endpoints (for testing or trusted environments)")
	flag.Parse()

	log.Printf("vulos-office %s starting", Version)
	obs.Init()

	cfg, err := config.Load("config.yaml")
	if err != nil {
		log.Printf("Config error: %v — using defaults", err)
		cfg = config.Default()
	}

	// Fail closed: when auth is enabled, refuse to start unless a JWT signing
	// secret is configured (VULOS_OFFICE_JWT_SECRET, or VULOS_OFFICE_DEV=1 for
	// local development). This prevents shipping with a predictable key.
	if cfg.Auth.Enabled && !middleware.JWTSecretConfigured() {
		log.Fatalf("auth is enabled but no JWT signing secret is configured: set %s "+
			"to a strong random value (or %s=1 for local dev)",
			middleware.EnvJWTSecret, middleware.EnvDevMode)
	}

	store, err := storage.New(cfg)
	if err != nil {
		log.Fatal("Storage init failed:", err)
	}

	// Calendar + Contacts moved to the standalone Vulos Mail/PIM product
	// (vulos-mail CalDAV/CardDAV + lilmail /v1/calendar + /v1/contacts). Office
	// is documents-only; their durable stores no longer live here.

	// ── Org-bucket object store ───────────────────────────────────────────────
	// ResolveOrgBucket reads VULOS_ORG_ID (cloud-injected org identifier) and
	// scopes all object keys by org/account. If the env is absent the binary
	// still boots and logs a warning (OSS self-host, no cloud required).
	storage.InitOrgBucket()

	// ── Integration seam ──────────────────────────────────────────────────────
	// office runs COMPLETELY STANDALONE by default: identity is verified against
	// office's local JWT secret, entitlements are unlimited (self-host), and
	// usage metering is a no-op. The vulos-cloud control plane is OPTIONAL and
	// only engaged when VULOS_CP_BASE_URL is set — the core never imports the
	// cloud adapter, so removing it cannot break the standalone build.
	provider := seam.NewStandaloneProvider(middleware.JWTSecret, cfg.Auth.Enabled)
	integrationMode := "standalone"
	if cloud.Enabled() {
		ccfg := cloud.FromEnv()
		provider = cloud.NewProvider(ccfg, provider.Identity)
		integrationMode = "cloud"
		log.Printf("[seam] integration mode: cloud (control plane %s)", ccfg.BaseURL)
	} else {
		log.Printf("[seam] integration mode: standalone (no control plane)")
	}
	// Install the active provider into the billing enforcement layer so handlers
	// gate billable actions (storage, seats, office access) and emit usage. In
	// standalone mode this is a no-op (unlimited, never suspended). The billing
	// package imports only backend/seam, never the cloud adapter.
	billing.Configure(provider)

	// ── SSO session-introspection seam ────────────────────────────────────────
	// Wedge-aligned identity: Office holds NO session-signing power. When
	// IDENTITY_URL is set (multi-user cloud, or a sovereign box brokering many
	// users) Office INTROSPECTS the `vc_session` cookie against that provider,
	// presenting the SAME shared service secret it already holds for the CP
	// (VULOS_CP_TOKEN == the provider's CP_SHARED_SECRET). When IDENTITY_URL is
	// UNSET (self-host single-user appliance) this path is DISABLED and Office
	// keeps its existing local single-identity behavior — unchanged.
	sessCfg := session.FromEnv()
	sessionIntrospector := session.NewIntrospector(sessCfg)
	if sessionIntrospector != nil {
		log.Printf("[sso] session introspection enabled (identity provider %s)", sessCfg.IdentityURL)
	} else {
		log.Printf("[sso] session introspection disabled (no %s); local single-identity mode", session.EnvIdentityURL)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	// CORS: prefer an explicit origin allowlist (VULOS_OFFICE_CORS_ORIGINS, a
	// comma-separated list) so credentialed cross-origin requests are restricted
	// to trusted front-ends. When unset we fall back to AllowAllOrigins WITHOUT
	// credentials (the SPA is same-origin embedded, so this is safe for self-host
	// and avoids a wildcard-with-credentials misconfiguration).
	corsCfg := cors.Config{
		AllowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Origin", "Content-Type", "Authorization", "X-Registration-Token", "X-Account-ID"},
	}
	if raw := strings.TrimSpace(os.Getenv("VULOS_OFFICE_CORS_ORIGINS")); raw != "" {
		var origins []string
		for _, o := range strings.Split(raw, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		corsCfg.AllowOrigins = origins
		corsCfg.AllowCredentials = true
		log.Printf("[cors] explicit origin allowlist: %v (credentials allowed)", origins)
	} else {
		corsCfg.AllowAllOrigins = true // no credentials → safe wildcard
		log.Printf("[cors] no VULOS_OFFICE_CORS_ORIGINS set; allowing all origins WITHOUT credentials")
	}
	r.Use(cors.New(corsCfg))

	// Prometheus metrics (no auth required).
	r.GET("/metrics", gin.WrapH(obs.Handler()))

	// Build-time version (no auth required).
	r.GET("/version", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"version": Version})
	})

	// Health check for load-balancers and status pages (no auth required).
	// Returns 200 {"status":"ok","version":"<build-time version>"} when the
	// server is alive. Does NOT probe the database; use /metrics for depth.
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "version": Version})
	})

	// Auth routes (unauthenticated)
	authHandler := handlers.NewAuthHandler(cfg)
	api := r.Group("/api")
	// Rate-limit login: bcrypt on an unthrottled endpoint is an online brute-force
	// oracle. 5 attempts / minute per IP blunts credential-stuffing while allowing
	// legitimate users to retry after a typo. Matches the password-change limiter.
	loginLimiter := middleware.NewRateLimiter(5, time.Minute)
	api.POST("/auth/login", loginLimiter.Middleware(), authHandler.Login)
	api.POST("/auth/register", authHandler.Register)
	api.POST("/auth/logout", authHandler.Logout)
	api.GET("/auth/status", authHandler.Status)

	// Protected API routes.
	//
	// AuthWithSSO preserves the existing product-JWT session gate and, when
	// IDENTITY_URL is configured, ADDS the SSO `vc_session` introspection path
	// (fail-closed). When auth is disabled AND no SSO provider is set it is a
	// no-op passthrough (self-host single-user — unchanged), so we only install
	// it when at least one identity source is active.
	protected := api.Group("/")
	if cfg.Auth.Enabled || sessionIntrospector != nil {
		protected.Use(middleware.AuthWithSSO(cfg, sessionIntrospector))
	}

	// Write/collab sub-group — same auth middleware as protected, plus a
	// token-bucket rate limiter on every state-changing endpoint.
	//
	// Default: 30-request burst, refills at 10 requests/second per client IP.
	// This throttles rapid automated writes (bulk import, bot abuse) while
	// leaving normal human editing (save-on-keyup, comment spam) unaffected.
	// Disable with --no-rate-limit-writes for trusted internal tooling.
	writes := api.Group("/")
	if cfg.Auth.Enabled || sessionIntrospector != nil {
		writes.Use(middleware.AuthWithSSO(cfg, sessionIntrospector))
	}
	if !*noRateLimitWrites {
		writeLimiter := middleware.NewTokenBucket(30, 10)
		writes.Use(writeLimiter.Middleware())
		log.Printf("[rate-limit] write/collab endpoints: token-bucket cap=30 rate=10/s per IP")
	} else {
		log.Printf("[rate-limit] write/collab rate limiting disabled (--no-rate-limit-writes)")
	}

	// Standalone system surface: honest runtime facts for the self-hosted
	// Settings/Admin UI, plus authenticated self-service password change.
	systemHandler := handlers.NewSystemHandler(cfg, Version, integrationMode)
	protected.GET("/system/info", systemHandler.Info)
	// Rate-limit the self-service password change: it re-verifies the CURRENT
	// password, so without a limit it is an online brute-force oracle. 5
	// attempts/minute per client IP is ample for a human while blunting
	// automated guessing.
	pwLimiter := middleware.NewRateLimiter(5, time.Minute)
	protected.POST("/auth/password", pwLimiter.Middleware(), systemHandler.ChangePassword)

	// Pin the file-ACL authorizer to the active storage backend BEFORE any file
	// handler is constructed. Under Postgres this co-locates ACL ownership in the
	// same DB as the files (transactional + replicated); under sqlite/local it
	// uses the separate sqlite ACL store.
	fileAuthz := handlers.InitFileAuthz(store, cfg.Auth.Enabled)

	fileHandler := handlers.NewFileHandler(store)
	protected.GET("/files", fileHandler.List)
	// "Shared with me" — files shared TO the caller (owned excluded). Registered
	// under a distinct prefix to avoid a route conflict with /files/:id.
	protected.GET("/shared-files", fileHandler.SharedWithMe)
	protected.GET("/files/:id", fileHandler.Get)
	writes.POST("/files", fileHandler.Create)
	writes.PUT("/files/:id", fileHandler.Update)
	writes.DELETE("/files/:id", fileHandler.Delete)
	// Parity: file organization — move into a folder / star / trash-toggle.
	writes.POST("/files/:id/move", fileHandler.Move)
	// Parity: collaborator roster for @-mention autocomplete.
	protected.GET("/files/:id/collaborators", fileHandler.Collaborators)
	// Per-file sharing (owner/admin grants or revokes another account's access).
	writes.POST("/files/:id/share", fileHandler.Share)

	// Parity: folder tree (per-account, ACL-owned like files).
	folderHandler := handlers.NewFolderHandler(store)
	protected.GET("/folders", folderHandler.List)
	writes.POST("/folders", folderHandler.Create)
	writes.PUT("/folders/:id", folderHandler.Update)
	writes.POST("/folders/:id/trash", folderHandler.Trash)
	writes.DELETE("/folders/:id", folderHandler.Delete)

	// OFFICE-08: version history endpoints.
	versionHandler := handlers.NewVersionHandler(store)
	protected.GET("/files/:id/versions", versionHandler.ListVersions)
	writes.POST("/files/:id/versions/:vid/restore", versionHandler.RestoreVersion)
	// Version diff (readable for Docs, coarse summary for Sheets/Slides). Read-only.
	protected.GET("/files/:id/versions/:vid/diff", versionHandler.Diff)

	// Global full-text search across the caller's ACL-scoped documents. Query time
	// ACL enforcement (owned + shared only); no cross-account content leak.
	searchHandler := handlers.NewSearchHandler(store)
	protected.GET("/search", searchHandler.Search)

	// Expiring / password-protected read-only share links + transfer ownership.
	shareLinkHandler := handlers.NewShareLinkHandler(store)
	protected.GET("/files/:id/share-links", shareLinkHandler.List)
	writes.POST("/files/:id/share-links", shareLinkHandler.Create)
	writes.DELETE("/files/:id/share-links/:lid", shareLinkHandler.Revoke)
	writes.POST("/files/:id/transfer-owner", fileHandler.TransferOwner)
	// Anonymous, token-gated, READ-ONLY document view (no auth — the token IS the
	// credential). GET returns metadata (and content when no password); POST with
	// the password returns content for password-gated links.
	//
	// The POST path calls bcrypt.CompareHashAndPassword on the link password. It is
	// UNAUTHENTICATED, so without a limit it is an online brute-force oracle against
	// the share-link password — exactly the risk /auth/login and /auth/password
	// already guard against. Rate-limit the POST per client IP (10/min), matching
	// those sensitive endpoints. GET is NOT password-bearing (its content is gated
	// by the 256-bit token capability, not a guessable secret), so it is left
	// unthrottled to avoid falsely blocking many legitimate viewers behind one NAT.
	shareViewLimiter := middleware.NewRateLimiter(10, time.Minute)
	api.GET("/share/:token", shareLinkHandler.ViewMeta)
	api.POST("/share/:token", shareViewLimiter.Middleware(), shareLinkHandler.View)

	// OFFICE-28: activity feed + named snapshots.
	activityHandler := handlers.NewActivityHandler(store)
	protected.GET("/files/:id/activity", activityHandler.GetActivity)
	writes.POST("/files/:id/versions", activityHandler.CreateNamedSnapshot)
	writes.PUT("/files/:id/versions/:vid/label", activityHandler.LabelVersion)

	// OFFICE-26: comments (anchored, threaded, resolvable).
	commentHandler := handlers.NewCommentHandler(store)
	protected.GET("/files/:id/comments", commentHandler.List)
	writes.POST("/files/:id/comments", commentHandler.Create)
	writes.PUT("/files/:id/comments/:cid", commentHandler.Update)
	writes.DELETE("/files/:id/comments/:cid", commentHandler.Delete)
	writes.POST("/files/:id/comments/:cid/replies", commentHandler.CreateReply)
	writes.PUT("/files/:id/comments/:cid/replies/:rid", commentHandler.UpdateReply)
	writes.DELETE("/files/:id/comments/:cid/replies/:rid", commentHandler.DeleteReply)

	// Parity: in-app notifications (surfaces @-mentions to the mentioned user).
	notificationHandler := handlers.NewNotificationHandler()
	protected.GET("/notifications", notificationHandler.List)
	writes.POST("/notifications/read-all", notificationHandler.MarkAllRead)
	writes.POST("/notifications/:id/read", notificationHandler.MarkRead)

	// OFFICE-27: suggestion / track-changes mode.
	suggestionHandler := handlers.NewSuggestionHandler(store)
	protected.GET("/files/:id/suggestions", suggestionHandler.List)
	writes.POST("/files/:id/suggestions", suggestionHandler.Create)
	writes.PUT("/files/:id/suggestions/:sid", suggestionHandler.Update)
	writes.DELETE("/files/:id/suggestions/:sid", suggestionHandler.Delete)

	// Docs export: PDF + DOCX server-side generation.
	docsExportHandler := handlers.NewDocsExportHandler(store)
	protected.GET("/files/:id/export", docsExportHandler.Export)

	// ── Public /v1 developer API ──────────────────────────────────────────────
	// A clean, documented JSON REST surface over the SAME document engine (storage,
	// FileAuthz, billing gates, export services). It authenticates with EITHER the
	// existing Office session OR a `Authorization: Bearer vk_…` API key validated
	// via the cloud introspection seam (POST {CP}/api/keys/introspect). The key
	// path is enabled only when VULOS_CP_BASE_URL is configured; otherwise /v1
	// falls back to session-only auth (self-host unchanged). See docs/API.md.
	keyCfg := apikey.FromEnv()
	v1Introspector := apikey.NewIntrospector(keyCfg)
	if v1Introspector != nil {
		log.Printf("[v1] API-key introspection enabled (control plane %s)", keyCfg.BaseURL)
	} else {
		log.Printf("[v1] API-key path disabled (no %s); /v1 uses session auth only", apikey.EnvCPBaseURL)
	}
	// Server-collab op-log store (WAVE37) — shared between the /v1 doc handler
	// (so DeleteDocument purges the op log) and the docsync realtime handler.
	docSyncStore := newDocSyncStore()
	v1Handler := handlers.NewV1Handler(store).WithDocSync(docSyncStore)
	docSyncHandler := handlers.NewDocSyncHandler(store, docSyncStore)
	v1 := r.Group("/v1")
	v1.Use(middleware.V1Auth(cfg, v1Introspector, sessionIntrospector))
	// Reads.
	v1.GET("/documents", v1Handler.ListDocuments)
	v1.GET("/documents/:id", v1Handler.GetDocument)
	v1.GET("/documents/:id/content", v1Handler.GetContent)
	v1.GET("/documents/:id/collaborators", v1Handler.ListCollaborators)
	// ── Server-mediated real-time collaboration (WAVE37): reads ───────────────
	// The CLOUD / account collab path: an ACL-gated hub that relays RGA CRDT ops
	// between authorized editors AND persists them authoritatively (backend/
	// docsync), so a document stays in sync + saved even with ZERO p2p peers, and
	// a late joiner catches up from the server. This complements the p2p fabric
	// (E2E-encrypted, room-gated) — the E2E path is NOT routed through this
	// readable server. See backend/handlers/docsync.go.
	//
	// stream/state are VIEWER+ (read gate) and registered BEFORE the write
	// token-bucket so the long-lived SSE stream is not rate-limited (mirrors
	// Talk's /spaces/stream, which is a long-lived read).
	v1.GET("/documents/:id/collab/stream", docSyncHandler.Stream)
	v1.GET("/documents/:id/collab/state", docSyncHandler.State)
	// Live presence (cursor/selection + roster): VIEWER+, ephemeral fan-out, NOT
	// persisted. It is registered on its OWN token bucket (BEFORE the content
	// write bucket below) because cursor moves are high-frequency and must not
	// starve real content writes out of the shared content bucket — yet it still
	// needs a bound so one tab cannot flood the hub. The client debounces to a
	// few POSTs/sec; this bucket (60 burst / 30-per-sec refill) is generous for
	// that while capping abuse. Identity is stamped server-side (no spoofing).
	if !*noRateLimitWrites {
		presenceGroup := v1.Group("")
		presenceGroup.Use(middleware.NewTokenBucket(60, 30).Middleware())
		presenceGroup.POST("/documents/:id/collab/presence", docSyncHandler.Presence)
	} else {
		v1.POST("/documents/:id/collab/presence", docSyncHandler.Presence)
	}
	// Writes (rate-limited alongside the rest of the write surface).
	if !*noRateLimitWrites {
		v1.Use(middleware.NewTokenBucket(30, 10).Middleware())
	}
	v1.POST("/documents", v1Handler.CreateDocument)
	v1.PATCH("/documents/:id", v1Handler.PatchDocument)
	v1.DELETE("/documents/:id", v1Handler.DeleteDocument)
	v1.POST("/documents/:id/export", v1Handler.ExportDocument)
	v1.POST("/documents/:id/collaborators", v1Handler.ShareDocument)
	// Op ingest (publish): EDITOR+ (reuses the SAME requireEditor gate as PATCH),
	// so a viewer/commenter cannot push ops. Rate-limited with the write surface.
	v1.POST("/documents/:id/collab/ops", docSyncHandler.Publish)

	uploadHandler := handlers.NewUploadHandler(cfg)
	writes.POST("/upload", uploadHandler.Upload)
	api.GET("/uploads/:filename", uploadHandler.Serve)

	// Local-files browse/serve exposes the SERVER PROCESS's own ~/Documents,
	// ~/Downloads and ~/Desktop. That is a convenience for a single-user /
	// standalone self-host (the operator browsing their own machine), but in a
	// multi-tenant deploy (auth enabled) it would let ANY authenticated user read
	// the operator's personal files. Register these routes ONLY when auth is
	// disabled (standalone single-user mode); when auth is enabled they are
	// intentionally absent (404).
	if !cfg.Auth.Enabled {
		localFilesHandler := handlers.NewLocalFilesHandler()
		protected.GET("/local-files", localFilesHandler.Scan)
		protected.GET("/local-files/serve", localFilesHandler.Serve)
	} else {
		log.Printf("[local-files] auth enabled (multi-tenant): local-files browse/serve routes disabled to avoid cross-tenant exposure of the server's home directory")
	}

	// Team chat + huddles ("Spaces") is now the standalone Vulos Talk product:
	// its meeting/lobby/TURN/recording + spaces/presence API moved to vulos-talk.
	// Office hands those routes off via seam-C (the SPA redirects to talk.vulos.org).

	// OFFICE-41: envelope CRUD (field-placement setup).
	envelopeHandler := handlers.NewEnvelopeHandler(store)
	protected.GET("/envelopes", envelopeHandler.List)
	protected.GET("/envelopes/:id", envelopeHandler.Get)
	writes.POST("/envelopes", envelopeHandler.Create)
	writes.PUT("/envelopes/:id", envelopeHandler.Update)
	writes.DELETE("/envelopes/:id", envelopeHandler.Delete)

	// OFFICE-42: signing link generation + scoped signer view.
	// Send is protected (only the document owner can issue tokens).
	// GetSignerView and Complete are public — no Vulos account required.
	//
	// All /sign/:id routes share a single wildcard param name "id" to avoid gin's
	// "conflicting wildcard" panic — handlers distinguish tokens from envelope IDs
	// by value format (tokens are long UUIDs; envelope IDs are short strings).
	signingHandler := handlers.NewSigningHandler(store)
	writes.POST("/sign/:id/send", signingHandler.Send)
	api.GET("/sign/:id", signingHandler.GetSignerView)
	// OFFICE-43: signer ceremony submission.
	api.POST("/sign/:id/complete", signingHandler.Complete)

	// OFFICE-45: multi-signer orchestration + reminders.
	orchHandler := handlers.NewOrchestrationHandler(store)
	api.GET("/sign/:id/status", orchHandler.Status)
	writes.POST("/sign/:id/remind", orchHandler.Remind)
	writes.POST("/sign/:id/cancel", orchHandler.Cancel)
	api.POST("/sign/:id/decline", orchHandler.Decline)

	// OFFICE-46: sealed PDF download + audit manifest.
	// Protected: only the document owner/authenticated users may download.
	sealHandler := handlers.NewSealHandler(store, cfg.Server.UploadsDir)
	protected.GET("/sign/:id/download", sealHandler.Download)
	protected.GET("/sign/:id/manifest", sealHandler.Manifest)

	// OFFICE-47: signature + audit verification tool (public — no auth required).
	verifyHandler := handlers.NewVerifyHandler(store)
	api.POST("/sign/verify", verifyHandler.Verify)
	// PublicKey — expose server Ed25519 public key for independent token verification.
	api.GET("/sign/pubkey", verifyHandler.PublicKey)

	// SLIDES-07: slide deck PDF/PPTX export.
	slidesExportHandler := handlers.NewSlidesExportHandler(store)
	protected.GET("/slides/:id/export", slidesExportHandler.Export)

	// Sheets XLSX import/export endpoints.
	sheetsHandler := handlers.NewSheetsHandler(store)
	writes.POST("/sheets/:id/import", sheetsHandler.Import)
	protected.GET("/sheets/:id/export", sheetsHandler.Export)

	// Calendar + Contacts APIs moved to the standalone Vulos Mail/PIM product
	// (vulos-mail CalDAV/CardDAV + lilmail /v1/calendar + /v1/contacts). Office
	// no longer serves /calendar/* or /contacts/* — it is documents-only.

	// Admin: invite-token issuance (mint/list/revoke) + audit-log viewer.
	// Every handler additionally enforces the admin scope (requireAdmin).
	adminHandler := handlers.NewAdminHandler()
	writes.POST("/admin/invites", adminHandler.MintInvite)
	protected.GET("/admin/invites", adminHandler.ListInvites)
	writes.DELETE("/admin/invites/:id", adminHandler.RevokeInvite)
	protected.GET("/admin/audit", adminHandler.ListAudit)

	// NOTE: Vulos Spaces (presence + channels/DMs/threads/messages) moved to the
	// standalone Vulos Talk product (vulos-talk). The /spaces/* and /meet/* APIs
	// are served there; Office redirects those deep-links via seam-C.

	// ── Apps & Bots place (shared @vulos/apps platform) ───────────────────────
	// Office hosts an "apps & bots place" via the product-agnostic
	// appsplatform handler set, with a small Office ProductAdapter (documents).
	//
	// Open-core seam: the registry defaults to the in-tree StandaloneRegistry
	// (pure-Go SQLite). A Vulos Cloud control-plane registry implements the SAME
	// appsplatform.Registry in backend/integration/cloud — a package the core
	// never imports — and is wired ONLY when explicitly enabled via env
	// (cloud.AppsRegistryEnabled). Removing the cloud package never breaks this
	// build. Management routes reuse Office's OWN session auth via SessionIdentity;
	// runtime routes authenticate with app tokens (handled inside the platform).
	if h, err := mountAppsPlatform(cfg, r, store, fileAuthz); err != nil {
		log.Printf("[apps] apps & bots platform disabled: %v", err)
	} else {
		log.Printf("[apps] apps & bots place mounted at %s (registry: %s)", h.BasePath, appsRegistryMode())
	}

	// Serve embedded frontend (SPA fallback to index.html)
	staticFS, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal("Failed to create static FS:", err)
	}
	staticServer := http.FileServer(http.FS(staticFS))

	// ── Root auth-gate ────────────────────────────────────────────────────────
	// Mount the embedded marketing landing's assets under /site/ so the page's
	// relative ./assets/… URLs resolve (a <base href="/site/"> is injected below).
	if siteSub, serr := fs.Sub(siteFS, "site"); serr == nil {
		r.StaticFS("/site", http.FS(siteSub))
	} else {
		log.Printf("[root-gate] embedded site assets unavailable: %v", serr)
	}

	// Pre-build the landing HTML once, injecting <base href="/site/"> so the
	// page's relative asset refs resolve to the mounted /site/ tree.
	var landingHTML []byte
	if raw, rerr := siteFS.ReadFile("site/index.html"); rerr == nil {
		landingHTML = []byte(strings.Replace(string(raw), "<head>", `<head><base href="/site/">`, 1))
	} else {
		log.Printf("[root-gate] embedded site/index.html unavailable: %v", rerr)
	}

	// serveSPAIndex serves the SPA's index.html (the same content NoRoute serves
	// for "/"): the React app then drives routing and shows the login screen when
	// appropriate.
	serveSPAIndex := func(c *gin.Context) {
		c.Request.URL.Path = "/"
		staticServer.ServeHTTP(c.Writer, c.Request)
	}

	// Explicit GET "/" overrides the NoRoute fallback (which would otherwise serve
	// the SPA for "/"). Authenticated visitors get the SPA; logged-out visitors get
	// the marketing landing with a "Sign in" CTA. Auth state is determined by the
	// SAME session validation the API middleware uses (Authorization bearer or the
	// HttpOnly "session" cookie, HS256). When auth is disabled, SessionIdentity
	// reports ok=true (single-user self-host), so the SPA is served directly.
	r.GET("/", func(c *gin.Context) {
		if _, _, ok := middleware.SessionIdentity(cfg, c.Request); ok {
			serveSPAIndex(c)
			return
		}
		if len(landingHTML) == 0 {
			// No landing available — fall back to the SPA (shows the login screen).
			serveSPAIndex(c)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, "text/html; charset=utf-8", landingHTML)
	})

	r.NoRoute(func(c *gin.Context) {
		urlPath := c.Request.URL.Path
		// fs.FS requires paths without a leading slash.
		// Strip it before probing, then let http.FileServer handle the request
		// (which re-adds the slash internally).
		fsPath := strings.TrimPrefix(urlPath, "/")
		f, err := staticFS.Open(fsPath)
		if err == nil {
			f.Close()
			staticServer.ServeHTTP(c.Writer, c.Request)
			return
		}
		// SPA fallback: serve index.html for unknown routes (React Router)
		c.Request.URL.Path = "/"
		staticServer.ServeHTTP(c.Writer, c.Request)
	})

	addr := cfg.Server.Addr
	if addr == "" {
		addr = ":8080"
	}

	log.Printf("Vulos Office running → http://localhost%s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}

// appsDBPath resolves the SQLite DSN for the StandaloneRegistry from env,
// defaulting to a durable file under the data dir.
func appsDBPath() string {
	if v := strings.TrimSpace(os.Getenv("VULOS_APPS_DB")); v != "" {
		return v
	}
	return "./data/apps.db"
}

// docSyncDBPath resolves the WAVE37 server-collab op-log SQLite DSN from env,
// defaulting to a durable file under the data dir.
func docSyncDBPath() string {
	if v := strings.TrimSpace(os.Getenv("VULOS_DOCSYNC_DB")); v != "" {
		return v
	}
	return "./data/docsync.db"
}

// newDocSyncStore opens the durable op-log store for the server-mediated collab
// path. If the DB cannot be opened it falls back to an in-memory NullStore so
// the app still boots (degraded: relay still works, op log does not persist
// across restart) rather than crashing — matching the fail-soft posture of the
// other sidecar stores (fileacl, apps).
func newDocSyncStore() docsync.Store {
	if st, err := docsync.NewSQLiteStore(docSyncDBPath()); err == nil {
		return st
	} else {
		log.Printf("[docsync] op-log store unavailable (%s): %v; using in-memory store (no restart persistence)", docSyncDBPath(), err)
		return docsync.NewNullStore()
	}
}

// appsRegistryMode reports which registry implementation the apps place uses,
// for the boot log line. "cloud" only when explicitly env-enabled.
func appsRegistryMode() string {
	if cloud.AppsRegistryEnabled() {
		return "cloud control plane"
	}
	return "standalone (sqlite)"
}

// newAppsRegistry selects the apps registry: the in-tree StandaloneRegistry by
// default, or the cloud control-plane registry when explicitly enabled via env.
// The core never imports the cloud adapter; only this composition root does.
func newAppsRegistry() (appsplatform.Registry, error) {
	if cloud.AppsRegistryEnabled() {
		return cloud.NewAppsRegistry(cloud.FromEnv())
	}
	return appsplatform.NewStandaloneRegistry(appsDBPath())
}

// mountAppsPlatform wires the shared Apps & Bots platform handler set into the
// Gin router under /api/apps. The management API reuses Office's session auth
// (middleware.SessionIdentity); runtime + incoming-webhook routes are handled
// by the platform (app-token auth / unauthenticated webhook id). It returns the
// mounted handler (for the base-path log line) or an error.
func mountAppsPlatform(cfg *config.Config, r *gin.Engine, store storage.Storage, authz *handlers.FileAuthz) (*appsplatform.Handler, error) {
	reg, err := newAppsRegistry()
	if err != nil {
		return nil, err
	}
	adapter := apps.NewOfficeAdapter(store, authz)
	disp := appsplatform.NewDispatcher(reg, appsplatform.ProductOffice)
	h, err := appsplatform.NewHandler(appsplatform.MountConfig{
		Adapter:    adapter,
		Registry:   reg,
		Dispatcher: disp,
		Admin: func(req *http.Request) (string, bool, bool) {
			return middleware.SessionIdentity(cfg, req)
		},
		BasePath: "/api/apps",
	})
	if err != nil {
		return nil, err
	}
	// The platform handler set is a net/http ServeMux with ABSOLUTE patterns
	// under the base path, so forward the whole /api/apps subtree to it. These
	// routes intentionally bypass Gin's session middleware: the platform does its
	// own auth (session for management, app token for runtime).
	r.Any("/api/apps", gin.WrapH(h))
	r.Any("/api/apps/*proxyPath", gin.WrapH(h))

	// Mount the shared @vulos/apps MCP server over the SAME adapter, registry,
	// and event emitter so any LLM/agent can operate Office over MCP. A failure
	// here disables only MCP — the REST apps place stays up.
	if err := mountMCP(r, adapter, reg, disp); err != nil {
		log.Printf("[apps] MCP server disabled: %v", err)
	}
	return h, nil
}

// mountMCP wires the Vulos MCP server (github.com/vul-os/vulos-apps/mcp) into the
// Gin router at /mcp. It is a different SHAPE over the EXACT seam the REST apps
// platform already exposes: the SAME Office ProductAdapter (Act→tools,
// Read→resources), the SAME app-token Registry (Bearer vat_, constant-time), and
// the SAME dispatcher emitter (so MCP tool calls fan out like REST actions).
//
// Open-core: this ships in the OSS build and runs STANDALONE — self-host Office,
// mint an app token, point an MCP agent at /mcp. The optional cloud aggregating
// MCP gateway (mcp.MCPConfig.Gateway) is an env-gated seam the core never wires:
// we leave it nil here, exactly as the apps registry leaves the cloud broker out
// of the default build. The core never imports backend/integration/cloud for MCP.
func mountMCP(r *gin.Engine, adapter appsplatform.ProductAdapter, reg appsplatform.Registry, disp *appsplatform.Dispatcher) error {
	h, err := mcp.NewHandler(mcp.MCPConfig{
		Adapter:  adapter,         // SAME ProductAdapter (per-file ACL honored in Act/Read)
		Registry: reg,             // SAME vat_ token registry
		Emit:     disp.EmitFunc(), // SAME event fan-out as REST actions
		BasePath: "/mcp",
		// Gateway: nil — standalone open-core; the cloud aggregation seam is not
		// wired in the core build.
	})
	if err != nil {
		return err
	}
	// Like the apps handler, this is a net/http ServeMux with absolute patterns
	// under the base path; forward the whole /mcp subtree to it. It does its own
	// app-token auth, so it intentionally bypasses Gin's session middleware.
	r.Any("/mcp", gin.WrapH(h))
	r.Any("/mcp/*proxyPath", gin.WrapH(h))
	log.Printf("[apps] MCP server mounted at %s", h.BasePath)
	return nil
}

// runMigrateCredential implements the `migrate-credential` subcommand.
func runMigrateCredential(args []string) {
	fs := flag.NewFlagSet("migrate-credential", flag.ExitOnError)
	adminID := fs.String("admin", "", "admin account id to create the first per-user credential for (required)")
	password := fs.String("password", "", "password for the credential (default: auth.password from config.yaml)")
	dbPath := fs.String("db", "", "credential DB path (default: $VULOS_USERAUTH_DB or ./data/userauth.db)")
	_ = fs.Parse(args)

	cfg, err := config.Load("config.yaml")
	if err != nil {
		cfg = config.Default()
	}
	pw := *password
	if pw == "" {
		pw = cfg.Auth.Password
	}
	if *adminID == "" || pw == "" {
		fmt.Fprintln(os.Stderr, "migrate-credential: -admin is required, and a password must be available "+
			"(via -password or auth.password in config.yaml)")
		os.Exit(2)
	}

	dsn := *dbPath
	if dsn == "" {
		if v := os.Getenv("VULOS_USERAUTH_DB"); v != "" {
			dsn = v
		} else {
			dsn = "./data/userauth.db"
		}
	}

	store, err := userauth.NewSQLiteStore(dsn)
	if err != nil {
		log.Fatalf("migrate-credential: open credential store %q: %v", dsn, err)
	}
	defer store.Close()

	switch err := userauth.MigrateSharedPassword(store, *adminID, pw); err {
	case nil:
		fmt.Printf("migrate-credential: created per-user credential for %q in %s\n", *adminID, dsn)
		fmt.Println("You can now log in with that account + password, then mint invites for the rest of your team.")
	case userauth.ErrAlreadyMigrated:
		fmt.Println("migrate-credential: credential store already has users — nothing to do (no lockout risk).")
	default:
		log.Fatalf("migrate-credential: %v", err)
	}
}
