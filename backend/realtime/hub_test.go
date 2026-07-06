package realtime

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func decode(t *testing.T, frame []byte) Event {
	t.Helper()
	var ev Event
	if err := json.Unmarshal(frame, &ev); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	return ev
}

func TestHub_PublishFansOutPerDoc(t *testing.T) {
	h := NewHub()
	defer h.Close()

	a := h.Subscribe("u", []string{"docA"})
	defer a.Cancel()
	b := h.Subscribe("u", []string{"docB"})
	defer b.Cancel()

	h.Publish(Event{Type: "op", DocID: "docA", Seq: 1})

	select {
	case f := <-a.Frames:
		if ev := decode(t, f); ev.DocID != "docA" || ev.Seq != 1 {
			t.Fatalf("docA sub got wrong frame: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("docA subscriber did not receive its op")
	}

	// docB subscriber must NOT receive docA's op.
	select {
	case f := <-b.Frames:
		t.Fatalf("docB subscriber received a docA op (cross-doc leak): %s", string(f))
	case <-time.After(100 * time.Millisecond):
		// good
	}
}

func TestHub_UnsubscribeClosesStream(t *testing.T) {
	h := NewHub()
	defer h.Close()
	s := h.Subscribe("u", []string{"doc1"})
	if h.SubscriberCount("doc1") != 1 {
		t.Fatalf("expected 1 subscriber, got %d", h.SubscriberCount("doc1"))
	}
	s.Cancel()
	if _, open := <-s.Frames; open {
		t.Fatal("frames channel should be closed after Cancel")
	}
	if h.SubscriberCount("doc1") != 0 {
		t.Fatalf("expected 0 subscribers after cancel, got %d", h.SubscriberCount("doc1"))
	}
}

func TestHub_SlowConsumerIsDropped(t *testing.T) {
	h := NewHub()
	defer h.Close()
	s := h.Subscribe("u", []string{"doc1"})

	// Never drain — overflow the per-sub buffer (subBuffer) so the hub drops it.
	for i := 0; i < subBuffer+50; i++ {
		h.Publish(Event{Type: "op", DocID: "doc1", Seq: uint64(i)})
	}

	// The slow consumer should have been dropped: its stream is closed and it is
	// gone from the doc's subscriber set.
	deadline := time.Now().Add(time.Second)
	for h.SubscriberCount("doc1") != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.SubscriberCount("doc1") != 0 {
		t.Fatal("slow consumer was not dropped (backpressure failed)")
	}
	// Draining the closed channel eventually yields !open.
	sawClose := false
	for {
		select {
		case _, open := <-s.Frames:
			if !open {
				sawClose = true
			}
		case <-time.After(time.Second):
			t.Fatal("dropped subscriber's channel never closed")
		}
		if sawClose {
			break
		}
	}
}

// TestHub_PerUserConnCapRefuses proves the wave-38-style per-user connection cap
// (MaxConnsPerUser): one account may hold at most MaxConnsPerUser live streams;
// the next Subscribe returns nil (the handler turns that into 429). A DIFFERENT
// account is unaffected, and cancelling a connection frees a slot.
func TestHub_PerUserConnCapRefuses(t *testing.T) {
	h := NewHub()
	defer h.Close()

	subs := make([]*Subscription, 0, MaxConnsPerUser)
	for i := 0; i < MaxConnsPerUser; i++ {
		s := h.Subscribe("alice", []string{"doc1"})
		if s == nil {
			t.Fatalf("Subscribe returned nil before the cap at conn %d", i)
		}
		subs = append(subs, s)
	}
	if h.ConnCountForUser("alice") != MaxConnsPerUser {
		t.Fatalf("expected %d conns for alice, got %d", MaxConnsPerUser, h.ConnCountForUser("alice"))
	}
	// One past the cap → refused (nil), fail-closed.
	if over := h.Subscribe("alice", []string{"doc1"}); over != nil {
		over.Cancel()
		t.Fatal("Subscribe should return nil once alice is at MaxConnsPerUser")
	}
	// A different account is not affected by alice's usage.
	if bob := h.Subscribe("bob", []string{"doc1"}); bob == nil {
		t.Fatal("bob (a different account) should not be refused by alice's cap")
	} else {
		bob.Cancel()
	}
	// Cancelling one of alice's frees a slot and lets her reconnect.
	subs[0].Cancel()
	if h.ConnCountForUser("alice") != MaxConnsPerUser-1 {
		t.Fatalf("cancel did not decrement per-user count: got %d", h.ConnCountForUser("alice"))
	}
	if again := h.Subscribe("alice", []string{"doc1"}); again == nil {
		t.Fatal("alice should be able to reconnect after freeing a slot")
	} else {
		again.Cancel()
	}
	for _, s := range subs[1:] {
		s.Cancel()
	}
	if h.ConnCountForUser("alice") != 0 {
		t.Fatalf("expected 0 conns for alice after cleanup, got %d", h.ConnCountForUser("alice"))
	}
}

// TestHub_MaxDocsPerConnBounded proves a single connection cannot register for an
// unbounded number of docs — excess ids past MaxDocsPerConn are ignored.
func TestHub_MaxDocsPerConnBounded(t *testing.T) {
	h := NewHub()
	defer h.Close()
	ids := make([]string, MaxDocsPerConn+50)
	for i := range ids {
		ids[i] = fmt.Sprintf("doc%d", i)
	}
	s := h.Subscribe("alice", ids)
	if s == nil {
		t.Fatal("Subscribe unexpectedly refused")
	}
	defer s.Cancel()
	// The doc past the cap must not have registered a subscriber.
	if got := h.SubscriberCount(ids[MaxDocsPerConn+10]); got != 0 {
		t.Fatalf("doc beyond MaxDocsPerConn registered a subscriber: %d", got)
	}
	// A doc within the cap did register.
	if got := h.SubscriberCount(ids[0]); got != 1 {
		t.Fatalf("doc within MaxDocsPerConn did not register: %d", got)
	}
}

func TestHub_PublishEmptyDocIsNoop(t *testing.T) {
	h := NewHub()
	defer h.Close()
	s := h.Subscribe("u", []string{"doc1"})
	defer s.Cancel()
	h.Publish(Event{Type: "op", DocID: ""}) // no doc id → dropped
	select {
	case f := <-s.Frames:
		t.Fatalf("received a frame for an empty-doc publish: %s", string(f))
	case <-time.After(100 * time.Millisecond):
	}
}
