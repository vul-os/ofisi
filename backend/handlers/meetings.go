// meetings.go — OFFICE-65: Scheduled meetings + meeting rooms.
//
// Routes (all under /api/meetings, protected by optional auth middleware):
//   POST   /api/meetings              — create a meeting room / schedule
//   GET    /api/meetings              — list all meetings
//   GET    /api/meetings/:id          — get a single meeting
//   PUT    /api/meetings/:id          — update a meeting (organizer only)
//   DELETE /api/meetings/:id          — delete a meeting
//
// A join URL is also exposed publicly so external invitees can navigate
// directly to the room:
//   GET    /api/meetings/:id/join     — resolve meeting + return join metadata

package handlers

import (
	"net/http"
	"strings"
	"time"

	meetingsvc "vulos-office/backend/services/meeting"
	"vulos-office/backend/models"
	"vulos-office/backend/storage"

	"github.com/gin-gonic/gin"
)

// MeetingHandler handles CRUD + join for scheduled meeting rooms.
type MeetingHandler struct {
	store storage.Storage
}

func NewMeetingHandler(store storage.Storage) *MeetingHandler {
	return &MeetingHandler{store: store}
}

// POST /api/meetings
func (h *MeetingHandler) Create(c *gin.Context) {
	var req models.CreateMeetingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Use the same 22-char URL-safe base64 room ID that the join/lobby system
	// expects. This means meetings/:id == the roomId in /api/meet/:roomId/token.
	roomID, err := meetingsvc.NewRoomID()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "room id generation failed"})
		return
	}

	// The session_id is the fabric session key: callers join via createCall({sessionId})
	// in rtc.js. We use /meet/<roomID> as the join link (matching token/lobby routes).
	sessionID := "meeting:" + roomID
	joinLink := "/meet/" + roomID

	invitees := req.Invitees
	if invitees == nil {
		invitees = []string{}
	}

	organizerID := req.OrganizerID
	if organizerID == "" {
		organizerID = c.GetString("userID")
	}
	if organizerID == "" {
		organizerID = c.ClientIP()
	}

	m := &models.Meeting{
		ID:               roomID,
		Title:            strings.TrimSpace(req.Title),
		SessionID:        sessionID,
		HostVulos:        strings.TrimSpace(req.HostVulos),
		Invitees:         invitees,
		ScheduledAt:      req.ScheduledAt,
		DurationMin:      req.DurationMin,
		Status:           models.MeetingStatusScheduled,
		JoinLink:         joinLink,
		OrganizerID:      organizerID,
		LobbyRequired:    req.LobbyRequired,
		SigninRequired:   req.SigninRequired,
		RecordingEnabled: false, // stub — always false
	}

	if err := h.store.CreateMeeting(m); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	meetingsvc.GlobalAuditLog().Append(&meetingsvc.JoinAuditEvent{
		RoomID:    roomID,
		AccountID: organizerID,
		IP:        c.ClientIP(),
		Action:    "scheduled",
		At:        m.CreatedAt,
	})

	c.JSON(http.StatusCreated, m)
}

// GET /api/meetings
// Returns only the meetings the caller is involved in: organizer or invitee.
// Admins (ctx isAdmin=true) see all meetings.
func (h *MeetingHandler) List(c *gin.Context) {
	callerID := c.GetString("userID")
	isAdmin := c.GetBool("isAdmin")

	all, err := h.store.ListMeetings()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var out []*models.Meeting
	for _, m := range all {
		if isAdmin || callerID == "" {
			// Admin or unauthenticated (auth-disabled mode) sees everything.
			out = append(out, m)
			continue
		}
		if m.OrganizerID == callerID {
			out = append(out, m)
			continue
		}
		for _, inv := range m.Invitees {
			if inv == callerID {
				out = append(out, m)
				break
			}
		}
	}
	if out == nil {
		out = []*models.Meeting{}
	}
	c.JSON(http.StatusOK, out)
}

// GET /api/meetings/:id
func (h *MeetingHandler) Get(c *gin.Context) {
	id := c.Param("id")
	m, err := h.store.GetMeeting(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "meeting not found"})
		return
	}
	c.JSON(http.StatusOK, m)
}

// PUT /api/meetings/:id  (organizer only)
func (h *MeetingHandler) Update(c *gin.Context) {
	id := c.Param("id")
	callerID := c.GetString("userID")

	m, err := h.store.GetMeeting(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "meeting not found"})
		return
	}

	if callerID != "" && m.OrganizerID != "" && m.OrganizerID != callerID {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the organizer may update this meeting"})
		return
	}

	var req models.UpdateMeetingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Title != "" {
		m.Title = strings.TrimSpace(req.Title)
	}
	if req.Invitees != nil {
		m.Invitees = req.Invitees
	}
	if req.ScheduledAt != nil {
		m.ScheduledAt = req.ScheduledAt
	}
	if req.DurationMin > 0 {
		m.DurationMin = req.DurationMin
	}
	if req.Status != "" {
		m.Status = models.MeetingStatus(req.Status)
	}
	m.UpdatedAt = time.Now()

	if err := h.store.UpdateMeeting(m); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, m)
}

// DELETE /api/meetings/:id
func (h *MeetingHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	callerID := c.GetString("userID")

	m, err := h.store.GetMeeting(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "meeting not found"})
		return
	}

	// Organizer-only enforcement: if both callerID and OrganizerID are set,
	// they must match. An anonymous/unauthenticated caller (callerID=="") is
	// allowed when OrganizerID is also empty (e.g. test environments).
	if callerID != "" && m.OrganizerID != "" && m.OrganizerID != callerID {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the organizer may delete this meeting"})
		return
	}

	if err := h.store.DeleteMeeting(id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "meeting not found"})
		return
	}

	meetingsvc.GlobalAuditLog().Append(&meetingsvc.JoinAuditEvent{
		RoomID:    id,
		AccountID: callerID,
		IP:        c.ClientIP(),
		Action:    "deleted",
	})

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/meetings/:id/join
// Returns the meeting metadata plus the session_id to pass into createCall.
// This endpoint is intentionally not behind auth so external invitees can join
// via a bare link (the host can implement lobby/admit logic in the Room UI).
func (h *MeetingHandler) Join(c *gin.Context) {
	id := c.Param("id")
	m, err := h.store.GetMeeting(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "meeting not found"})
		return
	}

	// Transition status to active on first join if the meeting is still scheduled
	// and within 15 minutes of its scheduled time (or has no scheduled time).
	if m.Status == models.MeetingStatusScheduled {
		shouldActivate := m.ScheduledAt == nil
		if !shouldActivate && m.ScheduledAt != nil {
			diff := time.Until(*m.ScheduledAt)
			shouldActivate = diff <= 15*time.Minute
		}
		if shouldActivate {
			m.Status = models.MeetingStatusActive
			_ = h.store.UpdateMeeting(m)
		}
	}

	c.JSON(http.StatusOK, models.MeetingJoinResponse{
		Meeting:   m,
		SessionID: m.SessionID,
		JoinLink:  m.JoinLink,
	})
}
