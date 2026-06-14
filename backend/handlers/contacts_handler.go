// contacts_handler.go — VCF import/export and dedup API endpoints.
//
// Routes (all protected):
//
//	POST /api/contacts/import          — import .vcf file (multipart form "file")
//	GET  /api/contacts/export          — export all contacts as .vcf
//	GET  /api/contacts/duplicates      — find potential duplicates
//	POST /api/contacts/merge           — merge two contacts
//
// Storage: backed by the durable, account-scoped contactstore SQLite store.
// Every row is keyed by (uid, account_id) so one tenant can never read or
// mutate another tenant's contacts. Call InitContactStore(dsn) from main()
// before any request handler runs; the default (":memory:") is safe for tests.
package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"vulos-office/backend/services/contacts_vcf"
	"vulos-office/backend/storage/contactstore"
)

// ─── durable store ────────────────────────────────────────────────────────────

// durableContactStore returns the process-wide durable contact store.
func durableContactStore() *contactstore.Store {
	return contactstore.Default()
}

// InitContactStore wires the process-wide contact store to the given SQLite DSN.
// Must be called before any handler runs (e.g. from main). Pass ":memory:" for tests.
func InitContactStore(dsn string) error {
	return contactstore.InitDefault(dsn)
}

// ─── conversion helpers ───────────────────────────────────────────────────────

// vcfToStore converts a contacts_vcf.Contact to a contactstore.Contact.
func vcfToStore(c *contacts_vcf.Contact, accountID string) *contactstore.Contact {
	emails := make([]contactstore.Email, len(c.Emails))
	for i, e := range c.Emails {
		emails[i] = contactstore.Email{Address: e.Address, Label: e.Label}
	}
	phones := make([]contactstore.Phone, len(c.Phones))
	for i, p := range c.Phones {
		phones[i] = contactstore.Phone{Number: p.Number, Label: p.Label}
	}
	// Store the full VCF contact as JSON blob for round-trip fidelity.
	blob, _ := json.Marshal(c)
	return &contactstore.Contact{
		UID:       c.UID,
		AccountID: accountID,
		FullName:  c.DisplayName,
		Emails:    emails,
		Phones:    phones,
		Notes:     c.Notes,
		Blob:      string(blob),
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
	}
}

// storeToVCF converts a contactstore.Contact back to a contacts_vcf.Contact.
// If the blob round-trips cleanly we use it directly; otherwise reconstruct.
func storeToVCF(s *contactstore.Contact) contacts_vcf.Contact {
	// Try the blob first (full round-trip fidelity).
	if s.Blob != "" && s.Blob != "{}" {
		var c contacts_vcf.Contact
		if json.Unmarshal([]byte(s.Blob), &c) == nil && c.UID != "" {
			// Make sure UID and timestamps are correct (overwrite from DB truth).
			c.UID = s.UID
			c.CreatedAt = s.CreatedAt
			c.UpdatedAt = s.UpdatedAt
			return c
		}
	}
	// Fallback: reconstruct from structured columns.
	emails := make([]contacts_vcf.EmailEntry, len(s.Emails))
	for i, e := range s.Emails {
		emails[i] = contacts_vcf.EmailEntry{Address: e.Address, Label: e.Label}
	}
	phones := make([]contacts_vcf.PhoneEntry, len(s.Phones))
	for i, p := range s.Phones {
		phones[i] = contacts_vcf.PhoneEntry{Number: p.Number, Label: p.Label}
	}
	return contacts_vcf.Contact{
		UID:         s.UID,
		DisplayName: s.FullName,
		Notes:       s.Notes,
		Emails:      emails,
		Phones:      phones,
		CreatedAt:   s.CreatedAt,
		UpdatedAt:   s.UpdatedAt,
	}
}

// ─── handler ──────────────────────────────────────────────────────────────────

// ContactsVCFHandler handles VCF import/export and dedup.
type ContactsVCFHandler struct{}

func NewContactsVCFHandler() *ContactsVCFHandler { return &ContactsVCFHandler{} }

// ImportVCF POST /api/contacts/import  multipart "file" field.
func (h *ContactsVCFHandler) ImportVCF(c *gin.Context) {
	file, _, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing file field: " + err.Error()})
		return
	}
	defer file.Close()

	contacts, err := contacts_vcf.Import(file)
	if err != nil && len(contacts) == 0 {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		return
	}

	owner := requesterID(c)
	now := time.Now().UTC()
	var imported []contacts_vcf.Contact
	for _, contact := range contacts {
		if contact.UID == "" {
			contact.UID = uuid.NewString()
		}
		contact.CreatedAt = now
		contact.UpdatedAt = now
		// Stamp the importing identity as owner so the contact is private to them.
		sc := vcfToStore(&contact, owner)
		sc.CreatedAt = now
		sc.UpdatedAt = now
		if putErr := durableContactStore().Put(sc); putErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "storage error"})
			return
		}
		imported = append(imported, contact)
	}

	c.JSON(http.StatusOK, gin.H{
		"imported": len(imported),
		"contacts": imported,
		"warnings": func() string {
			if err != nil {
				return err.Error()
			}
			return ""
		}(),
	})
}

