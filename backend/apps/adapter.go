// Package apps wires Vulos Office into the shared Vulos Apps & Bots platform
// (github.com/vul-os/vulos-apps, appsplatform). It provides Office's
// ProductAdapter — the small product seam that teaches the product-agnostic
// platform how to act in / read from Office's own surface (documents).
//
// The platform owns authentication (app tokens), token hashing, product
// targeting, and scope enforcement; this adapter owns the Office-native
// semantics and ALWAYS respects Office's existing per-file authorization
// (backend/handlers FileAuthz + backend/fileacl): an installed app acts on
// behalf of its installing OWNER account, so it can touch exactly the documents
// that owner can — never more.
//
//	Act   — a document action/automation on behalf of the app:
//	          document.create   create a new document (doc/sheet/slide)
//	          document.append   append a text block to an existing document
//	          tool.run          dispatch a registered tool/automation (event)
//	          incoming_webhook  inbound hook → append to / create a document
//	Read  — document & list METADATA the app's owner may see:
//	          list / documents  metadata for every accessible document
//	          document          metadata for one document (by id)
//
// Scope/target: writes require apps:write, reads require apps:read, and every
// document-scoped target is gated through FileAuthz.CanAccessAs before the
// platform invokes Act/Read (CanAccessTarget) — and again inside the inbound
// webhook path, which the platform does not pre-check.
package apps

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"vulos-office/backend/handlers"
	"vulos-office/backend/models"
	"vulos-office/backend/storage"

	"github.com/google/uuid"
	"github.com/vul-os/vulos-apps/appsplatform"
)

// OfficeAdapter implements appsplatform.ProductAdapter for Vulos Office.
type OfficeAdapter struct {
	store storage.Storage
	authz *handlers.FileAuthz
}

// NewOfficeAdapter builds the Office product adapter over the active document
// store and the process-wide per-file authorizer.
func NewOfficeAdapter(store storage.Storage, authz *handlers.FileAuthz) *OfficeAdapter {
	return &OfficeAdapter{store: store, authz: authz}
}

// compile-time assertion that the adapter satisfies the platform seam.
var _ appsplatform.ProductAdapter = (*OfficeAdapter)(nil)

// Product reports that this adapter serves the Office product. The platform
// lists and serves only apps that target "office".
func (a *OfficeAdapter) Product() string { return appsplatform.ProductOffice }

// RequiredScope maps an action (Act) or kind (Read) to the scope it needs.
// Reads need apps:read; everything that mutates a document needs apps:write.
// An unknown action falls through to apps:write (fail-safe: deny by default
// unless the app holds the broader write grant).
func (a *OfficeAdapter) RequiredScope(actionOrKind string) string {
	switch actionOrKind {
	case "list", "documents", "document", "metadata":
		return appsplatform.ScopeAppsRead
	default:
		// document.create / document.append / tool.run / incoming_webhook / …
		return appsplatform.ScopeAppsWrite
	}
}

// CanAccessTarget gates an app's access to a document target through Office's
// existing per-file ACL. A target-less action (create / list) is accessible. A
// non-existent file id yields exists=false (the platform returns 404); a file
// the app's owner cannot see yields allowed=false (403). The app acts as its
// installing owner, so this is exactly the file_authz the owner is subject to.
func (a *OfficeAdapter) CanAccessTarget(app *appsplatform.App, target string) (allowed, exists bool) {
	target = strings.TrimSpace(target)
	if target == "" {
		return true, true
	}
	if _, err := a.store.GetFile(target); err != nil {
		return false, false
	}
	return a.authz.CanAccessAs(target, effectiveAccount(app)), true
}

// Act performs an Office document action requested by an app at runtime.
func (a *OfficeAdapter) Act(ctx context.Context, app *appsplatform.App, req appsplatform.ActionRequest, emit appsplatform.EmitFunc) (any, error) {
	switch req.Action {
	case "document.create", "doc.create":
		return a.createDocument(app, req.Payload, emit)
	case "document.append", "doc.append":
		return a.appendDocument(app, req.Target, req.Payload, emit)
	case "tool.run":
		return a.runTool(app, req.Target, req.Payload, emit)
	case "incoming_webhook":
		return a.incoming(app, req.Target, req.Payload, emit)
	default:
		return nil, fmt.Errorf("office: unsupported action %q", req.Action)
	}
}

// Read returns Office document/list METADATA visible to the app's owner.
func (a *OfficeAdapter) Read(ctx context.Context, app *appsplatform.App, req appsplatform.ReadRequest) (any, error) {
	switch req.Kind {
	case "list", "documents":
		return a.listDocuments(app)
	case "document", "metadata":
		return a.documentMeta(req.Target)
	default:
		return nil, fmt.Errorf("office: unsupported read kind %q", req.Kind)
	}
}

// ---- actions ----------------------------------------------------------------

type createPayload struct {
	Name string          `json:"name"`
	Type string          `json:"type"` // doc | sheet | slide (default doc)
	Text string          `json:"text"`
	Body json.RawMessage `json:"content"` // optional pre-built content
}

