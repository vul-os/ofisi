/**
 * MessageList — renders a flat list of top-level messages for a channel.
 * Thread replies are surfaced via a "N replies" affordance that the parent
 * ChannelView opens in a right-rail thread panel (CommentsPanel-style).
 *
 * Design pass:
 *   - Date separators in serif italic small-caps with a hairline rule.
 *   - Comfortable message rows: 8px vertical padding, 32px avatar, no hover-flash.
 *   - Own messages get a quiet accent-tint left-rail (subtle).
 *   - Status indicators (edited, deleted) use sage/honey/ink-faint, never green/red.
 */
import { useState } from 'react'
import { MoreHorizontal, MessageSquare, Pencil, Trash2, X, Check } from 'lucide-react'
import { STATE_DELETED, STATE_EDITED } from '../../lib/crdt/messages.js'
import { PresenceDot } from '../../components/PresenceBar.jsx'

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function Avatar({ name, presencePeer, size = 32 }) {
  const initials = (name || '?')[0].toUpperCase()
  // Warm palette tints (no generic indigo/emerald/rose).
  const tints = ['#0f6a6c', '#4f7a4d', '#c08436', '#b8453a', '#4a6b8a', '#6e5b8a']
  const idx = (name?.charCodeAt(0) || 0) % tints.length
  const bg = presencePeer?.color || tints[idx]
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <div
        className="w-full h-full rounded-full flex items-center justify-center text-white text-sm font-semibold tracking-tightish select-none"
        style={{ backgroundColor: bg }}
        title={presencePeer?.statusText
          ? `${presencePeer.displayName} — ${presencePeer.statusText}`
          : presencePeer?.displayName || name}
      >
        {initials}
      </div>
      {presencePeer && (
        <span className="absolute bottom-0 right-0">
          <PresenceDot status={presencePeer.status} size={7} />
        </span>
      )}
    </div>
  )
}

function MessageItem({ msg, replies, onReply, onEdit, onDelete, currentUser, roster = [] }) {
  const [showMenu, setShowMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(msg.body)

  const isOwn = msg.author_id === currentUser
  const isDeleted = msg.state === STATE_DELETED

  function submitEdit() {
    if (editBody.trim() && editBody.trim() !== msg.body) {
      onEdit(msg.id, editBody.trim())
    }
    setEditing(false)
  }

  const presencePeer = roster.find(
    (p) => p.accountId === msg.author_id || p.displayName === msg.author_id,
  )

  return (
    <div
      className={[
        'group relative flex gap-3 px-4 py-2 transition-colors duration-fast ease-out',
        isOwn ? 'hover:bg-accent-tint/60' : 'hover:bg-bg-elev2',
      ].join(' ')}
    >
      {/* Own-message accent left rail */}
      {isOwn && (
        <span
          aria-hidden
          className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-accent/40"
        />
      )}

      <Avatar name={msg.author_id} presencePeer={presencePeer} />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm text-ink tracking-tightish">
            {msg.author_id}
          </span>
          <span className="text-2xs text-ink-faint">{formatTime(msg.created_at)}</span>
          {msg.state === STATE_EDITED && (
            <span className="text-2xs text-ink-faint italic">edited</span>
          )}
        </div>

        {isDeleted ? (
          <p className="text-sm text-ink-faint italic font-serif">
            This message was deleted.
          </p>
        ) : editing ? (
          <div className="mt-1 flex gap-2 items-end">
            <textarea
              className="flex-1 bg-paper border border-accent rounded-sm px-2 py-1.5 text-sm resize-none outline-none focus:shadow-focus text-ink"
              rows={2}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit() }
                if (e.key === 'Escape') setEditing(false)
              }}
              autoFocus
            />
            <button
              type="button"
              onClick={submitEdit}
              className="p-1.5 rounded-sm bg-accent text-white hover:bg-accent-hover transition-colors"
              title="Save"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="p-1.5 rounded-sm bg-bg-elev2 text-ink-muted border border-line hover:bg-paper transition-colors"
              title="Cancel"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink whitespace-pre-wrap break-words leading-snug">
            {msg.body}
          </p>
        )}

        {/* Thread affordance */}
        {replies.length > 0 && !isDeleted && (
          <button
            type="button"
            onClick={() => onReply(msg)}
            className="mt-1.5 inline-flex items-center gap-1.5 text-2xs text-accent hover:text-accent-press font-medium tracking-tightish transition-colors"
          >
            <MessageSquare size={11} />
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </button>
        )}

        {!isDeleted && replies.length === 0 && (
          <button
            type="button"
            onClick={() => onReply(msg)}
            className="mt-1 inline-flex items-center gap-1 text-2xs text-ink-faint hover:text-accent opacity-0 group-hover:opacity-100 transition-[opacity,color] duration-fast ease-out"
          >
            <MessageSquare size={11} /> Reply in thread
          </button>
        )}
      </div>

      {/* Own-message context menu */}
      {isOwn && !isDeleted && (
        <div className="relative flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-fast">
          <button
            type="button"
            onClick={() => setShowMenu(!showMenu)}
            className="p-1 rounded-sm text-ink-faint hover:text-ink hover:bg-accent-tint transition-colors"
            title="More"
            aria-label="Message actions"
          >
            <MoreHorizontal size={14} />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-7 z-10 bg-paper border border-line rounded-md shadow-e2 py-1 min-w-[140px] animate-scale-in">
              <button
                type="button"
                onClick={() => { setEditing(true); setEditBody(msg.body); setShowMenu(false) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-ink-muted hover:bg-accent-tint hover:text-ink transition-colors"
              >
                <Pencil size={11} /> Edit
              </button>
              <button
                type="button"
                onClick={() => { onDelete(msg.id); setShowMenu(false) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-danger hover:bg-danger-bg transition-colors"
              >
                <Trash2 size={11} /> Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function MessageList({ messages, onReply, onEdit, onDelete, currentUser, roster = [] }) {
  if (!messages || messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-faint text-sm bg-bg">
        <p className="font-serif italic">
          No messages yet. Be the first to say something.
        </p>
      </div>
    )
  }

  const topLevel = messages.filter((m) => !m.thread_parent)
  const replyMap = {}
  messages.filter((m) => m.thread_parent).forEach((r) => {
    if (!replyMap[r.thread_parent]) replyMap[r.thread_parent] = []
    replyMap[r.thread_parent].push(r)
  })

  let lastDate = null

  return (
    <div className="flex-1 overflow-y-auto py-2 bg-bg">
      {topLevel.map((msg) => {
        const date = formatDate(msg.created_at)
        const showDate = date !== lastDate
        lastDate = date
        return (
          <div key={msg.id}>
            {showDate && (
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 h-px bg-line" />
                <span
                  className="font-serif italic text-2xs text-ink-faint uppercase tracking-eyebrow"
                  style={{ fontVariant: 'small-caps' }}
                >
                  {date}
                </span>
                <div className="flex-1 h-px bg-line" />
              </div>
            )}
            <MessageItem
              msg={msg}
              replies={replyMap[msg.id] || []}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              currentUser={currentUser}
              roster={roster}
            />
          </div>
        )
      })}
    </div>
  )
}
