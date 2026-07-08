import { selectEndpoint, currentEndpoint, invalidateEndpoint } from '@vulos/relay-client/endpoints'

const API_PREFIX = '/api'

// Resolve the API base URL through the endpoint-failover layer. The selected
// base is a same-origin '' by default, or a cloud/LAN origin when the OS shell
// injects window.__VULOS_ENDPOINTS__. See @vulos/relay-client/endpoints.
async function apiBase() {
  const base = await selectEndpoint()
  return base + API_PREFIX
}

// Build the full URL for an API path using the cached selection synchronously
// (used by callers that need a string URL, e.g. <img src>).
export function apiUrl(path) {
  return currentEndpoint() + API_PREFIX + path
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers }

  // Session is managed via an httpOnly cookie set by the backend on login.
  // credentials: 'include' ensures the browser sends it automatically.
  const base = await apiBase()
  let res
  try {
    res = await fetch(base + path, { ...options, headers, credentials: 'include' })
  } catch (netErr) {
    // Network-level failure (endpoint unreachable): invalidate the selection,
    // re-probe (cloud↔LAN failover), and retry once against the new endpoint.
    invalidateEndpoint()
    const retryBase = (await selectEndpoint({ force: true })) + API_PREFIX
    if (retryBase !== base) {
      res = await fetch(retryBase + path, { ...options, headers, credentials: 'include' })
    } else {
      throw netErr
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    // Attach the HTTP status so callers can branch (e.g. 409 Conflict → reload +
    // reconcile for optimistic concurrency). `...err` carries any extra payload
    // the server sent, e.g. the current file under `current` on a 409.
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status, ...err })
  }
  return res.json()
}

