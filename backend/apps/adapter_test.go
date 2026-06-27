package apps

import (
	"context"
	"encoding/json"
	"testing"

	"vulos-office/backend/config"
	"vulos-office/backend/fileacl"
	"vulos-office/backend/handlers"
	"vulos-office/backend/storage"

	"github.com/vul-os/vulos-apps/appsplatform"
)

func newAdapter(t *testing.T) *OfficeAdapter {
	t.Helper()
	cfg := config.Default()
	cfg.Server.DataDir = t.TempDir()
	st, err := storage.NewLocalStorage(cfg)
	if err != nil {
		t.Fatalf("local storage: %v", err)
	}
	// auth-disabled posture (single-user): NullStore ACL, fail-open access.
	authz := handlers.NewFileAuthz(fileacl.NewNullStore())
	return NewOfficeAdapter(st, authz)
}

func testApp() *appsplatform.App {
	return &appsplatform.App{
		ID:       "a1",
		Name:     "Tester",
		OwnerID:  "alice",
		Products: []string{appsplatform.ProductOffice},
		Scopes:   []string{appsplatform.ScopeAppsRead, appsplatform.ScopeAppsWrite},
		SlashCommands: []appsplatform.SlashCommand{
			{Name: "summarize", Description: "summarize a doc"},
		},
	}
}

func TestProductAndScopes(t *testing.T) {
	a := newAdapter(t)
	if a.Product() != appsplatform.ProductOffice {
		t.Fatalf("Product()=%q want office", a.Product())
	}
	if got := a.RequiredScope("document.create"); got != appsplatform.ScopeAppsWrite {
		t.Fatalf("create scope=%q want write", got)
	}
	if got := a.RequiredScope("list"); got != appsplatform.ScopeAppsRead {
		t.Fatalf("list scope=%q want read", got)
	}
}

func TestCreateAppendReadDocument(t *testing.T) {
	a := newAdapter(t)
	app := testApp()
	ctx := context.Background()

	// create
	createPayload, _ := json.Marshal(map[string]any{"name": "Notes", "text": "line one"})
	res, err := a.Act(ctx, app, appsplatform.ActionRequest{Action: "document.create", Payload: createPayload}, nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	m := res.(map[string]any)
	fileID, _ := m["file_id"].(string)
	if fileID == "" {
		t.Fatalf("create returned no file_id: %v", m)
	}

	// target now exists and is accessible
	allowed, exists := a.CanAccessTarget(app, fileID)
	if !exists || !allowed {
		t.Fatalf("CanAccessTarget(created)=%v,%v want true,true", allowed, exists)
	}
	if _, exists := a.CanAccessTarget(app, "nope"); exists {
		t.Fatalf("CanAccessTarget(missing) exists=true want false")
	}

	// append
	appendPayload, _ := json.Marshal(map[string]any{"text": "line two"})
	if _, err := a.Act(ctx, app, appsplatform.ActionRequest{Action: "document.append", Target: fileID, Payload: appendPayload}, nil); err != nil {
		t.Fatalf("append: %v", err)
	}

	// read single document metadata
	got, err := a.Read(ctx, app, appsplatform.ReadRequest{Kind: "document", Target: fileID})
	if err != nil {
		t.Fatalf("read document: %v", err)
	}
	if dm, ok := got.(docMeta); !ok || dm.Name != "Notes" {
		t.Fatalf("read document meta=%#v", got)
	}

	// list
	listed, err := a.Read(ctx, app, appsplatform.ReadRequest{Kind: "list"})
	if err != nil {
		t.Fatalf("read list: %v", err)
	}
	docs := listed.(map[string]any)["documents"].([]docMeta)
	if len(docs) != 1 {
		t.Fatalf("list returned %d docs want 1", len(docs))
	}
}

func TestRunToolRequiresDeclaration(t *testing.T) {
	a := newAdapter(t)
	app := testApp()
	ctx := context.Background()

	ok, _ := json.Marshal(map[string]any{"tool": "summarize"})
	if _, err := a.Act(ctx, app, appsplatform.ActionRequest{Action: "tool.run", Payload: ok}, nil); err != nil {
		t.Fatalf("declared tool.run: %v", err)
	}
	bad, _ := json.Marshal(map[string]any{"tool": "rm-rf"})
	if _, err := a.Act(ctx, app, appsplatform.ActionRequest{Action: "tool.run", Payload: bad}, nil); err == nil {
		t.Fatalf("undeclared tool.run: expected error")
	}
}

func TestUnsupportedAction(t *testing.T) {
	a := newAdapter(t)
	if _, err := a.Act(context.Background(), testApp(), appsplatform.ActionRequest{Action: "nope"}, nil); err == nil {
		t.Fatalf("expected error for unsupported action")
	}
}
