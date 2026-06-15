// calendar_reminders.go — reminder worker and calendar/subscription handlers.
//
// The reminder worker is a goroutine that polls every minute and fires
// reminders that are due.  It is started by StartReminderWorker() which should
// be called once from main().
//
// Reminder lifecycle:
//  1. Event is created/updated with a Reminders list.
//  2. Worker computes fire time = event.Start − reminder.MinutesBefore.
//  3. When now ≥ fire time AND the reminder has not yet fired, it fires.
//  4. Fired reminders are tracked in firedReminders set (in-memory; resets on
//     restart, which is acceptable — an early reminder is better than none).
//
// Subscriptions (external .ics feeds) are stored in the durable calstore and
// a goroutine fetches them daily.
package handlers

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"vulos-office/backend/storage/calstore"
)

// ─── reminder worker ──────────────────────────────────────────────────────────

// firedKey uniquely identifies a fired reminder so it doesn't double-fire.
// Format: "<eventID>:<minutesBefore>:<channel>"
func firedKey(eventID string, r Reminder) string {
	return fmt.Sprintf("%s:%d:%s", eventID, r.MinutesBefore, r.Channel)
}

var firedMu sync.Mutex
var firedReminders = map[string]bool{}

// NotifyFunc is called by the worker when a reminder fires.  In production this
// would push to the email/push/in-app notification service.
type NotifyFunc func(event *CalEvent, reminder Reminder)

// defaultNotify logs the reminder (swap for real delivery).
func defaultNotify(event *CalEvent, reminder Reminder) {
	log.Printf("REMINDER [%s] event=%q starts=%s channel=%s",
		reminder.Channel, event.Title,
		event.Start.Format(time.RFC3339), reminder.Channel)
}

// StartReminderWorker launches the background goroutine.  It ticks every
// 60 seconds.  Pass a custom NotifyFunc for tests; pass nil to use the default.
func StartReminderWorker(notify NotifyFunc) {
	if notify == nil {
		notify = defaultNotify
	}
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			fireReminders(time.Now().UTC(), notify)
		}
	}()
}

// fireReminders is the core logic — exported so tests can call it directly
// without waiting for the ticker.
func fireReminders(now time.Time, notify NotifyFunc) {
	storeEvents := durableCalStore().AllEvents()

	firedMu.Lock()
	defer firedMu.Unlock()

	for _, s := range storeEvents {
		event := fromStoreEvent(s)
		for _, r := range event.Reminders {
			fireAt := event.Start.Add(-time.Duration(r.MinutesBefore) * time.Minute)
			key := firedKey(event.ID, r)
			if !firedReminders[key] && !now.Before(fireAt) {
				firedReminders[key] = true
				notify(event, r)
			}
		}
	}
}

// ResetFiredReminders is exported for test use — clears the fired set.
func ResetFiredReminders() {
	firedMu.Lock()
	firedReminders = map[string]bool{}
	firedMu.Unlock()
}

// FireRemindersAt is exported for test use — runs the reminder check at an
// arbitrary "now" with a custom notify function.
func FireRemindersAt(now time.Time, notify NotifyFunc) {
	fireReminders(now, notify)
}

// PutCalEvent is exported for test use — inserts an event into the durable store.
func PutCalEvent(e *CalEvent) {
	durableCalStore().Put(toStoreEvent(e)) //nolint:errcheck
}

// DeleteCalEvent is exported for test use — removes an event from the durable store.
func DeleteCalEvent(id string) {
	// Delete regardless of ownership (test helper).
	s := durableCalStore()
	raw, ok := s.GetRaw(id)
	if !ok {
		return
	}
	s.Delete(id, raw.AccountID, true) // isAdmin=true bypasses ownership
}

// ClearCalStore is exported for test use — removes all events.
func ClearCalStore() {
	durableCalStore().Clear()
}

// GetCalEventRaw is exported for test use — returns an event regardless of ownership.
func GetCalEventRaw(id string) (*CalEvent, bool) {
	s, ok := durableCalStore().GetRaw(id)
	if !ok {
		return nil, false
	}
	return fromStoreEvent(s), true
}

// ─── calendar subscription handler ────────────────────────────────────────────

// CalendarSubscribeHandler handles external .ics subscriptions.
type CalendarSubscribeHandler struct{}

func NewCalendarSubscribeHandler() *CalendarSubscribeHandler {
	return &CalendarSubscribeHandler{}
}

// Subscribe POST /api/calendar/subscribe  body: {"url":"https://...", "name":"Holidays"}
func (h *CalendarSubscribeHandler) Subscribe(c *gin.Context) {
	var req struct {
		URL  string `json:"url" binding:"required"`
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// SSRF guard: validate the URL before storing or fetching it.
	// This gives the caller an immediate error rather than a silent drop at
	// first-fetch time, and prevents persisting a known-bad URL.
	if err := checkSSRFURL(req.URL); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "subscription URL not allowed: " + err.Error()})
		return
	}
	sub := &calstore.CalSubscription{
		ID:        uuid.NewString(),
		AccountID: requesterID(c),
		URL:       req.URL,
		Name:      req.Name,
		Added:     time.Now().UTC(),
	}
	if err := durableCalStore().PutSubscription(sub); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "storage error"})
		return
	}

	// Fetch immediately in the background.
	go fetchSubscription(sub)

	c.JSON(http.StatusCreated, sub)
}

