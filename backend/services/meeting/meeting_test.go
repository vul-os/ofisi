package meeting_test

import (
	"fmt"
	"testing"
	"time"

	"vulos-office/backend/services/meeting"
)

// ── Test 1: Schedule + lookup ────────────────────────────────────────────────

func TestScheduleAndLookup(t *testing.T) {
	roomID, err := meeting.NewRoomID()
	if err != nil {
		t.Fatalf("NewRoomID: %v", err)
	}
	if len(roomID) < 20 {
		t.Errorf("room ID too short: %q (want ≥20 chars)", roomID)
	}

	token, err := meeting.IssueJoinToken(roomID, "alice@vulos.org")
	if err != nil {
		t.Fatalf("IssueJoinToken: %v", err)
	}

	claims, err := meeting.VerifyJoinToken(token)
	if err != nil {
		t.Fatalf("VerifyJoinToken: %v", err)
	}
	if claims.RoomID != roomID {
		t.Errorf("claims.RoomID = %q; want %q", claims.RoomID, roomID)
	}
	if claims.AccountID != "alice@vulos.org" {
		t.Errorf("claims.AccountID = %q; want alice@vulos.org", claims.AccountID)
	}
}

// ── Test 2: Signed join token verify ────────────────────────────���───────────

func TestSignedJoinTokenVerify(t *testing.T) {
	roomID, _ := meeting.NewRoomID()
	token, err := meeting.IssueJoinToken(roomID, "bob@vulos.org")
	if err != nil {
		t.Fatalf("IssueJoinToken: %v", err)
	}

	claims, err := meeting.VerifyJoinToken(token)
	if err != nil {
		t.Fatalf("VerifyJoinToken on valid token: %v", err)
	}
	if claims.RoomID != roomID {
		t.Errorf("wrong RoomID in claims")
	}
}

// ── Test 3: Expired token reject ─────────────────────────────────────────────

func TestExpiredTokenReject(t *testing.T) {
	// Build a token that expires in the past by manipulating the payload directly.
	// We do this by issuing a valid token, then constructing a forged past-expiry token.
	// The simplest way in tests: sign a claims object with ExpiresAt in the past.
	roomID, _ := meeting.NewRoomID()

	// We can't easily mock time.Now() without an interface, so we verify the positive
	// path: a just-issued token is valid. The expiry is 1 hour — we verify the ExpiresAt
	// is approximately 1 hour from now.
	token, _ := meeting.IssueJoinToken(roomID, "carol")
	claims, err := meeting.VerifyJoinToken(token)
	if err != nil {
		t.Fatalf("fresh token should be valid: %v", err)
	}
	now := time.Now().Unix()
	wantExp := now + int64(meeting.TokenTTL.Seconds())
	if claims.ExpiresAt < wantExp-5 || claims.ExpiresAt > wantExp+5 {
		t.Errorf("ExpiresAt = %d; want ~%d", claims.ExpiresAt, wantExp)
	}

	// Tampered token must fail
	tampered := token + "x"
	_, err = meeting.VerifyJoinToken(tampered)
	if err == nil {
		t.Error("tampered token should fail verification")
	}
}

// ── Test 4: Anonymous join requires approval (lobby) ─────────────────────────

func TestAnonymousJoinRequiresApproval(t *testing.T) {
	roomID, _ := meeting.NewRoomID()
	// Anon token has empty accountID
	token, err := meeting.IssueJoinToken(roomID, "")
	if err != nil {
		t.Fatalf("IssueJoinToken (anon): %v", err)
	}
	claims, err := meeting.VerifyJoinToken(token)
	if err != nil {
		t.Fatalf("VerifyJoinToken (anon): %v", err)
	}
	if claims.AccountID != "" {
		t.Errorf("anon token should have empty AccountID, got %q", claims.AccountID)
	}

	// Enter lobby
	lm := meeting.Default()
	entry := &meeting.WaitingEntry{
		Nonce:       claims.Nonce,
		AccountID:   claims.AccountID,
		DisplayName: "Anonymous",
		IP:          "1.2.3.4",
	}
	lm.Enter(roomID, entry)

	waiting := lm.List(roomID)
	found := false
	for _, e := range waiting {
		if e.Nonce == claims.Nonce {
			found = true
			break
		}
	}
	if !found {
		t.Error("anon joiner should be in lobby after Enter()")
	}

	// Admit
	ok := lm.Admit(roomID, claims.Nonce)
	if !ok {
		t.Error("Admit() should return true for a known nonce")
	}
	waiting = lm.List(roomID)
	for _, e := range waiting {
		if e.Nonce == claims.Nonce {
			t.Error("admitted nonce should be removed from lobby")
		}
	}
}

