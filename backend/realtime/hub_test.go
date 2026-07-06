package realtime

import (
	"encoding/json"
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

	a := h.Subscribe([]string{"docA"})
	defer a.Cancel()
	b := h.Subscribe([]string{"docB"})
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
	s := h.Subscribe([]string{"doc1"})
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
	s := h.Subscribe([]string{"doc1"})

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

func TestHub_PublishEmptyDocIsNoop(t *testing.T) {
	h := NewHub()
	defer h.Close()
	s := h.Subscribe([]string{"doc1"})
	defer s.Cancel()
	h.Publish(Event{Type: "op", DocID: ""}) // no doc id → dropped
	select {
	case f := <-s.Frames:
		t.Fatalf("received a frame for an empty-doc publish: %s", string(f))
	case <-time.After(100 * time.Millisecond):
	}
}
