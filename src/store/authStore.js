import { create } from 'zustand'
import { api } from '../lib/api'

// Session tokens are stored exclusively in httpOnly cookies managed by the
// backend. No token is ever written to localStorage — only an opaque
// loggedIn flag is kept in memory for UX purposes.

export const useAuthStore = create((set) => ({
  status: null,
  loading: true,
  error: null,
  remainingAttempts: null,
  // The caller's own account id + admin flag, resolved from /system/info. Used
  // by the account-share dialog (owner detection, self-share guard) and any
  // surface that needs "who am I". null until fetched (or in local single-user
  // mode where it resolves to the shared 'self' identity).
  accountId: null,
  isAdmin: false,

  fetchStatus: async () => {
    try {
      const status = await api.authStatus()
      set({ status, loading: false })
    } catch {
      set({ status: { enabled: false, authenticated: true }, loading: false })
    }
  },

  // Resolve the caller's identity from the server. Best-effort: a failure leaves
  // accountId null, which the share UI treats conservatively (local/owner mode).
  fetchIdentity: async () => {
    try {
      const info = await api.systemInfo()
      set({ accountId: info?.account_id || null, isAdmin: !!info?.is_admin })
    } catch {
      /* identity is optional UX; leave null */
    }
  },

  login: async (password) => {
    set({ error: null, remainingAttempts: null })
    try {
      await api.login(password)
      // The backend sets an httpOnly session cookie on success.
      // We never touch localStorage for tokens.
      set({ status: { enabled: true, authenticated: true }, error: null })
    } catch (err) {
      set({ error: err.error || 'Login failed', remainingAttempts: err.remaining_attempts ?? null })
      throw err
    }
  },

  logout: async () => {
    try { await api.logout() } catch { /* ignore */ }
    // Backend clears the httpOnly cookie. No localStorage cleanup needed.
    set({ status: { enabled: true, authenticated: false }, error: null })
  },
}))
