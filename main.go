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

	"vulos-office/backend/apps"
	"vulos-office/backend/billing"
	"vulos-office/backend/config"
	"vulos-office/backend/handlers"
	"vulos-office/backend/integration/cloud"
	"vulos-office/backend/middleware"
	"vulos-office/backend/obs"
	"vulos-office/backend/seam"
	"vulos-office/backend/storage"
	"vulos-office/backend/userauth"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/vul-os/vulos-apps/appsplatform"
)

// Version is set at build time via -ldflags "-X main.Version=vX.Y.Z".
// It defaults to "dev" for local builds.
var Version = "dev"

//go:embed all:dist
var distFS embed.FS

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
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "version") {
		fmt.Println(Version)
		return
	}

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

	// Auth routes (unauthenticated)
	authHandler := handlers.NewAuthHandler(cfg)
	api := r.Group("/api")
	api.POST("/auth/login", authHandler.Login)
	api.POST("/auth/register", authHandler.Register)
	api.POST("/auth/logout", authHandler.Logout)
	api.GET("/auth/status", authHandler.Status)

	// Protected API routes
	protected := api.Group("/")
	if cfg.Auth.Enabled {
		protected.Use(middleware.Auth(cfg))
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
	protected.GET("/files/:id", fileHandler.Get)
	protected.POST("/files", fileHandler.Create)
	protected.PUT("/files/:id", fileHandler.Update)
	protected.DELETE("/files/:id", fileHandler.Delete)
	// Per-file sharing (owner/admin grants or revokes another account's access).
	protected.POST("/files/:id/share", fileHandler.Share)

	// OFFICE-08: version history endpoints.
	versionHandler := handlers.NewVersionHandler(store)
	protected.GET("/files/:id/versions", versionHandler.ListVersions)
	protected.POST("/files/:id/versions/:vid/restore", versionHandler.RestoreVersion)

	// OFFICE-28: activity feed + named snapshots.
	activityHandler := handlers.NewActivityHandler(store)
	protected.GET("/files/:id/activity", activityHandler.GetActivity)
	protected.POST("/files/:id/versions", activityHandler.CreateNamedSnapshot)
	protected.PUT("/files/:id/versions/:vid/label", activityHandler.LabelVersion)

	// OFFICE-26: comments (anchored, threaded, resolvable).
	commentHandler := handlers.NewCommentHandler(store)
	protected.GET("/files/:id/comments", commentHandler.List)
	protected.POST("/files/:id/comments", commentHandler.Create)
	protected.PUT("/files/:id/comments/:cid", commentHandler.Update)
	protected.DELETE("/files/:id/comments/:cid", commentHandler.Delete)
	protected.POST("/files/:id/comments/:cid/replies", commentHandler.CreateReply)
	protected.PUT("/files/:id/comments/:cid/replies/:rid", commentHandler.UpdateReply)
	protected.DELETE("/files/:id/comments/:cid/replies/:rid", commentHandler.DeleteReply)

	// OFFICE-27: suggestion / track-changes mode.
	suggestionHandler := handlers.NewSuggestionHandler(store)
	protected.GET("/files/:id/suggestions", suggestionHandler.List)
	protected.POST("/files/:id/suggestions", suggestionHandler.Create)
	protected.PUT("/files/:id/suggestions/:sid", suggestionHandler.Update)
	protected.DELETE("/files/:id/suggestions/:sid", suggestionHandler.Delete)

	// Docs export: PDF + DOCX server-side generation.
	docsExportHandler := handlers.NewDocsExportHandler(store)
	protected.GET("/files/:id/export", docsExportHandler.Export)

	uploadHandler := handlers.NewUploadHandler(cfg)
	protected.POST("/upload", uploadHandler.Upload)
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
	protected.POST("/envelopes", envelopeHandler.Create)
	protected.PUT("/envelopes/:id", envelopeHandler.Update)
	protected.DELETE("/envelopes/:id", envelopeHandler.Delete)

	// OFFICE-42: signing link generation + scoped signer view.
	// Send is protected (only the document owner can issue tokens).
	// GetSignerView and Complete are public — no Vulos account required.
	//
	// All /sign/:id routes share a single wildcard param name "id" to avoid gin's
	// "conflicting wildcard" panic — handlers distinguish tokens from envelope IDs
	// by value format (tokens are long UUIDs; envelope IDs are short strings).
	signingHandler := handlers.NewSigningHandler(store)
	protected.POST("/sign/:id/send", signingHandler.Send)
	api.GET("/sign/:id", signingHandler.GetSignerView)
	// OFFICE-43: signer ceremony submission.
	api.POST("/sign/:id/complete", signingHandler.Complete)

	// OFFICE-45: multi-signer orchestration + reminders.
	orchHandler := handlers.NewOrchestrationHandler(store)
	api.GET("/sign/:id/status", orchHandler.Status)
	protected.POST("/sign/:id/remind", orchHandler.Remind)
	protected.POST("/sign/:id/cancel", orchHandler.Cancel)
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
	protected.POST("/sheets/:id/import", sheetsHandler.Import)
	protected.GET("/sheets/:id/export", sheetsHandler.Export)

	// Calendar + Contacts APIs moved to the standalone Vulos Mail/PIM product
	// (vulos-mail CalDAV/CardDAV + lilmail /v1/calendar + /v1/contacts). Office
	// no longer serves /calendar/* or /contacts/* — it is documents-only.

	// Admin: invite-token issuance (mint/list/revoke) + audit-log viewer.
	// Every handler additionally enforces the admin scope (requireAdmin).
	adminHandler := handlers.NewAdminHandler()
	protected.POST("/admin/invites", adminHandler.MintInvite)
	protected.GET("/admin/invites", adminHandler.ListInvites)
	protected.DELETE("/admin/invites/:id", adminHandler.RevokeInvite)
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
	disp := appsplatform.NewDispatcher(reg, appsplatform.ProductOffice)
	h, err := appsplatform.NewHandler(appsplatform.MountConfig{
		Adapter:    apps.NewOfficeAdapter(store, authz),
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
	return h, nil
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