// ListSubscriptions GET /api/calendar/subscriptions
func (h *CalendarSubscribeHandler) List(c *gin.Context) {
	requester, isAdmin := callerScope(c)
	subs := durableCalStore().ListSubscriptions(requester, isAdmin)
	c.JSON(http.StatusOK, subs)
}

// StartSubscriptionRefresher refreshes all subscriptions once per day.
func StartSubscriptionRefresher() {
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			subs := durableCalStore().ListSubscriptions("", true) // isAdmin=true → all
			for _, s := range subs {
				fetchSubscription(s)
			}
		}
	}()
}

// ssrfSafeHTTPClient is a package-level client with a custom dialer that
// refuses connections to private/loopback/metadata IP ranges so that a
// user-supplied subscription URL cannot be used to probe internal services.
var ssrfSafeHTTPClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Control: ssrfDialControl,
		}).DialContext,
	},
}

// ssrfAllowedSchemes limits the URL schemes accepted for .ics subscriptions.
var ssrfAllowedSchemes = map[string]bool{"https": true, "http": true}

// checkSSRFURL validates that u is safe to fetch:
//   - scheme must be http or https (no file://, ftp://, etc.)
//   - host must not resolve to a loopback, link-local, private, or AWS-metadata address
//
// This is the pre-dial check; ssrfDialControl is the defence-in-depth post-dial check.
func checkSSRFURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if !ssrfAllowedSchemes[strings.ToLower(u.Scheme)] {
		return fmt.Errorf("URL scheme %q not allowed; use http or https", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("URL has no host")
	}
	// Reject bare IP literals in the URL that map to private ranges.
	if ip := net.ParseIP(host); ip != nil {
		if isPrivateIP(ip) {
			return fmt.Errorf("URL resolves to a private/reserved address")
		}
	}
	return nil
}

// ssrfDialControl is passed as net.Dialer.Control. It fires after DNS
// resolution (so it sees the real IP even for hostnames), and blocks the dial
// if the resolved address is private/loopback/metadata.
func ssrfDialControl(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("could not parse resolved IP %q", host)
	}
	if isPrivateIP(ip) {
		return fmt.Errorf("connection to private/reserved address %s blocked (SSRF guard)", ip)
	}
	return nil
}

// isPrivateIP reports whether ip is in a range that should never be reached by
// a server-side fetch of a user-supplied URL.
func isPrivateIP(ip net.IP) bool {
	ip4 := ip.To4()
	// Loopback (IPv4 127.x.x.x and IPv6 ::1)
	if ip.IsLoopback() {
		return true
	}
	// Link-local (169.254.x.x used by AWS/GCP/Azure instance metadata)
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	// Private RFC-1918 ranges: 10.x, 172.16-31.x, 192.168.x
	if ip4 != nil {
		switch {
		case ip4[0] == 10:
			return true
		case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
			return true
		case ip4[0] == 192 && ip4[1] == 168:
			return true
		// 100.64/10 (Shared Address Space / Tailscale-style)
		case ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127:
			return true
		}
	}
	// Unspecified (0.0.0.0 / ::)
	if ip.IsUnspecified() {
		return true
	}
	return false
}

func fetchSubscription(sub *calstore.CalSubscription) {
	// SSRF guard: pre-validate URL before any dial is attempted.
	if err := checkSSRFURL(sub.URL); err != nil {
		log.Printf("subscription fetch %q blocked: %v", sub.URL, err)
		return
	}
	resp, err := ssrfSafeHTTPClient.Get(sub.URL) //nolint:noctx
	if err != nil {
		log.Printf("subscription fetch %q: %v", sub.URL, err)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("subscription read %q: %v", sub.URL, err)
		return
	}

	events := parseICSFeed(string(body), sub.ID)
	now := time.Now().UTC()
	for i := range events {
		events[i].CreatedAt = now
		events[i].UpdatedAt = now
		// Imported feed events belong to the subscriber — same owner as sub.
		events[i].OwnerID = sub.AccountID
		durableCalStore().Put(toStoreEvent(&events[i])) //nolint:errcheck
	}
	log.Printf("subscription %q: imported %d events", sub.Name, len(events))
}

// parseICSFeed is a minimal ICS parser for subscription feeds.
func parseICSFeed(ics, calID string) []CalEvent {
	var events []CalEvent
	blocks := strings.Split(ics, "BEGIN:VEVENT")
	for _, block := range blocks[1:] {
		uid := fieldValue(block, "UID")
		summary := fieldValue(block, "SUMMARY")
		dtstart := fieldValue(block, "DTSTART")
		dtend := fieldValue(block, "DTEND")
		if uid == "" {
			uid = uuid.NewString()
		}

		start := parseICSTimestamp(dtstart)
		end := parseICSTimestamp(dtend)
		if end.IsZero() {
			end = start.Add(time.Hour)
		}

		events = append(events, CalEvent{
			ID:         uid,
			CalendarID: calID,
			Title:      summary,
			Start:      start,
			End:        end,
		})
	}
	return events
}

func fieldValue(block, key string) string {
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, key+":") || strings.HasPrefix(line, key+";") {
			idx := strings.Index(line, ":")
			if idx >= 0 {
				return strings.TrimSpace(line[idx+1:])
			}
		}
	}
	return ""
}

func parseICSTimestamp(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	// Try compact UTC: 20260601T100000Z
	t, err := time.Parse("20060102T150405Z", s)
	if err == nil {
		return t
	}
	// Try without Z
	t, err = time.Parse("20060102T150405", s)
	if err == nil {
		return t.UTC()
	}
	return time.Time{}
}
