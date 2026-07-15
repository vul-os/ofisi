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

// Absolutise a same-origin API URL. selectEndpoint() returns '' for same-origin,
// so `base + path` is a relative URL like "/api/files/x". Browsers resolve those
// against location.href, but a bare `fetch()` in a non-DOM context (undici under
// vitest/MSW) throws ERR_INVALID_URL on a relative input. Prefixing the current
// origin keeps the URL identical in the browser while making it always parseable.
function absolutize(url) {
  if (/^https?:\/\//i.test(url)) return url
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
    return location.origin + url
  }
  return url
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers }

  // Session is managed via an httpOnly cookie set by the backend on login.
  // credentials: 'include' ensures the browser sends it automatically.
  const base = await apiBase()
  let res
  try {
    res = await fetch(absolutize(base + path), { ...options, headers, credentials: 'include' })
  } catch (netErr) {
    // Network-level failure (endpoint unreachable): invalidate the selection,
    // re-probe (cloud↔LAN failover), and retry once against the new endpoint.
    invalidateEndpoint()
    const retryBase = (await selectEndpoint({ force: true })) + API_PREFIX
    if (retryBase !== base) {
      res = await fetch(absolutize(retryBase + path), { ...options, headers, credentials: 'include' })
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
  // "Shared with me" — files shared TO the caller by others (owned excluded).
  // Returns { files: [{ id, name, type, owner, role, updated_at, created_at }] }.
  // ACL-safe: the server computes this from the caller's own grants only.
  listSharedWithMe: () => request('/shared-files'),
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

  // Parity: collaborator roster (for @-mention autocomplete AND the account-share
  // dialog). Returns { collaborators: [{ account_id, role }] } — role 'owner' for
  // the file owner, otherwise the granted role (editor|commenter|viewer).
  listFileCollaborators: (id) => request(`/files/${id}/collaborators`),

  // Account-based sharing (owner-only, enforced server-side).
  //   shareFile   — grant/update a named account's role on a file.
  //                 role ∈ {'editor','commenter','viewer'}.
  //   revokeShare — remove a collaborator's access entirely.
  // The server rejects a non-owner caller (403) and an unknown role (400); the
  // UI is a convenience only — access is never granted client-side.
  shareFile: (id, accountId, role) =>
    request(`/files/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, role }),
    }),
  revokeShare: (id, accountId) =>
    request(`/files/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, revoke: true }),
    }),

  // Parity: in-app notifications (surfaces @-mentions).
  listNotifications: () => request('/notifications'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST' }),

  // OFFICE-08: version history
  listVersions: (id) => request(`/files/${id}/versions`),
  restoreVersion: (id, vid) =>
    request(`/files/${id}/versions/${vid}/restore`, { method: 'POST' }),
  // Version diff: compare a version against the current content (default) or the
  // version immediately prior to it. Read-only; server enforces view access.
  // Returns { type, against, old_label, new_label, diff: { kind, lines[], added, removed, summary } }.
  diffVersion: (id, vid, against = 'current') =>
    request(`/files/${id}/versions/${vid}/diff?against=${encodeURIComponent(against)}`),

  // Global full-text search across the caller's ACL-scoped documents (owned +
  // shared). The server extracts + matches text only over files the caller may
  // read, so a result NEVER leaks another account's content. Optional `type`
  // narrows to doc|sheet|slide. Returns { query, results: [{ id, name, type,
  // snippet, owner, shared }] }.
  searchDocs: (query, type = '') => {
    const params = new URLSearchParams({ q: query })
    if (type) params.set('type', type)
    return request(`/search?${params.toString()}`)
  },

  // Expiring / password-protected read-only share links (owner-only management).
  //   createShareLink — mint a link; { password?, expiresInSeconds? }.
  //   listShareLinks  — list a file's links (owner view).
  //   revokeShareLink — kill a link permanently.
  // The anonymous view route (viewShareLink*) needs no auth — the token IS the
  // credential; it returns strictly read-only content.
  listShareLinks: (id) => request(`/files/${id}/share-links`),
  createShareLink: (id, { password = '', expiresInSeconds = 0 } = {}) =>
    request(`/files/${id}/share-links`, {
      method: 'POST',
      body: JSON.stringify({ password, expires_in_seconds: expiresInSeconds }),
    }),
  revokeShareLink: (id, linkId) =>
    request(`/files/${id}/share-links/${linkId}`, { method: 'DELETE' }),
  // Anonymous read-only view of a shared doc by token. viewShareLinkMeta returns
  // { requires_password, ... } (and content when no password). viewShareLink
  // POSTs the password (or nothing) and returns { id, name, type, content, read_only }.
  viewShareLinkMeta: (token) => request(`/share/${encodeURIComponent(token)}`),
  viewShareLink: (token, password = '') =>
    request(`/share/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  // Transfer ownership of a file to another account (owner-only; the previous
  // owner is demoted to editor server-side so they keep access).
  transferOwnership: (id, newOwner) =>
    request(`/files/${id}/transfer-owner`, {
      method: 'POST',
      body: JSON.stringify({ new_owner: newOwner }),
    }),

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
  createComment: (fileId, anchor, authorId, body, mentions = [], assignee = '') =>
    request(`/files/${fileId}/comments`, { method: 'POST', body: JSON.stringify({ anchor, author_id: authorId, body, mentions, assignee }) }),
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

  // NOTE: Office collaboration is peer-to-peer (Yjs over E2E-encrypted WebRTC,
  // see src/lib/crdt/yP2PSession.js). There is deliberately NO server-mediated
  // collab API here — no op relay, no doc-state hub, no server presence. The only
  // server role in collab is content-blind peer discovery (signaling + ICE),
  // handled by @vulos/relay-client against the host's /api/peering/* endpoints.
}
