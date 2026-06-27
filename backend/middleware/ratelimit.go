package middleware

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// RateLimiter is a small, dependency-free fixed-window request limiter intended
// for low-volume SENSITIVE endpoints (e.g. self-service password change) to
// blunt brute-force / credential-stuffing — NOT a general traffic shaper.
//
// Each key (client IP by default) may make at most `limit` requests per
// `window`. When the window rolls over the count resets. State is kept in a
// mutex-guarded map; stale entries are pruned opportunistically so memory stays
// bounded for the low-volume endpoints this is meant for.
type RateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rlEntry
	limit   int
	window  time.Duration
	keyFn   func(*gin.Context) string
}

type rlEntry struct {
	count       int
	windowStart time.Time
}

// NewRateLimiter builds a limiter allowing `limit` requests per `window`, keyed
// by client IP.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		entries: make(map[string]*rlEntry),
		limit:   limit,
		window:  window,
		keyFn:   func(c *gin.Context) string { return c.ClientIP() },
	}
}

// allow records an attempt for key and reports whether it is permitted, plus the
// time until the window resets when denied.
func (rl *RateLimiter) allow(key string) (bool, time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	// Opportunistic prune so the map does not grow without bound.
	for k, e := range rl.entries {
		if now.Sub(e.windowStart) >= rl.window {
			delete(rl.entries, k)
		}
	}

	e, ok := rl.entries[key]
	if !ok {
		rl.entries[key] = &rlEntry{count: 1, windowStart: now}
		return true, 0
	}
	if e.count >= rl.limit {
		return false, rl.window - now.Sub(e.windowStart)
	}
	e.count++
	return true, 0
}

// Middleware returns the gin handler enforcing the limit.
func (rl *RateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		ok, retryAfter := rl.allow(rl.keyFn(c))
		if !ok {
			c.Header("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "too many requests; please slow down and try again later",
			})
			return
		}
		c.Next()
	}
}
