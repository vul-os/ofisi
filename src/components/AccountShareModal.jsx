/**
 * AccountShareModal — account-based sharing for an Office document.
 *
 * Wires the backend account-share ACL (POST /files/:id/share, GET
 * /files/:id/collaborators, Unshare) to a real, owner-only share UI. This is the
 * NAMED-USER path: you share a document to a specific Vulos account/email and
 * pick their role. It is COMPLEMENTARY to the P2P E2E link path (P2PShareModal),
 * which shares content-blind to anyone holding the link.
 *
 * Role model (matches fileacl on the server):
 *   • viewer    — read only.
 *   • commenter — read + comment (the comment endpoints), but no content edits.
 *   • editor    — read + write content.
 *   • owner     — full control (shown, never granted here — an owner can't be
 *                 demoted through this dialog).
 *
 * Security posture (the server is the source of truth — the UI never grants
 * access on its own):
 *   • Every grant / role-change / revoke is owner-gated server-side. A non-owner
 *     who opens this dialog can view the roster but every write returns 403,
 *     which we surface. We ALSO hide the mutating controls when the caller is not
 *     the owner (defence in depth + honest UI), inferred from the collaborator
 *     roster (owner === me).
 *   • The roster comes from the server and reflects only this file's ACL.
 *
 * A11y: rendered through the shared <Modal>, which provides the focus trap,
 * Escape-to-close, and focus restoration. Controls are keyboard-operable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  UserPlus, Eye, MessageSquare, Pencil, Crown, Trash2, Loader2, Users, Link2,
} from 'lucide-react'
import { Modal, Button, Input, Avatar, hueFor, useToast } from './ui'
import { api } from '../lib/api'

// The three grantable roles, in ascending privilege. Owner is intentionally not
// grantable through this dialog.
const ROLES = [
  { value: 'viewer',    label: 'Viewer',    hint: 'Can view',            icon: Eye },
  { value: 'commenter', label: 'Commenter', hint: 'Can view & comment',  icon: MessageSquare },
  { value: 'editor',    label: 'Editor',    hint: 'Can edit',            icon: Pencil },
]

function roleMeta(role) {
  return ROLES.find((r) => r.value === role) || { value: role, label: role, hint: '', icon: Eye }
}

/**
 * AccountShareModal
 *
 * @param {boolean}  open       whether the dialog is shown.
 * @param {function} onClose    close handler.
 * @param {object}   file       { id, name } of the document being shared.
 * @param {string}   me         the caller's account id (from systemInfo). Used to
 *                              detect ownership and prevent self-share.
 * @param {function} onSwitchToLink optional — invoked when the user chooses the
 *                              complementary "share via link" (P2P E2E) path.
 */