// createDocument creates a new Office document owned by the app's installer.
func (a *OfficeAdapter) createDocument(app *appsplatform.App, payload json.RawMessage, emit appsplatform.EmitFunc) (any, error) {
	var p createPayload
	_ = json.Unmarshal(payload, &p)

	ft := models.FileType(strings.ToLower(strings.TrimSpace(p.Type)))
	switch ft {
	case models.FileTypeDoc, models.FileTypeSheet, models.FileTypeSlide:
		// ok
	case "":
		ft = models.FileTypeDoc
	default:
		return nil, fmt.Errorf("office: unknown document type %q", p.Type)
	}

	name := strings.TrimSpace(p.Name)
	if name == "" {
		name = "Untitled"
	}

	var content any
	if len(p.Body) > 0 {
		if err := json.Unmarshal(p.Body, &content); err != nil {
			return nil, fmt.Errorf("office: invalid content: %w", err)
		}
	} else if ft == models.FileTypeDoc {
		// Build a minimal ProseMirror/Tiptap doc from the supplied text.
		content = richTextDoc(p.Text)
	}

	file := &models.File{
		ID:      uuid.New().String(),
		Name:    name,
		Type:    ft,
		Content: content,
	}
	if err := a.store.CreateFile(file); err != nil {
		return nil, fmt.Errorf("office: create document: %w", err)
	}
	// Stamp ownership so the new document is private to the app's installer in
	// multi-tenant mode (mirrors FileHandler.Create). Best-effort: on failure
	// remove the row rather than leak an unowned document.
	if err := a.authz.RecordOwnerAs(file.ID, effectiveAccount(app)); err != nil {
		_ = a.store.DeleteFile(file.ID)
		return nil, fmt.Errorf("office: record document ownership: %w", err)
	}

	a.emitTo(emit, app, "document.created", map[string]any{
		"file_id": file.ID, "name": file.Name, "type": string(file.Type),
	})
	return map[string]any{"file_id": file.ID, "name": file.Name, "type": string(file.Type)}, nil
}

type appendPayload struct {
	Text string `json:"text"`
}

// appendDocument appends a text block to an existing rich-text document. The
// platform has already verified the app may access req.Target (CanAccessTarget).
func (a *OfficeAdapter) appendDocument(app *appsplatform.App, target string, payload json.RawMessage, emit appsplatform.EmitFunc) (any, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, fmt.Errorf("office: document.append requires a target document id")
	}
	var p appendPayload
	_ = json.Unmarshal(payload, &p)
	if strings.TrimSpace(p.Text) == "" {
		return nil, fmt.Errorf("office: document.append requires non-empty text")
	}

	file, err := a.store.GetFile(target)
	if err != nil {
		return nil, fmt.Errorf("office: document not found")
	}
	if file.Type != models.FileTypeDoc {
		return nil, fmt.Errorf("office: document.append is only supported for doc files")
	}
	next, ok := appendParagraphs(file.Content, p.Text)
	if !ok {
		return nil, fmt.Errorf("office: document.append requires a rich-text document")
	}

	upd := &models.File{ID: file.ID, Name: file.Name, Content: next}
	if err := a.store.UpdateFile(upd); err != nil {
		return nil, fmt.Errorf("office: append document: %w", err)
	}
	a.emitTo(emit, app, "document.updated", map[string]any{"file_id": file.ID, "name": file.Name})
	return map[string]any{"file_id": file.ID, "appended": true}, nil
}

type toolPayload struct {
	Tool  string          `json:"tool"`
	Input json.RawMessage `json:"input"`
}

// runTool dispatches a registered tool/automation. A "tool" is a name the app
// declared in its slash_commands (the app's registered-tool catalog). The
// platform does not execute arbitrary code; instead it fans a tool.invoked event
// to the app's OWN runtime (webhook / SSE socket-mode), which performs the work
// and may call back via document.create / document.append. This keeps Act honest
// to what the backend actually does — dispatch, not compute.
func (a *OfficeAdapter) runTool(app *appsplatform.App, target string, payload json.RawMessage, emit appsplatform.EmitFunc) (any, error) {
	var p toolPayload
	_ = json.Unmarshal(payload, &p)
	name := strings.ToLower(strings.TrimSpace(p.Tool))
	if name == "" {
		return nil, fmt.Errorf("office: tool.run requires a tool name")
	}
	if !appDeclaresTool(app, name) {
		return nil, fmt.Errorf("office: app does not declare tool %q", name)
	}
	a.emitTo(emit, app, "tool.invoked", map[string]any{
		"tool": name, "target": target, "input": json.RawMessage(p.Input),
	})
	return map[string]any{"ok": true, "tool": name, "status": "dispatched"}, nil
}

type incomingPayload struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