// ExportVCF GET /api/contacts/export?version=4.0
func (h *ContactsVCFHandler) ExportVCF(c *gin.Context) {
	version := c.DefaultQuery("version", "4.0")
	requester, isAdmin := callerScope(c)
	storeContacts := durableContactStore().List(requester, isAdmin)
	contacts := make([]contacts_vcf.Contact, 0, len(storeContacts))
	for _, sc := range storeContacts {
		contacts = append(contacts, storeToVCF(sc))
	}

	data, err := contacts_vcf.Export(contacts, version)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Header("Content-Disposition", `attachment; filename="contacts.vcf"`)
	c.Data(http.StatusOK, "text/vcard; charset=utf-8", data)
}

// DuplicateCandidate is a pair of potentially duplicate contacts.
type DuplicateCandidate struct {
	A      contacts_vcf.Contact `json:"a"`
	B      contacts_vcf.Contact `json:"b"`
	Reason string               `json:"reason"` // "email" or "phone"
}

// FindDuplicates GET /api/contacts/duplicates
func (h *ContactsVCFHandler) FindDuplicates(c *gin.Context) {
	requester, isAdmin := callerScope(c)
	cs := durableContactStore()

	// Use the indexed dup-detection methods on the durable store.
	emailDups := cs.DupsByEmail(requester, isAdmin)
	phoneDups := cs.DupsByPhone(requester, isAdmin)

	seen := map[string]bool{}
	pairKey := func(a, b string) string {
		if a > b {
			a, b = b, a
		}
		return a + ":" + b
	}

	var candidates []DuplicateCandidate
	addPairs := func(uids []string, reason string) {
		for i := 0; i < len(uids); i++ {
			for j := i + 1; j < len(uids); j++ {
				k := pairKey(uids[i], uids[j])
				if seen[k] {
					continue
				}
				seen[k] = true
				a, aok := cs.Get(uids[i], requester, isAdmin)
				b, bok := cs.Get(uids[j], requester, isAdmin)
				if aok && bok {
					candidates = append(candidates, DuplicateCandidate{
						A:      storeToVCF(a),
						B:      storeToVCF(b),
						Reason: reason,
					})
				}
			}
		}
	}

	for _, uids := range emailDups {
		if len(uids) > 1 {
			addPairs(uids, "email")
		}
	}
	for _, uids := range phoneDups {
		if len(uids) > 1 {
			addPairs(uids, "phone")
		}
	}

	c.JSON(http.StatusOK, gin.H{"candidates": candidates})
}

// MergeRequest is the body for POST /api/contacts/merge.
type MergeRequest struct {
	KeepUID   string `json:"keep_uid" binding:"required"`
	DeleteUID string `json:"delete_uid" binding:"required"`
}

// MergeContacts POST /api/contacts/merge
func (h *ContactsVCFHandler) MergeContacts(c *gin.Context) {
	var req MergeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	requester, isAdmin := callerScope(c)
	cs := durableContactStore()

	keepStore, ok1 := cs.Get(req.KeepUID, requester, isAdmin)
	delStore, ok2 := cs.Get(req.DeleteUID, requester, isAdmin)
	// Both contacts must exist and belong to the caller (Get already enforces this).
	if !ok1 || !ok2 {
		c.JSON(http.StatusNotFound, gin.H{"error": "one or both contacts not found"})
		return
	}

	keep := storeToVCF(keepStore)
	del := storeToVCF(delStore)

	// Merge: append missing emails/phones from del into keep.
	emailSet := map[string]bool{}
	for _, e := range keep.Emails {
		emailSet[strings.ToLower(e.Address)] = true
	}
	for _, e := range del.Emails {
		if !emailSet[strings.ToLower(e.Address)] {
			keep.Emails = append(keep.Emails, e)
		}
	}

	phoneSet := map[string]bool{}
	for _, p := range keep.Phones {
		phoneSet[normalisePhone(p.Number)] = true
	}
	for _, p := range del.Phones {
		if !phoneSet[normalisePhone(p.Number)] {
			keep.Phones = append(keep.Phones, p)
		}
	}

	if keep.Notes == "" && del.Notes != "" {
		keep.Notes = del.Notes
	}

	keep.UpdatedAt = time.Now().UTC()

	// Persist the merged contact and delete the source.
	mergedStore := vcfToStore(&keep, requester)
	mergedStore.CreatedAt = keepStore.CreatedAt
	mergedStore.UpdatedAt = keep.UpdatedAt
	if err := cs.Put(mergedStore); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "storage error"})
		return
	}
	cs.Delete(req.DeleteUID, requester, isAdmin)

	c.JSON(http.StatusOK, keep)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func normalisePhone(s string) string {
	var buf bytes.Buffer
	for _, ch := range s {
		if ch >= '0' && ch <= '9' {
			buf.WriteRune(ch)
		}
	}
	return buf.String()
}

// ImportVCFFromBytes is a helper used in tests to import directly from bytes.
func ImportVCFFromBytes(data []byte) ([]contacts_vcf.Contact, error) {
	return contacts_vcf.Import(io.NopCloser(bytes.NewReader(data)))
}
