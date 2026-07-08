import { create } from 'zustand'
import { api } from '../lib/api'
import { writeDraft, clearDraft } from '../lib/draftStore'

function defaultContent(type) {
  switch (type) {
    case 'doc':
      return { type: 'doc', content: [{ type: 'paragraph' }] }
    case 'sheet':
      return [{ name: 'Sheet1', celldata: [], config: {} }]
    case 'slide':
      return { theme: 'black', transition: 'slide', slides: [{ id: crypto.randomUUID(), title: '', content: '<p></p>', notes: '' }] }
    default:
      return null
  }
}

// Per-file save state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
// Stored as a plain map outside Zustand to avoid excessive re-renders in editors
// that only care about their own file's state.
const saveStateListeners = new Map() // id -> Set<fn>
const saveStates = new Map()         // id -> { status, error }

export function getSaveState(id) {
  return saveStates.get(id) || { status: 'idle', error: null }
}

export function onSaveStateChange(id, fn) {
  if (!saveStateListeners.has(id)) saveStateListeners.set(id, new Set())
  saveStateListeners.get(id).add(fn)
  return () => saveStateListeners.get(id).delete(fn)
}

function setSaveState(id, status, error = null) {
  saveStates.set(id, { status, error })
  const listeners = saveStateListeners.get(id)
  if (listeners) listeners.forEach((fn) => fn({ status, error }))
}

export const useFilesStore = create((set, get) => ({
  files: [],
  loading: false,

  fetchFiles: async () => {
    set({ loading: true })
    try {
      const files = await api.listFiles()
      set({ files, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  createFile: async (name, type) => {
    const file = await api.createFile(name, type, defaultContent(type))
    set({ files: [file, ...get().files] })
    return file
  },

  /**
   * updateFile — save with optimistic concurrency (P2).
   *
   * Sends the rev this client last saw for the file. If a concurrent editor
   * already advanced it the server replies 409 Conflict with the newer stored
   * file (err.current). We then:
   *   1. adopt the newer file into the store (so the UI/state has the latest rev
   *      + content), and
   *   2. retry ONCE with the newer rev, re-applying THIS caller's `content`.
   * This turns a would-be silent lost-update into a clean last-writer-wins with
   * a preserved version history — no PUT is dropped. If the retry also conflicts
   * (a third writer raced in) we surface the conflict so the caller can reload.
   *
   * For CRDT docs the `content` handed in is already the locally-converged truth,
   * so the retry re-commits it cleanly; for non-CRDT structure the caller may
   * prefer to inspect err.current and surface a "reloaded newer version" notice —
   * pass { onConflict } to intercept before the automatic retry.
   */
  updateFile: async (id, name, content, opts = {}) => {
    const known = get().files.find((f) => f.id === id)
    const rev = opts.rev ?? known?.rev ?? 0
    try {
      const file = await api.updateFile(id, name, content, rev)
      set({ files: get().files.map((f) => (f.id === id ? file : f)) })
      return file
    } catch (err) {
      if (err?.status !== 409) throw err
      // Adopt the server's newer file so state carries the latest rev + content.
      const current = err.current
      if (current) set({ files: get().files.map((f) => (f.id === id ? current : f)) })
      if (opts.onConflict) {
        // Let the caller reconcile non-CRDT structure explicitly (may re-throw).
        const resolved = await opts.onConflict(current, content)
        if (resolved === false) { const e = new Error('save conflict'); e.status = 409; e.current = current; throw e }
      }
      if (opts._retried || !current) {
        const e = new Error('save conflict'); e.status = 409; e.current = current; throw e
      }
      // Retry once against the newer rev, re-applying this caller's content.
      return get().updateFile(id, name, content, { rev: current.rev, _retried: true, onConflict: opts.onConflict })
    }
  },

  deleteFile: async (id) => {
    await api.deleteFile(id)
    set({ files: get().files.filter((f) => f.id !== id) })
  },

  renameFile: async (id, name) => {
    const file = get().files.find((f) => f.id === id)
    if (file) await get().updateFile(id, name, file.content)
  },

  /**
   * Crash-safe save:
   *  1. Mark dirty in save state.
   *  2. Persist draft to IndexedDB BEFORE the network write.
   *  3. Attempt network write; on success clear draft + mark saved.
   *  4. On failure keep draft, mark error, and throw so callers can retry.
   */
  saveFileWithDraft: async (id, name, content) => {
    setSaveState(id, 'saving')
    // Write draft first — survives a tab-close mid-flight
    await writeDraft(id, name, content)
    try {
      // Route through the rev-aware updateFile so a concurrent editor's save
      // triggers the 409 reload+reconcile+retry path instead of a lost update.
      const file = await get().updateFile(id, name, content)
      await clearDraft(id)
      setSaveState(id, 'saved')
      return file
    } catch (err) {
      // Draft survives in IndexedDB; surface error state
      setSaveState(id, 'error', err.message || 'Save failed')
      throw err
    }
  },

  markDirty: (id) => {
    const current = getSaveState(id)
    if (current.status !== 'saving') setSaveState(id, 'dirty')
  },
}))
