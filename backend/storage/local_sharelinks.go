package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"vulos-office/backend/models"
)

// Share links are persisted as sharelinks/<token>.json (keyed by token for O(1)
// anonymous view-route lookup). The file id lives inside the record; ListShareLinks
// scans and filters by file id. The plaintext token is the storage key.
//
// The bcrypt password hash MUST be persisted on disk (it is the whole gate), but
// models.ShareLink marks PasswordHash json:"-" so it is never leaked to HTTP
// clients. We therefore serialize through an internal persistedShareLink type
// that DOES include the hash — the "-" tag only governs the API projection, not
// the store's on-disk format.

type persistedShareLink struct {
	ID           string     `json:"id"`
	FileID       string     `json:"file_id"`
	Token        string     `json:"token"`
	CreatedBy    string     `json:"created_by"`
	PasswordHash string     `json:"password_hash"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	Revoked      bool       `json:"revoked"`
	CreatedAt    time.Time  `json:"created_at"`
}

func toPersisted(l *models.ShareLink) persistedShareLink {
	return persistedShareLink{
		ID: l.ID, FileID: l.FileID, Token: l.Token, CreatedBy: l.CreatedBy,
		PasswordHash: l.PasswordHash, ExpiresAt: l.ExpiresAt, Revoked: l.Revoked,
		CreatedAt: l.CreatedAt,
	}
}

func (p persistedShareLink) toModel() *models.ShareLink {
	return &models.ShareLink{
		ID: p.ID, FileID: p.FileID, Token: p.Token, CreatedBy: p.CreatedBy,
		PasswordHash: p.PasswordHash, HasPassword: p.PasswordHash != "",
		ExpiresAt: p.ExpiresAt, Revoked: p.Revoked, CreatedAt: p.CreatedAt,
	}
}

func (s *LocalStorage) shareLinksDir() string {
	return filepath.Join(s.dataDir, "sharelinks")
}

func (s *LocalStorage) shareLinkPath(token string) (string, error) {
	if !validID(token) {
		return "", errInvalidID
	}
	return filepath.Join(s.shareLinksDir(), token+".json"), nil
}

func (s *LocalStorage) CreateShareLink(l *models.ShareLink) error {
	path, err := s.shareLinkPath(l.Token)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.shareLinksDir(), 0755); err != nil {
		return fmt.Errorf("create sharelinks dir: %w", err)
	}
	data, err := json.MarshalIndent(toPersisted(l), "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func (s *LocalStorage) GetShareLinkByToken(token string) (*models.ShareLink, error) {
	path, err := s.shareLinkPath(token)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("share link not found")
		}
		return nil, err
	}
	var p persistedShareLink
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	return p.toModel(), nil
}

func (s *LocalStorage) ListShareLinks(fileID string) ([]*models.ShareLink, error) {
	entries, err := os.ReadDir(s.shareLinksDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var links []*models.ShareLink
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		token := entry.Name()[:len(entry.Name())-5]
		l, err := s.GetShareLinkByToken(token)
		if err != nil {
			continue
		}
		if l.FileID == fileID {
			links = append(links, l)
		}
	}
	sort.Slice(links, func(i, j int) bool {
		return links[i].CreatedAt.After(links[j].CreatedAt)
	})
	return links, nil
}

func (s *LocalStorage) RevokeShareLink(fileID, linkID string) error {
	// linkID may be the record ID; scan the file's links to find its token.
	links, err := s.ListShareLinks(fileID)
	if err != nil {
		return err
	}
	for _, l := range links {
		if l.ID == linkID {
			l.Revoked = true
			path, perr := s.shareLinkPath(l.Token)
			if perr != nil {
				return perr
			}
			data, merr := json.MarshalIndent(toPersisted(l), "", "  ")
			if merr != nil {
				return merr
			}
			return os.WriteFile(path, data, 0644)
		}
	}
	return fmt.Errorf("share link not found")
}
