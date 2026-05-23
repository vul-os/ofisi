package meeting

import (
	"net/http"
	"sync"
	"time"
)

// IPRateLimiter is a per-IP sliding-window rate limiter for join validation
// (brute-force protection for /meet/{room_id} and /api/meeting/schedule).
// Window: 60 requests per minute per IP.

const (
	RateLimitWindow   = time.Minute
	RateLimitMaxReqs  = 60
)

type ipState struct {
	ts []time.Time
}

// IPRateLimiter tracks request timestamps per IP.
type IPRateLimiter struct {
	mu      sync.Mutex
	clients map[string]*ipState
}

var globalLimiter = &IPRateLimiter{
	clients: make(map[string]*ipState),
}

// GlobalLimiter returns the process-wide IPRateLimiter.
func GlobalLimiter() *IPRateLimiter { return globalLimiter }

// Allow returns true if the IP is within rate limits.
func (rl *IPRateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	state, ok := rl.clients[ip]
	if !ok {
		state = &ipState{}
		rl.clients[ip] = state
	}

	// Evict timestamps outside the window
	cutoff := now.Add(-RateLimitWindow)
	valid := state.ts[:0]
	for _, t := range state.ts {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	state.ts = valid

	if len(state.ts) >= RateLimitMaxReqs {
		return false
	}
	state.ts = append(state.ts, now)
	return true
}

// Middleware returns a gin-compatible http.HandlerFunc wrapper.
// Usage: r.Use(meeting.GlobalLimiter().GinMiddleware())
func (rl *IPRateLimiter) GinMiddleware() func(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
	return func(w http.ResponseWriter, r *http.Request, next http.HandlerFunc) {
		ip := r.RemoteAddr
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			ip = xff
		}
		if !rl.Allow(ip) {
			http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}
