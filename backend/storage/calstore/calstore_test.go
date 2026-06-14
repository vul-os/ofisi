package calstore_test

// calstore_test.go — account-isolation proofs for the durable calendar store.
//
// These tests prove:
//   1. Account A cannot read Account B's events (no cross-tenant leak).
//   2. Account A cannot delete Account B's events.
//   3. Unowned (empty account_id) events are visible to everyone (OSS fail-safe).
//   4. Admins bypass ownership checks.
//   5. Subscriptions are similarly scoped.

import (
	"testing"
	"time"

	"vulos-office/backend/storage/calstore"
)

func newStore(t *testing.T) *calstore.Store {
	t.Helper()
	s, err := calstore.New(":memory:")
	if err != nil {
		t.Fatalf("calstore.New: %v", err)
	}
	return s
}

func putEvent(t *testing.T, s *calstore.Store, id, accountID string) {
	t.Helper()
	now := time.Now().UTC()
	err := s.Put(&calstore.CalEvent{
		ID:        id,
		AccountID: accountID,
		Title:     "private event",
		Start:     now.Add(time.Hour),
		End:       now.Add(2 * time.Hour),
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("Put(%s, %s): %v", id, accountID, err)
	}
}

// TestIsolation_ListDoesNotLeakCrossTenant — alice's event must not appear in
// bob's list.
func TestIsolation_ListDoesNotLeakCrossTenant(t *testing.T) {
	s := newStore(t)
	now := time.Now().UTC()
	putEvent(t, s, "alice-ev-1", "alice@vulos.org")

	events := s.List(now.Add(-time.Hour), now.Add(24*time.Hour), "", "bob@vulos.org", false)
	for _, e := range events {
		if e.ID == "alice-ev-1" {
			t.Fatalf("VULN: alice's event leaked into bob's list")
		}
	}
}

// TestIsolation_GetDoesNotLeakCrossTenant — bob cannot fetch alice's event.
func TestIsolation_GetDoesNotLeakCrossTenant(t *testing.T) {
	s := newStore(t)
	putEvent(t, s, "alice-ev-2", "alice@vulos.org")

	e, ok := s.Get("alice-ev-2", "bob@vulos.org", false)
	if ok || e != nil {
		t.Fatalf("VULN: bob fetched alice's event: %+v", e)
	}
}

// TestIsolation_DeleteDoesNotCrossTenant — bob cannot delete alice's event.
func TestIsolation_DeleteDoesNotCrossTenant(t *testing.T) {
	s := newStore(t)
	putEvent(t, s, "alice-ev-3", "alice@vulos.org")

	deleted := s.Delete("alice-ev-3", "bob@vulos.org", false)
	if deleted {
		t.Fatal("VULN: bob deleted alice's event")
	}
	// Alice's event must still be there.
	_, ok := s.GetRaw("alice-ev-3")
	if !ok {
		t.Fatal("alice's event missing after non-owner delete attempt")
	}
}

// TestIsolation_OwnerCanReadAndDelete — the owner has full access.
func TestIsolation_OwnerCanReadAndDelete(t *testing.T) {
	s := newStore(t)
	putEvent(t, s, "alice-ev-4", "alice@vulos.org")

	e, ok := s.Get("alice-ev-4", "alice@vulos.org", false)
	if !ok || e == nil {
		t.Fatal("owner cannot fetch own event")
	}

	deleted := s.Delete("alice-ev-4", "alice@vulos.org", false)
	if !deleted {
		t.Fatal("owner cannot delete own event")
	}
}

// TestIsolation_AdminBypassesOwnership — admins see all events.
func TestIsolation_AdminBypassesOwnership(t *testing.T) {
	s := newStore(t)
	putEvent(t, s, "alice-ev-5", "alice@vulos.org")

	e, ok := s.Get("alice-ev-5", "admin@vulos.org", true)
	if !ok || e == nil {
		t.Fatal("admin cannot fetch alice's event")
	}

	now := time.Now().UTC()
	events := s.List(now.Add(-time.Hour), now.Add(24*time.Hour), "", "admin@vulos.org", true)
	found := false
	for _, ev := range events {
		if ev.ID == "alice-ev-5" {
			found = true
		}
	}
	if !found {
		t.Fatal("admin list did not include alice's event")
	}
}

// TestIsolation_UnownedEventVisible — an event with no account_id is the
// OSS fail-safe (pre-auth legacy data) and is visible to everyone.
func TestIsolation_UnownedEventVisible(t *testing.T) {
	s := newStore(t)
	putEvent(t, s, "legacy-ev", "")

	e, ok := s.Get("legacy-ev", "bob@vulos.org", false)
	if !ok || e == nil {
		t.Fatal("unowned/legacy event must be visible to any caller")
	}
}

// TestIsolation_SubscriptionsScoped — alice's subscription must not appear in
// bob's subscription list.
func TestIsolation_SubscriptionsScoped(t *testing.T) {
	s := newStore(t)
	err := s.PutSubscription(&calstore.CalSubscription{
		ID:        "sub-alice",
		AccountID: "alice@vulos.org",
		URL:       "https://cal.example.com/alice.ics",
		Name:      "Alice holiday cal",
		Added:     time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("PutSubscription: %v", err)
	}

	subs := s.ListSubscriptions("bob@vulos.org", false)
	for _, sub := range subs {
		if sub.ID == "sub-alice" {
			t.Fatal("VULN: alice's subscription leaked into bob's list")
		}
	}

	// Alice sees her own.
	subs = s.ListSubscriptions("alice@vulos.org", false)
	found := false
	for _, sub := range subs {
		if sub.ID == "sub-alice" {
			found = true
		}
	}
	if !found {
		t.Fatal("alice cannot see her own subscription")
	}
}

// TestIsolation_ClearOnlyInTests — Clear() empties all rows (used in tests).
func TestIsolation_ClearRemovesAll(t *testing.T) {
	s := newStore(t)
	putEvent(t, s, "ev-a", "a@vulos.org")
	putEvent(t, s, "ev-b", "b@vulos.org")
	s.Clear()
	all := s.AllEvents()
	if len(all) != 0 {
		t.Fatalf("Clear did not remove all events; got %d", len(all))
	}
}
