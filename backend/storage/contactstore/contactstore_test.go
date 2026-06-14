package contactstore_test

// contactstore_test.go — account-isolation proofs for the durable contact store.
//
// These tests prove:
//   1. Account A cannot list Account B's contacts.
//   2. Account A cannot fetch Account B's contact by UID.
//   3. Account A cannot delete Account B's contact.
//   4. Unowned contacts are visible to everyone (OSS fail-safe).
//   5. Admins bypass ownership.
//   6. Duplicate detection is scoped to the calling account.

import (
	"testing"
	"time"

	"vulos-office/backend/storage/contactstore"
)

func newStore(t *testing.T) *contactstore.Store {
	t.Helper()
	s, err := contactstore.New(":memory:")
	if err != nil {
		t.Fatalf("contactstore.New: %v", err)
	}
	return s
}

func putContact(t *testing.T, s *contactstore.Store, uid, accountID, email string) {
	t.Helper()
	now := time.Now().UTC()
	err := s.Put(&contactstore.Contact{
		UID:       uid,
		AccountID: accountID,
		FullName:  "Test Person",
		Emails:    []contactstore.Email{{Address: email}},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("Put(%s, %s): %v", uid, accountID, err)
	}
}

// TestIsolation_ListDoesNotLeakCrossTenant — alice's contact must not appear in bob's list.
func TestIsolation_ListDoesNotLeakCrossTenant(t *testing.T) {
	s := newStore(t)
	putContact(t, s, "alice-c1", "alice@vulos.org", "alice-secret@example.com")

	contacts := s.List("bob@vulos.org", false)
	for _, c := range contacts {
		if c.UID == "alice-c1" {
			t.Fatalf("VULN: alice's contact leaked into bob's list")
		}
	}
}

// TestIsolation_GetDoesNotLeakCrossTenant — bob cannot fetch alice's contact.
func TestIsolation_GetDoesNotLeakCrossTenant(t *testing.T) {
	s := newStore(t)
	putContact(t, s, "alice-c2", "alice@vulos.org", "alice@example.com")

	c, ok := s.Get("alice-c2", "bob@vulos.org", false)
	if ok || c != nil {
		t.Fatalf("VULN: bob fetched alice's contact: %+v", c)
	}
}

// TestIsolation_DeleteDoesNotCrossTenant — bob cannot delete alice's contact.
func TestIsolation_DeleteDoesNotCrossTenant(t *testing.T) {
	s := newStore(t)
	putContact(t, s, "alice-c3", "alice@vulos.org", "alice@example.com")

	deleted := s.Delete("alice-c3", "bob@vulos.org", false)
	if deleted {
		t.Fatal("VULN: bob deleted alice's contact")
	}
	// Alice's contact must still be there.
	c, ok := s.Get("alice-c3", "alice@vulos.org", false)
	if !ok || c == nil {
		t.Fatal("alice's contact missing after non-owner delete attempt")
	}
}

// TestIsolation_OwnerCanReadAndDelete — the owner has full access.
func TestIsolation_OwnerCanReadAndDelete(t *testing.T) {
	s := newStore(t)
	putContact(t, s, "alice-c4", "alice@vulos.org", "alice@example.com")

	c, ok := s.Get("alice-c4", "alice@vulos.org", false)
	if !ok || c == nil {
		t.Fatal("owner cannot fetch own contact")
	}

	deleted := s.Delete("alice-c4", "alice@vulos.org", false)
	if !deleted {
		t.Fatal("owner cannot delete own contact")
	}
}

// TestIsolation_AdminBypassesOwnership — admins see all contacts.
func TestIsolation_AdminBypassesOwnership(t *testing.T) {
	s := newStore(t)
	putContact(t, s, "alice-c5", "alice@vulos.org", "alice@example.com")

	c, ok := s.Get("alice-c5", "admin@vulos.org", true)
	if !ok || c == nil {
		t.Fatal("admin cannot fetch alice's contact")
	}

	contacts := s.List("admin@vulos.org", true)
	found := false
	for _, ct := range contacts {
		if ct.UID == "alice-c5" {
			found = true
		}
	}
	if !found {
		t.Fatal("admin list did not include alice's contact")
	}
}

// TestIsolation_UnownedContactVisible — an unowned contact (empty account_id)
// is the OSS fail-safe and is visible to any caller.
func TestIsolation_UnownedContactVisible(t *testing.T) {
	s := newStore(t)
	putContact(t, s, "legacy-c", "", "legacy@example.com")

	c, ok := s.Get("legacy-c", "bob@vulos.org", false)
	if !ok || c == nil {
		t.Fatal("unowned/legacy contact must be visible to any caller")
	}
}

// TestIsolation_DupDetectionScopedToAccount — alice's dup emails must not
// surface in bob's dup scan.
func TestIsolation_DupDetectionScopedToAccount(t *testing.T) {
	s := newStore(t)
	// Alice has two contacts sharing an email.
	putContact(t, s, "alice-d1", "alice@vulos.org", "shared@example.com")
	putContact(t, s, "alice-d2", "alice@vulos.org", "shared@example.com")
	// Bob has no contacts.

	dups := s.DupsByEmail("bob@vulos.org", false)
	for _, uids := range dups {
		for _, uid := range uids {
			if uid == "alice-d1" || uid == "alice-d2" {
				t.Fatal("VULN: alice's dup email leaked into bob's dup scan")
			}
		}
	}

	// Alice's scan must find the dup.
	dups = s.DupsByEmail("alice@vulos.org", false)
	found := false
	for _, uids := range dups {
		if len(uids) >= 2 {
			found = true
		}
	}
	if !found {
		t.Fatal("alice's dup scan did not find duplicate email contacts")
	}
}
