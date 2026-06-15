package handlers

import (
	"encoding/json"
	"log"
	"net/http"

	"vulos-office/backend/audit"
	"vulos-office/backend/models"
	"vulos-office/backend/storage"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type FileHandler struct {
	store storage.Storage
	authz *FileAuthz
	audit audit.Store
}

func NewFileHandler(store storage.Storage) *FileHandler {
	return &FileHandler{store: store, authz: SharedFileAuthz(), audit: SharedAuditStore()}
}

// NewFileHandlerWithAuthz builds a handler over a caller-supplied authorizer
// (tests use an in-memory NullStore so they never touch disk). The audit store
// defaults to the shared one; use NewFileHandlerWithAudit to inject it.
func NewFileHandlerWithAuthz(store storage.Storage, authz *FileAuthz) *FileHandler {
	return &FileHandler{store: store, authz: authz, audit: SharedAuditStore()}
}

// NewFileHandlerWithAudit builds a handler over caller-supplied authorizer +
// audit store (tests).
func NewFileHandlerWithAudit(store storage.Storage, authz *FileAuthz, aud audit.Store) *FileHandler {
	return &FileHandler{store: store, authz: authz, audit: aud}
}

func (h *FileHandler) List(c *gin.Context) {
	files, err := h.store.ListFiles()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Return only the files the caller may access (owned + shared). Unowned/
	// legacy files (no recorded owner) remain visible so local/OSS mode and
	// pre-ACL documents keep working; admins see everything.
	out := make([]*models.File, 0, len(files))
	for _, f := range files {
		if h.authz.canAccess(c, f.ID) {
			out = append(out, f)
		}
	}
	c.JSON(http.StatusOK, out)
}

func (h *FileHandler) Get(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	file, err := h.store.GetFile(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	c.JSON(http.StatusOK, file)
}

func (h *FileHandler) Create(c *gin.Context) {
	var req models.CreateFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	file := &models.File{
		ID:      uuid.New().String(),
		Name:    req.Name,
		Type:    req.Type,
		Content: req.Content,
	}

	if err := h.store.CreateFile(file); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Record the creating identity as owner so the file is private by default.
	h.authz.recordOwner(c, file.ID)

	// Async write-through to org bucket when content is present.
	if file.Content != nil {
		if contentBytes, err := json.Marshal(file.Content); err == nil {
			if err := SharedBucketStore().PutObject(requesterID(c), "file/"+file.ID, contentBytes, "application/json"); err != nil {
				log.Printf("[files] bucket sync create file=%s: %v (SQLite is primary — continuing)", file.ID, err)
			}
		}
	}

	c.JSON(http.StatusCreated, file)
}

func (h *FileHandler) Update(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	var req models.UpdateFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	file := &models.File{
		ID:      id,
		Name:    req.Name,
		Content: req.Content,
	}

	if err := h.store.UpdateFile(file); err != nil {
		if err.Error() == "file not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	updated, _ := h.store.GetFile(file.ID)

	// Sync updated content blob to bucket (SQLite is still the primary source).
	if file.Content != nil {
		if contentBytes, err := json.Marshal(file.Content); err == nil {
			if err := SharedBucketStore().PutObject(requesterID(c), "file/"+id, contentBytes, "application/json"); err != nil {
				log.Printf("[files] bucket sync update file=%s: %v (SQLite is primary — continuing)", id, err)
			}
		}
	}

	c.JSON(http.StatusOK, updated)
}

func (h *FileHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	if err := h.store.DeleteFile(id); err != nil {
		if err.Error() == "file not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Drop ACL state for the deleted file.
	_ = h.authz.Store().Delete(id)

	// Best-effort removal from the org bucket (ignore error — bucket object
	// may not exist if S3 was not configured when the file was created).
	if err := SharedBucketStore().DeleteObject(requesterID(c), "file/"+id); err != nil {
		log.Printf("[files] bucket sync delete file=%s: %v (ignoring)", id, err)
	}

	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// Share grants another account access to a file the caller owns (or admin).
// POST /api/files/:id/share  { "account_id": "...", "revoke": false }
func (h *FileHandler) Share(c *gin.Context) {
	id := c.Param("id")
	if !h.authz.require(c, id) {
		return
	}
	// Verify the file actually exists before recording a share.
	if _, err := h.store.GetFile(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	var req struct {
		AccountID string `json:"account_id" binding:"required"`
		Revoke    bool   `json:"revoke"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var err error
	if req.Revoke {
		err = h.authz.Store().Unshare(id, req.AccountID)
	} else {
		err = h.authz.Store().Share(id, req.AccountID)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Append-only audit of the ACL change (grantee recorded in the detail).
	action := audit.ActionACLGrant
	if req.Revoke {
		action = audit.ActionACLRevoke
	}
	recordAudit(h.audit, requesterID(c), action, id, "grantee="+req.AccountID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