export const api = {
  authStatus: () => request('/auth/status'),
  login: (password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () =>
    request('/auth/logout', { method: 'POST' }),

  // Standalone system surface: honest runtime facts (version, storage backend,
  // auth mode, user count, integration mode, caller identity + admin status).
  systemInfo: () => request('/system/info'),
  // Authenticated self-service password change (per-user credential store).
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  listFiles: () => request('/files'),
  getFile: (id) => request(`/files/${id}`),
  createFile: (name, type, content) =>
    request('/files', { method: 'POST', body: JSON.stringify({ name, type, content }) }),
  // P2 optimistic concurrency: pass the rev the client last read. The server
  // rejects a stale PUT with 409 Conflict (compare-and-swap on rev); `request`
  // surfaces that as an error whose `.status === 409` and `.current` is the
  // newer stored file, so callers can reload + reconcile instead of losing the
  // update. A rev of 0/undefined performs an unconditional (legacy) write.
  updateFile: (id, name, content, rev = 0) =>
    request(`/files/${id}`, { method: 'PUT', body: JSON.stringify({ name, content, rev }) }),
  deleteFile: (id) =>
    request(`/files/${id}`, { method: 'DELETE' }),

  // Parity: file organization — folders / star / trash.
  // moveFile reparents a file and/or toggles star/trash. Any field left
  // undefined is unchanged server-side.
  moveFile: (id, { parentId, starred, trashed } = {}) => {
    const body = {}
    if (parentId !== undefined) body.parent_id = parentId
    if (starred !== undefined) body.starred = starred
    if (trashed !== undefined) body.trashed = trashed
    return request(`/files/${id}/move`, { method: 'POST', body: JSON.stringify(body) })
  },
  listFolders: () => request('/folders'),
  createFolder: (name, parentId = '') =>
    request('/folders', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId }) }),
  updateFolder: (id, patch) =>
    request(`/folders/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  trashFolder: (id, trashed) =>
    request(`/folders/${id}/trash`, { method: 'POST', body: JSON.stringify({ trashed }) }),
  deleteFolder: (id) =>
    request(`/folders/${id}`, { method: 'DELETE' }),

  // Parity: collaborator roster (for @-mention autocomplete).
  listFileCollaborators: (id) => request(`/files/${id}/collaborators`),

  // Parity: in-app notifications (surfaces @-mentions).
  listNotifications: () => request('/notifications'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST' }),

  // OFFICE-08: version history
  listVersions: (id) => request(`/files/${id}/versions`),
  restoreVersion: (id, vid) =>
    request(`/files/${id}/versions/${vid}/restore`, { method: 'POST' }),

  // OFFICE-28: activity feed + named snapshots
  getActivity: (id) => request(`/files/${id}/activity`),
  createNamedSnapshot: (id, label) =>
    request(`/files/${id}/versions`, { method: 'POST', body: JSON.stringify({ label }) }),
  labelVersion: (id, vid, label) =>
    request(`/files/${id}/versions/${vid}/label`, { method: 'PUT', body: JSON.stringify({ label }) }),

  // OFFICE-27: suggestions / track-changes
  listSuggestions: (fileId) => request(`/files/${fileId}/suggestions`),
  createSuggestion: (fileId, kind, authorId, from, to, text) =>
    request(`/files/${fileId}/suggestions`, {
      method: 'POST',
      body: JSON.stringify({ kind, author_id: authorId, from, to, text }),
    }),
  updateSuggestion: (fileId, suggestionId, state, reviewerId = '') =>
    request(`/files/${fileId}/suggestions/${suggestionId}`, {
      method: 'PUT',
      body: JSON.stringify({ state, reviewer_id: reviewerId }),
    }),
  deleteSuggestion: (fileId, suggestionId) =>
    request(`/files/${fileId}/suggestions/${suggestionId}`, { method: 'DELETE' }),

  // OFFICE-26: comments (anchored, threaded, resolvable)
  listComments: (fileId) => request(`/files/${fileId}/comments`),
  createComment: (fileId, anchor, authorId, body, mentions = []) =>
    request(`/files/${fileId}/comments`, { method: 'POST', body: JSON.stringify({ anchor, author_id: authorId, body, mentions }) }),
  updateComment: (fileId, commentId, patch) =>
    request(`/files/${fileId}/comments/${commentId}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteComment: (fileId, commentId) =>
    request(`/files/${fileId}/comments/${commentId}`, { method: 'DELETE' }),
  createReply: (fileId, commentId, authorId, body, mentions = []) =>
    request(`/files/${fileId}/comments/${commentId}/replies`, { method: 'POST', body: JSON.stringify({ author_id: authorId, body, mentions }) }),
  updateReply: (fileId, commentId, replyId, patch) =>
    request(`/files/${fileId}/comments/${commentId}/replies/${replyId}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteReply: (fileId, commentId, replyId) =>
    request(`/files/${fileId}/comments/${commentId}/replies/${replyId}`, { method: 'DELETE' }),

  scanLocalFiles: () => request('/local-files'),
  localFileUrl: (path) => apiUrl(`/local-files/serve?path=${encodeURIComponent(path)}`),

  // Admin: invite-token issuance + audit log (admin scope required; non-admins
  // receive 403).
  adminMintInvite: ({ note = '', maxUses = 1, ttlHours = 168 } = {}) =>
    request('/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ note, max_uses: maxUses, ttl_hours: ttlHours }),
    }),
  adminListInvites: () => request('/admin/invites'),
  adminRevokeInvite: (id) => request(`/admin/invites/${id}`, { method: 'DELETE' }),
  adminListAudit: (limit = 200) => request(`/admin/audit?limit=${limit}`),

  // Registration consuming an invite/registration token (header-gated).
  register: (accountId, password, token = '') =>
    request('/auth/register', {
      method: 'POST',
      headers: token ? { 'X-Registration-Token': token } : {},
      body: JSON.stringify({ account_id: accountId, password }),
    }),

  // OFFICE-41: signing envelope CRUD
  listEnvelopes: () => request('/envelopes'),
  getEnvelope: (id) => request(`/envelopes/${id}`),
  createEnvelope: (env) =>
    request('/envelopes', { method: 'POST', body: JSON.stringify(env) }),
  updateEnvelope: (id, env) =>
    request(`/envelopes/${id}`, { method: 'PUT', body: JSON.stringify(env) }),
  deleteEnvelope: (id) =>
    request(`/envelopes/${id}`, { method: 'DELETE' }),

  // OFFICE-45: orchestration — status, remind, cancel, decline
  envelopeStatus: (envelopeId) => request(`/sign/${envelopeId}/status`),
  envelopeRemind: (envelopeId) =>
    request(`/sign/${envelopeId}/remind`, { method: 'POST', body: '{}' }),
  envelopeCancel: (envelopeId) =>
    request(`/sign/${envelopeId}/cancel`, { method: 'POST', body: '{}' }),
  signerDecline: (token) =>
    request(`/sign/${token}/decline`, { method: 'POST', body: '{}' }),

  // OFFICE-46: sealed PDF download URL (use as <a href> or window.open)
  sealedPDFUrl: (envelopeId) => apiUrl(`/sign/${envelopeId}/download`),

  // OFFICE-47: verify a sealed PDF by envelope id
  verifyEnvelope: (envelopeId) =>
    request('/sign/verify', {
      method: 'POST',
      body: JSON.stringify({ envelope_id: envelopeId }),
    }),

  // OFFICE-47: server public key for independent token verification
  signingPublicKey: () => request('/sign/pubkey'),

  // Docs export: returns a Blob for download (PDF or DOCX)
  exportDoc: async (fileId, format) => {
    const base = await apiBase()
    const res = await fetch(`${base}/files/${fileId}/export?format=${encodeURIComponent(format)}`, {
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`Export failed: ${res.statusText}`)
    return res.blob()
  },

  uploadImage: async (file) => {
    const form = new FormData()
    form.append('file', file)
    const base = await apiBase()
    // Cookie sent automatically via credentials: 'include'.
    const res = await fetch(base + '/upload', { method: 'POST', body: form, credentials: 'include' })
    if (!res.ok) throw new Error('Upload failed')
    return res.json()
  },

  // ── WAVE37: server-mediated collaboration (the CLOUD / account path) ────────
  // These target the public /v1 surface (not /api). The SSE stream URL is built
  // synchronously from the cached endpoint selection so EventSource can consume
  // it; auth rides the same session cookie (withCredentials).

  /** Synchronous /v1 collab SSE stream URL for EventSource. */
  docCollabStreamUrl: (docId) =>
    `${currentEndpoint()}/v1/documents/${encodeURIComponent(docId)}/collab/stream`,

  /** GET the authoritative current CRDT state (late-joiner bootstrap). */
  docCollabState: async (docId) => {
    const res = await fetch(
      `${currentEndpoint()}/v1/documents/${encodeURIComponent(docId)}/collab/state`,
      { credentials: 'include' },
    )
    if (!res.ok) throw new Error(`collab state failed: ${res.statusText}`)
    return res.json()
  },

  /**
   * POST a batch of CRDT ops (and/or a snapshot) to the server relay. Rejected
   * with 403 for a viewer/commenter (editor-gated). Returns {ok, accepted, seq}.
   */
  docCollabPublish: async (docId, { origin, ops, snap }) => {
    const res = await fetch(
      `${currentEndpoint()}/v1/documents/${encodeURIComponent(docId)}/collab/ops`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ origin, ops, snap }),
      },
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw Object.assign(new Error(err.error || 'collab publish failed'), { status: res.status, ...err })
    }
    return res.json()
  },
}
