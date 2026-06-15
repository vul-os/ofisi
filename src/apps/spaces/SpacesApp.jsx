/**
 * SpacesApp — Vulos Spaces surface: channels, DMs, threads.
 * Routes: /spaces  /spaces/:channelId
 *
 * Channel sidebar (public/private channels + DMs) + ChannelView message pane.
 * Backed by the CRDT message store (OFFICE-60); REST/poll presence live via
 * useRestPresence (OFFICE-62 — heartbeat + roster, 15 s interval).
 *
 * Design pass: rebuilt against `src/components/ui/*` primitives (Sidebar,
 * Input, Modal, Button) and the warm-paper / single-teal-accent tokens —
 * matches the DocsEditor + CommentsPanel revamp.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Hash, Lock, AtSign, Plus, Users, Search, ChevronDown, ChevronRight,
} from 'lucide-react'
import ChannelView from './ChannelView.jsx'
import { api } from '../../lib/api.js'
import { STATUS_ONLINE } from '@vulos/relay-client/presence'
import { PresenceDot, StatusPicker } from '../../components/PresenceBar.jsx'
import { Button, IconButton, Input, Modal, Sidebar } from '../../components/ui'

// ---------------------------------------------------------------------------
// useRestPresence — OFFICE-62 REST/poll presence (replaces fabric stub)
//
// Polls GET /api/spaces/presence/roster every 15 s.
// Sends POST /api/spaces/presence/heartbeat every 15 s.
// Returns { roster, setStatus } where roster has the presencePeer shape:
//   { accountId, displayName, status, statusText, color, online }
// ---------------------------------------------------------------------------

const PRESENCE_COLORS = [
  '#0f6a6c', '#4f7a4d', '#c08436', '#b8453a', '#4a6b8a', '#6e5b8a',
  '#7a5a3d', '#3d6b5a', '#6a3d6a', '#8a6a2a',
]

function colorFromUserID(userID) {
  if (!userID) return PRESENCE_COLORS[0]
  let h = 0
  for (let i = 0; i < userID.length; i++) {
    h = ((h << 5) - h + userID.charCodeAt(i)) | 0
  }
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length]
}

function useRestPresence() {
  const [roster, setRoster] = useState([])
  const statusRef = useRef({ status: 'online', text: '' })

  const doHeartbeat = useCallback(async () => {
    try {
      await api.spacesHeartbeat(
        statusRef.current.status,
        statusRef.current.text,
        '',
      )
    } catch {
      // network error — silent, will retry
    }
  }, [])

  const doRoster = useCallback(async () => {
    try {
      const entries = await api.spacesGetRoster()
      const peers = (entries || []).map((e) => ({
        accountId: e.user_id,
        displayName: e.display_name || e.user_id,
        status: e.status || 'online',
        statusText: e.status_text || '',
        color: colorFromUserID(e.user_id),
        online: true,
      }))
      setRoster(peers)
    } catch {
      // network error — keep existing roster
    }
  }, [])

  useEffect(() => {
    // Immediate on mount
    doHeartbeat()
    doRoster()

    const hbInterval = setInterval(doHeartbeat, 15000)
    const rosterInterval = setInterval(doRoster, 15000)

    return () => {
      clearInterval(hbInterval)
      clearInterval(rosterInterval)
    }
  }, [doHeartbeat, doRoster])

  const setStatus = useCallback((status, text = '') => {
    statusRef.current = { status, text }
    // Send immediately so the change is reflected without waiting for the next tick.
    api.spacesHeartbeat(status, text, '').catch(() => {})
  }, [])

  return { roster, setStatus }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ChannelIcon({ type, size = 14, className = '' }) {
  if (type === 'dm') return <AtSign size={size} className={`text-accent ${className}`} />
  if (type === 'private') return <Lock size={size} className={`text-warning ${className}`} />
  return <Hash size={size} className={`text-ink-faint ${className}`} />
}

// ---------------------------------------------------------------------------
// CreateChannelModal
// ---------------------------------------------------------------------------

function CreateChannelModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [type, setType] = useState('public')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const n = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (!n) return
    setLoading(true)
    setError(null)
    try {
      const ch = await api.spacesCreateChannel(n, type)
      onCreated(ch)
      onClose()
    } catch (err) {
      setError(err.message || 'Create failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create a channel">
      <form onSubmit={submit}>
        <Modal.Body className="space-y-4">
          {error && (
            <p className="text-xs text-danger bg-danger-bg rounded-sm px-3 py-2">{error}</p>
          )}
          <Input
            label="Name"
            placeholder="e.g. team-design"
            value={name}
            onChange={(e) => setName(e.target.value)}
            leading={<Hash size={13} />}
            autoFocus
          />
          <div>
            <label className="block text-xs text-ink-muted font-medium mb-1.5 tracking-tightish">
              Type
            </label>
            <div className="flex gap-2">
              {[
                { v: 'public',  label: 'Public',  hint: 'Anyone can join' },
                { v: 'private', label: 'Private', hint: 'Invite only' },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setType(o.v)}
                  className={[
                    'flex-1 text-left rounded-md border px-3 py-2 transition-colors duration-fast ease-out',
                    type === o.v
                      ? 'border-accent bg-accent-tint text-ink'
                      : 'border-line hover:border-line-strong text-ink-muted',
                  ].join(' ')}
                >
                  <div className="text-sm font-medium tracking-tightish">{o.label}</div>
                  <div className="text-2xs text-ink-faint">{o.hint}</div>
                </button>
              ))}
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create channel'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// NewDMModal
// ---------------------------------------------------------------------------

function NewDMModal({ open, onClose, onCreated }) {
  const [recipient, setRecipient] = useState('')
  // NAME-CAPTURE-01: optionally name the person you're inviting so the roster
  // shows their name instead of their account id/email. Sent as member_names.
  const [recipientName, setRecipientName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const r = recipient.trim()
    if (!r) return
    setLoading(true)
    setError(null)
    try {
      const dmName = ['me', r].sort().join('-')
      const memberNames = recipientName.trim() ? { [r]: recipientName.trim() } : null
      const ch = await api.spacesCreateChannel(dmName, 'dm', ['me', r], memberNames)
      onCreated(ch)
      setRecipient('')
      setRecipientName('')
      onClose()
    } catch (err) {
      setError(err.message || 'Create failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New direct message">
      <form onSubmit={submit}>
        <Modal.Body className="space-y-4">
          {error && (
            <p className="text-xs text-danger bg-danger-bg rounded-sm px-3 py-2">{error}</p>
          )}
          <Input
            label="To"
            placeholder="account id, e.g. alice"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            leading={<AtSign size={13} />}
            autoFocus
          />
          <Input
            label="Their name (optional)"
            placeholder="e.g. Jane Doe"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            leading={<Users size={13} />}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={loading || !recipient.trim()}>
            {loading ? 'Opening…' : 'Open DM'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// DisplayNameModal — "your display name" profile control
// ---------------------------------------------------------------------------

// NAME-CAPTURE-01: lets the signed-in member set their own display name in the
// active channel on first join. Calls PUT /spaces/channels/:id/members/me/name
// which routes through the office-local SetDisplayName seam.
function DisplayNameModal({ open, onClose, channelId, onSaved }) {
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!channelId) return
    setLoading(true)
    setError(null)
    try {
      await api.spacesSetMyName(channelId, displayName.trim())
      if (onSaved) onSaved()
      onClose()
    } catch (err) {
      setError(err.message || 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Your display name">
      <form onSubmit={submit}>
        <Modal.Body className="space-y-4">
          {error && (
            <p className="text-xs text-danger bg-danger-bg rounded-sm px-3 py-2">{error}</p>
          )}
          <p className="text-2xs text-ink-faint">
            How you appear to others in this channel. Leave blank to show your
            account id.
          </p>
          <Input
            label="Display name"
            placeholder="e.g. Jane Doe"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            leading={<Users size={13} />}
            autoFocus
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={loading || !channelId}>
            {loading ? 'Saving…' : 'Save name'}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SpacesSidebar({
  channels, activeId, onSelect, onRefresh,
  roster, localStatus, localStatusText, onSetStatus,
}) {
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [showNewDM, setShowNewDM] = useState(false)
  const [showDisplayName, setShowDisplayName] = useState(false)
  const [channelsOpen, setChannelsOpen] = useState(true)
  const [dmsOpen, setDmsOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [showStatusPicker, setShowStatusPicker] = useState(false)

  const publicChannels = channels.filter((c) => c.type !== 'dm')
  const dms = channels.filter((c) => c.type === 'dm')

  const filtered = (list) =>
    search ? list.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())) : list

  function SectionToggle({ label, open, onToggle, onAdd, addTitle }) {
    return (
      <div className="flex items-center justify-between pl-2 pr-1 pt-1 pb-1 group">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 text-2xs font-semibold text-ink-faint uppercase tracking-eyebrow hover:text-ink-muted transition-colors"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {label}
        </button>
        <button
          onClick={onAdd}
          title={addTitle}
          aria-label={addTitle}
          className="opacity-0 group-hover:opacity-100 rounded-xs p-0.5 text-ink-faint hover:text-ink hover:bg-accent-tint transition-[opacity,background,color] duration-fast"
        >
          <Plus size={12} />
        </button>
      </div>
    )
  }

  function ChannelRow({ channel }) {
    const isActive = channel.id === activeId
    const dmPeer = channel.type === 'dm'
      ? roster.find((p) => !p.isSelf && channel.name.includes(p.displayName || p.accountId))
      : null
    return (
      <button
        type="button"
        onClick={() => onSelect(channel)}
        className={[
          'relative flex items-center gap-2 h-7 pl-3 pr-2 rounded-md text-left',
          'transition-colors duration-fast ease-out',
          isActive
            ? 'bg-paper text-ink shadow-e1'
            : 'text-ink-muted hover:bg-accent-tint hover:text-ink',
        ].join(' ')}
      >
        <span
          aria-hidden
          className={[
            'absolute left-0 top-1 bottom-1 w-[2px] rounded-r-full',
            isActive ? 'bg-accent' : 'bg-transparent',
          ].join(' ')}
        />
        <span className="relative flex-shrink-0">
          <ChannelIcon type={channel.type} />
          {dmPeer && (
            <span className="absolute -bottom-0.5 -right-0.5">
              <PresenceDot status={dmPeer.status} size={6} />
            </span>
          )}
        </span>
        <span className="truncate text-sm tracking-tightish">{channel.name}</span>
      </button>
    )
  }

  const peersOnline = roster.filter((p) => !p.isSelf)

  return (
    <Sidebar collapsed={false} className="w-60">
      {/* Search */}
      <div className="px-2 pt-3 pb-2 border-b border-line">
        <Input
          size="sm"
          placeholder="Find channel…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          leading={<Search size={12} />}
        />
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5">
        <SectionToggle
          label="Channels"
          open={channelsOpen}
          onToggle={() => setChannelsOpen(!channelsOpen)}
          onAdd={() => setShowCreateChannel(true)}
          addTitle="Create channel"
        />
        {channelsOpen && filtered(publicChannels).map((ch) => (
          <ChannelRow key={ch.id} channel={ch} />
        ))}

        <div className="mt-3" />
        <SectionToggle
          label="Direct Messages"
          open={dmsOpen}
          onToggle={() => setDmsOpen(!dmsOpen)}
          onAdd={() => setShowNewDM(true)}
          addTitle="New direct message"
        />
        {dmsOpen && filtered(dms).map((ch) => (
          <ChannelRow key={ch.id} channel={ch} />
        ))}

        {filtered(publicChannels).length === 0 &&
          filtered(dms).length === 0 &&
          search && (
            <p className="text-2xs text-ink-faint px-3 py-2 font-serif italic">
              No channels found.
            </p>
        )}
      </div>

      {/* Presence footer */}
      <Sidebar.Footer>
        {peersOnline.length > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-2xs text-ink-faint">
            <Users size={11} />
            <span className="font-medium text-ink-muted">
              {peersOnline.length} online
            </span>
            <div className="flex flex-wrap gap-1 ml-1">
              {peersOnline.slice(0, 5).map((p) => (
                <span
                  key={p.accountId}
                  className="flex items-center gap-1 bg-bg-elev2 border border-line rounded-pill px-1.5 py-0.5 text-ink-muted"
                  title={p.statusText ? `${p.displayName} — ${p.statusText}` : p.displayName}
                >
                  <PresenceDot status={p.status} size={6} />
                  <span className="truncate max-w-[60px]">{p.displayName}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setShowStatusPicker((v) => !v)}
            className="w-full flex items-center gap-2 h-8 px-3 rounded-md text-ink-muted hover:bg-accent-tint hover:text-ink transition-colors duration-fast ease-out"
          >
            <PresenceDot status={localStatus} size={8} />
            <span className="text-xs truncate tracking-tightish">
              {localStatusText || localStatus || STATUS_ONLINE}
            </span>
          </button>
          {showStatusPicker && (
            <StatusPicker
              currentStatus={localStatus}
              currentText={localStatusText}
              onStatusChange={onSetStatus}
              onClose={() => setShowStatusPicker(false)}
            />
          )}
        </div>

        {/* NAME-CAPTURE-01: set your own display name in the active channel. */}
        <button
          type="button"
          onClick={() => setShowDisplayName(true)}
          disabled={!activeId}
          title={activeId ? 'Set your display name' : 'Open a channel first'}
          className="w-full flex items-center gap-2 h-8 px-3 rounded-md text-ink-muted hover:bg-accent-tint hover:text-ink transition-colors duration-fast ease-out disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Users size={12} />
          <span className="text-xs truncate tracking-tightish">Set your name</span>
        </button>
      </Sidebar.Footer>

      <CreateChannelModal
        open={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        onCreated={(ch) => { onRefresh(); onSelect(ch) }}
      />
      <NewDMModal
        open={showNewDM}
        onClose={() => setShowNewDM(false)}
        onCreated={(ch) => { onRefresh(); onSelect(ch) }}
      />
      <DisplayNameModal
        open={showDisplayName}
        onClose={() => setShowDisplayName(false)}
        channelId={activeId}
        onSaved={onRefresh}
      />
    </Sidebar>
  )
}

// ---------------------------------------------------------------------------
// SpacesApp — root component
// ---------------------------------------------------------------------------

export default function SpacesApp() {
  const { channelId } = useParams()
  const navigate = useNavigate()
  const [channels, setChannels] = useState([])
  const [activeChannel, setActiveChannel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // OFFICE-62: REST/poll presence (replaced fabric-null stub).
  const { roster, setStatus: setRestStatus } = useRestPresence()
  const [localStatus, setLocalStatus] = useState(STATUS_ONLINE)
  const [localStatusText, setLocalStatusText] = useState('')

  function handleSetStatus(status, text) {
    setLocalStatus(status)
    setLocalStatusText(text)
    setRestStatus(status, text)
  }

  const currentUser = 'me'

  const loadChannels = useCallback(async () => {
    try {
      const chs = await api.spacesListChannels()
      setChannels(chs || [])
      return chs || []
    } catch (e) {
      setError(e.message || 'Failed to load channels')
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChannels().then((chs) => {
      if (channelId) {
        const found = chs.find((c) => c.id === channelId)
        if (found) setActiveChannel(found)
      } else if (chs.length > 0) {
        setActiveChannel(chs[0])
        navigate(`/spaces/${chs[0].id}`, { replace: true })
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function selectChannel(ch) {
    setActiveChannel(ch)
    navigate(`/spaces/${ch.id}`)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-danger text-sm bg-bg">
        {error}
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0 bg-bg">
      <SpacesSidebar
        channels={channels}
        activeId={activeChannel?.id}
        onSelect={selectChannel}
        onRefresh={loadChannels}
        roster={roster}
        localStatus={localStatus}
        localStatusText={localStatusText}
        onSetStatus={handleSetStatus}
      />
      <ChannelView
        channel={activeChannel}
        currentUser={currentUser}
        roster={roster}
      />
    </div>
  )
}