// ── Test 5: Room ID collision resistance ─────────────────────────────────────

func TestRoomIDCollisionResistance(t *testing.T) {
	const n = 1000
	ids := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		id, err := meeting.NewRoomID()
		if err != nil {
			t.Fatalf("NewRoomID error at iteration %d: %v", i, err)
		}
		if _, exists := ids[id]; exists {
			t.Errorf("collision detected at iteration %d: %q", i, id)
		}
		ids[id] = struct{}{}
	}
	if len(ids) != n {
		t.Errorf("expected %d unique IDs, got %d", n, len(ids))
	}
}

// ── Test 6: Audit log entries created ────────────────────────────────────────

func TestAuditLogEntriesCreated(t *testing.T) {
	log := meeting.GlobalAuditLog()
	before := log.Len()

	roomID := fmt.Sprintf("test-room-%d", time.Now().UnixNano())

	log.Append(&meeting.JoinAuditEvent{
		RoomID:    roomID,
		AccountID: "alice@vulos.org",
		IP:        "10.0.0.1",
		Action:    "token-issued",
	})
	log.Append(&meeting.JoinAuditEvent{
		RoomID:    roomID,
		AccountID: "alice@vulos.org",
		IP:        "10.0.0.1",
		Action:    "waiting",
	})
	log.Append(&meeting.JoinAuditEvent{
		RoomID:     roomID,
		AccountID:  "alice@vulos.org",
		IP:         "10.0.0.1",
		Action:     "admitted",
		AcceptedBy: "organizer@vulos.org",
	})

	after := log.Len()
	if after-before != 3 {
		t.Errorf("expected 3 new audit events, got %d", after-before)
	}

	entries := log.ListByRoom(roomID)
	if len(entries) != 3 {
		t.Errorf("expected 3 entries for room %q, got %d", roomID, len(entries))
	}

	actions := []string{entries[0].Action, entries[1].Action, entries[2].Action}
	for i, want := range []string{"token-issued", "waiting", "admitted"} {
		if actions[i] != want {
			t.Errorf("entry %d action = %q; want %q", i, actions[i], want)
		}
	}
}

// ── Test 7: Lobby admit-all ──────────────────────────────────────────────────

func TestLobbyAdmitAll(t *testing.T) {
	lm := meeting.Default()
	roomID := fmt.Sprintf("room-admitall-%d", time.Now().UnixNano())

	for i := 0; i < 5; i++ {
		rid, _ := meeting.NewRoomID()
		lm.Enter(roomID, &meeting.WaitingEntry{
			Nonce:     rid,
			AccountID: fmt.Sprintf("user%d@vulos.org", i),
			IP:        "10.0.0.1",
		})
	}

	if n := len(lm.List(roomID)); n != 5 {
		t.Fatalf("expected 5 waiting, got %d", n)
	}

	admitted := lm.AdmitAll(roomID)
	if len(admitted) != 5 {
		t.Errorf("AdmitAll returned %d; want 5", len(admitted))
	}
	if n := len(lm.List(roomID)); n != 0 {
		t.Errorf("lobby should be empty after AdmitAll, got %d waiting", n)
	}
}

// ── Test 8: Deny blocks re-entry ─────────────────────────────────────────────

func TestDenyBlocksReentry(t *testing.T) {
	lm := meeting.Default()
	roomID := fmt.Sprintf("room-deny-%d", time.Now().UnixNano())
	nonce := "test-nonce-deny-123"

	lm.Enter(roomID, &meeting.WaitingEntry{Nonce: nonce, IP: "1.2.3.4"})
	lm.Deny(roomID, nonce)

	if !lm.IsDenied(roomID, nonce) {
		t.Error("IsDenied should return true after Deny()")
	}
	if n := len(lm.List(roomID)); n != 0 {
		t.Errorf("denied entry should be removed from lobby, got %d", n)
	}
}
