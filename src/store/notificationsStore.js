import { create } from 'zustand'
import { api } from '../lib/api'

// notificationsStore — in-app @-mention notifications for the current account.
// The server only ever returns the caller's OWN notifications, so there is no
// cross-account exposure here.
export const useNotificationsStore = create((set, get) => ({
  items: [],
  loading: false,

  fetch: async () => {
    set({ loading: true })
    try {
      const items = await api.listNotifications()
      set({ items: items || [], loading: false })
    } catch {
      set({ loading: false })
    }
  },

  unreadCount: () => get().items.filter((n) => !n.read).length,

  markRead: async (id) => {
    // Optimistic: flip locally, then persist.
    set({ items: get().items.map((n) => (n.id === id ? { ...n, read: true } : n)) })
    try { await api.markNotificationRead(id) } catch { /* best-effort */ }
  },

  markAllRead: async () => {
    set({ items: get().items.map((n) => ({ ...n, read: true })) })
    try { await api.markAllNotificationsRead() } catch { /* best-effort */ }
  },
}))