export default function AccountShareModal({ open, onClose, file, me = '', onSwitchToLink }) {
  const { showToast, toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [collaborators, setCollaborators] = useState([]) // [{ account_id, role }]
  const [owner, setOwner] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [busy, setBusy] = useState(false) // an add/change/revoke is in flight
  const [error, setError] = useState('')

  const fileId = file?.id

  const refresh = useCallback(async () => {
    if (!fileId) return
    setLoading(true)
    setError('')
    try {
      const res = await api.listFileCollaborators(fileId)
      const list = res?.collaborators || []
      const own = list.find((c) => c.role === 'owner')
      setOwner(own?.account_id || '')
      // Show non-owner collaborators in the editable roster.
      setCollaborators(list.filter((c) => c.role !== 'owner'))
    } catch (e) {
      setError(e.message || 'Could not load collaborators')
    } finally {
      setLoading(false)
    }
  }, [fileId])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  // Ownership drives whether the mutating controls are shown. When the roster
  // records no owner (legacy/local single-user file), treat the caller as the
  // effective owner so local mode keeps working.
  const isOwner = useMemo(() => !owner || owner === me, [owner, me])

  const addCollaborator = async (e) => {
    e?.preventDefault?.()
    const acct = email.trim()
    if (!acct) return
    if (acct.toLowerCase() === (me || '').toLowerCase() || acct === owner) {
      setError('You already own or can access this document.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.shareFile(fileId, acct, role)
      setEmail('')
      await refresh()
      showToast(`Shared with ${acct}`, 'success')
    } catch (err) {
      setError(err.message || 'Could not share')
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (accountId, nextRole) => {
    setBusy(true)
    setError('')
    try {
      await api.shareFile(fileId, accountId, nextRole)
      await refresh()
    } catch (err) {
      setError(err.message || 'Could not change role')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (accountId) => {
    setBusy(true)
    setError('')
    try {
      await api.revokeShare(fileId, accountId)
      await refresh()
      showToast(`Removed ${accountId}`, 'success')
    } catch (err) {
      setError(err.message || 'Could not remove access')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Share “${file?.name || 'document'}”`} size="lg">
      <Modal.Body className="space-y-4">
        <p className="text-xs text-ink-muted leading-relaxed">
          Share this document with people by their Vulos account or email. They
          sign in with their own account and get exactly the access you grant.
        </p>

        {/* Add a collaborator (owner only) */}
        {isOwner && (
          <form className="flex items-stretch gap-2" onSubmit={addCollaborator}>
            <div className="flex-1 min-w-0">
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com or account id"
                aria-label="Account or email to share with"
                leading={<UserPlus size={14} />}
                autoFocus
              />
            </div>
            <label className="sr-only" htmlFor="share-role">Role</label>
            <select
              id="share-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-md border border-line bg-paper text-ink text-xs px-2 focus:outline-none focus-visible:shadow-focus"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !email.trim()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
              Share
            </Button>
          </form>
        )}

        {error && (
          <p className="text-2xs text-danger bg-danger-bg border border-danger/20 rounded-md px-2.5 py-1.5" role="alert">
            {error}
          </p>
        )}

        {/* People with access */}
        <div className="space-y-1">
          <p className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase flex items-center gap-1.5">
            <Users size={11} /> People with access
          </p>
          <div className="rounded-md border border-line divide-y divide-line overflow-hidden">
            {/* Owner row (always shown, never editable) */}
            {owner && (
              <PersonRow
                accountId={owner}
                role="owner"
                isMe={owner === me}
                editable={false}
              />
            )}
            {loading ? (
              <div className="flex items-center gap-2 text-2xs text-ink-faint px-3 py-3 justify-center">
                <Loader2 size={13} className="animate-spin" /> Loading…
              </div>
            ) : collaborators.length === 0 ? (
              <p className="text-2xs text-ink-faint px-3 py-3 text-center">
                {owner ? 'No one else has access yet.' : 'Only you can access this document.'}
              </p>
            ) : (
              collaborators.map((c) => (
                <PersonRow
                  key={c.account_id}
                  accountId={c.account_id}
                  role={c.role}
                  isMe={c.account_id === me}
                  editable={isOwner && !busy}
                  onChangeRole={(r) => changeRole(c.account_id, r)}
                  onRevoke={() => revoke(c.account_id)}
                />
              ))
            )}
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        {onSwitchToLink && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { onClose?.(); onSwitchToLink() }}
            className="mr-auto"
          >
            <Link2 size={13} /> Share via link (P2P)
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>Done</Button>
      </Modal.Footer>
      {toast}
    </Modal>
  )
}

// ─── PersonRow ──────────────────────────────────────────────────────────────
function PersonRow({ accountId, role, isMe, editable, onChangeRole, onRevoke }) {
  const meta = roleMeta(role)
  const RoleIcon = role === 'owner' ? Crown : meta.icon
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <Avatar name={accountId} size={26} color={hueFor(accountId)} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-ink truncate tracking-tightish">
          {accountId}{isMe && <span className="text-ink-faint font-normal"> (you)</span>}
        </p>
        <p className="text-2xs text-ink-faint flex items-center gap-1">
          <RoleIcon size={10} /> {role === 'owner' ? 'Owner' : meta.hint}
        </p>
      </div>
      {role === 'owner' ? (
        <span className="text-2xs text-ink-faint px-2 py-1 flex items-center gap-1">
          <Crown size={11} className="text-warning" /> Owner
        </span>
      ) : editable ? (
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor={`role-${accountId}`}>Role for {accountId}</label>
          <select
            id={`role-${accountId}`}
            value={role}
            onChange={(e) => onChangeRole(e.target.value)}
            className="rounded-md border border-line bg-paper text-ink text-2xs px-1.5 py-1 focus:outline-none focus-visible:shadow-focus"
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button
            onClick={onRevoke}
            aria-label={`Remove ${accountId}`}
            className="p-1 rounded-sm text-ink-faint hover:text-danger hover:bg-danger-bg transition-colors focus:outline-none focus-visible:shadow-focus"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ) : (
        <span className="text-2xs text-ink-faint px-2 py-1 flex items-center gap-1 capitalize">
          <meta.icon size={11} /> {meta.label}
        </span>
      )}
    </div>
  )
}