// incoming handles an unauthenticated inbound webhook post. Because the platform
// does NOT pre-check scope or target for incoming webhooks (the webhook id is
// the secret), this path enforces document access itself. When the default
// target names an accessible doc it appends to it; otherwise it creates a new
// note document owned by the app's installer.
func (a *OfficeAdapter) incoming(app *appsplatform.App, target string, payload json.RawMessage, emit appsplatform.EmitFunc) (any, error) {
	var p incomingPayload
	_ = json.Unmarshal(payload, &p)
	if strings.TrimSpace(p.Text) == "" {
		return nil, fmt.Errorf("office: incoming webhook requires a text field")
	}
	target = strings.TrimSpace(target)
	if target != "" {
		if file, err := a.store.GetFile(target); err == nil &&
			file.Type == models.FileTypeDoc &&
			a.authz.CanAccessAs(target, effectiveAccount(app)) {
			return a.appendDocument(app, target, payload, emit)
		}
		// Unknown / inaccessible / non-doc target → fall through to create.
	}
	name := strings.TrimSpace(p.Title)
	if name == "" {
		name = "Incoming note"
	}
	body, _ := json.Marshal(createPayload{Name: name, Type: "doc", Text: p.Text})
	return a.createDocument(app, body, emit)
}

// ---- reads ------------------------------------------------------------------

// docMeta is the secret-free, content-free metadata view of a document.
type docMeta struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func metaOf(f *models.File) docMeta {
	return docMeta{
		ID:        f.ID,
		Name:      f.Name,
		Type:      string(f.Type),
		CreatedAt: f.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		UpdatedAt: f.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}

// listDocuments returns metadata for every document the app's owner can access.
func (a *OfficeAdapter) listDocuments(app *appsplatform.App) (any, error) {
	files, err := a.store.ListFiles()
	if err != nil {
		return nil, fmt.Errorf("office: list documents: %w", err)
	}
	acct := effectiveAccount(app)
	out := make([]docMeta, 0, len(files))
	for _, f := range files {
		if a.authz.CanAccessAs(f.ID, acct) {
			out = append(out, metaOf(f))
		}
	}
	return map[string]any{"documents": out}, nil
}

// documentMeta returns metadata for a single document. The platform has already
// gated access to req.Target via CanAccessTarget before calling Read.
func (a *OfficeAdapter) documentMeta(target string) (any, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return nil, fmt.Errorf("office: document read requires a target document id")
	}
	f, err := a.store.GetFile(target)
	if err != nil {
		return nil, fmt.Errorf("office: document not found")
	}
	return metaOf(f), nil
}

// ---- helpers ----------------------------------------------------------------

// effectiveAccount is the account an app acts as for Office authorization: its
// installing OWNER (so it inherits exactly that account's file access). Apps
// installed without an owner (e.g. the OSS single-user default) fall back to the
// app's synthetic account id.
func effectiveAccount(app *appsplatform.App) string {
	if app != nil && strings.TrimSpace(app.OwnerID) != "" {
		return app.OwnerID
	}
	if app != nil {
		return app.AccountID()
	}
	return "self"
}

// appDeclaresTool reports whether the app registered a tool/command by name.
func appDeclaresTool(app *appsplatform.App, name string) bool {
	for _, c := range app.SlashCommands {
		if strings.EqualFold(c.Name, name) {
			return true
		}
	}
	return false
}

// emitTo fans an event to the originating app only (visibility predicate) so a
// document action notifies the app's own runtime without leaking to others.
func (a *OfficeAdapter) emitTo(emit appsplatform.EmitFunc, app *appsplatform.App, eventType string, payload map[string]any) {
	if emit == nil {
		return
	}
	emit(eventType, payload, func(other *appsplatform.App) bool {
		return other != nil && other.ID == app.ID
	})
}

// richTextDoc builds a minimal ProseMirror/Tiptap "doc" node from plain text,
// one paragraph per line. Empty text yields an empty doc.
func richTextDoc(text string) map[string]any {
	return map[string]any{"type": "doc", "content": paragraphNodes(text)}
}

// paragraphNodes turns text into a slice of paragraph nodes (one per non-empty
// line). It returns an empty (non-nil) slice for empty input.
func paragraphNodes(text string) []any {
	nodes := []any{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		para := map[string]any{"type": "paragraph"}
		if strings.TrimSpace(line) != "" {
			para["content"] = []any{map[string]any{"type": "text", "text": line}}
		}
		nodes = append(nodes, para)
	}
	return nodes
}

// appendParagraphs appends text (as paragraph nodes) to an existing rich-text
// doc value. It accepts the document Content as decoded JSON (map[string]any
// with type:"doc" and a content array) and returns the updated value. ok=false
// when the content is not a recognizable rich-text doc.
func appendParagraphs(content any, text string) (any, bool) {
	doc, ok := content.(map[string]any)
	if !ok {
		return nil, false
	}
	if t, _ := doc["type"].(string); t != "doc" {
		return nil, false
	}
	existing, _ := doc["content"].([]any)
	doc["content"] = append(existing, paragraphNodes(text)...)
	return doc, true
}
