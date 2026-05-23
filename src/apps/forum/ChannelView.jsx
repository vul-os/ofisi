/**
 * ChannelView — message view + compose for a single channel/DM.
 * Pulls messages from the REST API backed by the CRDT ForumStore (OFFICE-60).
 * Live sync is via polling (full fabric P2P is OFFICE-20; this plugs in there).
 *
 * Design pass: sticky-but-quiet topbar with roster pills + PresenceDots,
 * compose lane sits inside a paper card with a single primary Send button,
 * and an optional thread context panel slides in from the right (mirrors
 * the CommentsPanel pattern).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Send, Hash, Lock, AtSign, X, MessageSquare, ChevronRight,
} from 'lucide-react'
import MessageList from './MessageList.jsx'
import { api } from '../../lib/api.js'
import { getDefaultStore, STATE_DELETED } from '../../lib/crdt/messages.js'
import { PresenceDot } from '../../components/PresenceBar.jsx'
import { IconButton, Topbar } from '../../components/ui'

const POLL_INTERVAL_MS = 3000

function ChannelIcon({ type, size = 15 }) {
  if (type === 'dm') return <AtSign size={size} className="text-accent" />
  if (type === 'private') return <Lock size={size} className="text-warning" />
  return <Hash size={size} className="text-ink-faint" />
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// ThreadPanel — right-rail context for a single thread root + its replies
// ---------------------------------------------------------------------------

function ThreadPanel({ root, replies = [], onSend, onClose, currentUser }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [replies.length])

  if (!root) return null

  const handleSend = async () => {
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await onSend(text, root.id)
      setBody('')
    } finally {
      setSending(false)
    }
  }

  return (
    <aside className="w-80 flex-shrink-0 border-l border-line bg-bg-elev2 flex flex-col overflow-hidden animate-slide-in-right">
      <div className="flex items-center justify-between px-3 h-11 border-b border-line bg-paper flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={14} className="text-ink-muted" />
          <span className="text-sm font-semibold text-ink tracking-tightish">Thread</span>
          {replies.length > 0 && (
            <span className="text-2xs bg-bg-elev2 text-ink-faint rounded-pill px-1.5 py-0.5 font-medium">
              {replies.length}
            </span>
          )}
        </div>
        <IconButton size="sm" title="Close thread" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      {/* Root message */}
      <div className="px-3 py-3 bg-paper border-b border-line flex-shrink-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-xs font-semibold text-ink tracking-tightish">
            {root.author_id}
          </span>
          <span className="text-2xs text-ink-faint">{formatTime(root.created_at)}</span>
        </div>
        <p className="text-sm text-ink whitespace-pre-wrap break-words leading-snug">
          {root.body}
        </p>
      </div>

      {/* Reply list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {replies.length === 0 && (
          <p className="text-xs text-ink-faint text-center py-6 font-serif italic">
            No replies yet. Start the thread.
          </p>
        )}
        {replies.map((r) => {
          const isOwn = r.author_id === currentUser
          const isDeleted = r.state === STATE_DELETED
          return (
            <div key={r.id} className="flex flex-col gap-0.5 animate-rise-in">
              <div className="flex items-baseline gap-2">
                <span className={`text-xs font-semibold tracking-tightish ${isOwn ? 'text-accent-press' : 'text-ink'}`}>
                  {r.author_id}
                </span>
                <span className="text-2xs text-ink-faint">{formatTime(r.created_at)}</span>
              </div>
              {isDeleted ? (
                <p className="text-xs text-ink-faint italic">This message was deleted.</p>
              ) : (
                <p className={`text-sm whitespace-pre-wrap break-words leading-snug ${
                  isOwn ? 'text-ink' : 'text-ink'
                }`}>
                  {r.body}
                </p>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Reply composer */}
      <div className="p-3 border-t border-line bg-paper flex-shrink-0 space-y-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          rows={2}
          placeholder="Reply in thread…"
          className="w-full text-sm bg-bg-elev2 border border-line rounded-sm px-2 py-1.5 resize-none outline-none focus:border-accent focus:shadow-focus focus:bg-paper transition-colors text-ink placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!body.trim() || sending}
          className="w-full h-7 text-xs font-medium bg-accent text-white rounded-sm hover:bg-accent-hover disabled:opacity-50 transition-colors tracking-tightish"
        >
          {sending ? 'Sending…' : 'Reply'}
        </button>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// ChannelView — main
// ---------------------------------------------------------------------------

export default function ChannelView({ channel, currentUser, roster = [] }) {
  const [messages, setMessages] = useState([])
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [threadRoot, setThreadRoot] = useState(null)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)
  const pollRef = useRef(null)
  const composeRef = useRef(null)
  const crdtStore = getDefaultStore()

  const loadMessages = useCallback(async () => {
    if (!channel) return
    try {
      const msgs = await api.forumListMessages(channel.id)
      crdtStore.mergeOps(msgs.map((m) => ({
        op: m.state === 'deleted' ? 'tombstone' : m.state === 'edited' ? 'edit' : 'append',
        channel_id: m.channel_id,
        msg: m,
        applied_at: m.updated_at,
      })))
      setMessages(crdtStore.listMessages(channel.id))
    } catch (e) {
      console.warn('[ChannelView] poll error', e)
    }
  }, [channel, crdtStore])

  // Initial load + polling
  useEffect(() => {
    setMessages([])
    setError(null)
    setThreadRoot(null)
    if (!channel) return
    loadMessages()
    pollRef.current = setInterval(loadMessages, POLL_INTERVAL_MS)
    return () => clearInterval(pollRef.current)
  }, [channel?.id, loadMessages])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  async function send() {
    const text = body.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await api.forumSendMessage(channel.id, text, replyTo?.id || '')
      setBody('')
      setReplyTo(null)
      if (composeRef.current) composeRef.current.style.height = 'auto'
      await loadMessages()
      const last = messages[messages.length - 1]
      if (last) api.forumMarkRead(channel.id, last.seq_clock).catch(() => {})
    } catch (e) {
      setError(e.message || 'Send failed')
    } finally {
      setSending(false)
    }
  }

  async function sendThreadReply(text, parentId) {
    setError(null)
    await api.forumSendMessage(channel.id, text, parentId)
    await loadMessages()
  }

  async function handleEdit(msgId, newBody) {
    try {
      await api.forumEditMessage(channel.id, msgId, newBody)
      await loadMessages()
    } catch (e) {
      setError(e.message || 'Edit failed')
    }
  }

  async function handleDelete(msgId) {
    try {
      await api.forumDeleteMessage(channel.id, msgId)
      await loadMessages()
    } catch (e) {
      setError(e.message || 'Delete failed')
    }
  }

  function openThread(msg) {
    setThreadRoot(msg)
    setReplyTo(null)
  }

  if (!channel) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <p className="text-ink-faint text-sm font-serif italic">
          Select a channel or DM to start messaging.
        </p>
      </div>
    )
  }

  const isDM = channel.type === 'dm'

  // Find an up-to-date thread root + its replies for the side rail
  const liveThreadRoot = threadRoot
    ? messages.find((m) => m.id === threadRoot.id) || threadRoot
    : null
  const threadReplies = liveThreadRoot
    ? messages.filter((m) => m.thread_parent === liveThreadRoot.id)
    : []

  return (
    <div className="flex-1 flex min-h-0 bg-bg">
      <div className="flex-1 flex flex-col min-h-0">
        {/* Sticky-but-quiet topbar */}
        <Topbar
          leading={
            <span className="flex items-center gap-2 px-1">
              <ChannelIcon type={channel.type} size={15} />
              <span className="font-semibold text-ink tracking-tightish text-sm">
                {channel.name}
              </span>
              <span className="text-2xs text-ink-faint uppercase tracking-eyebrow capitalize">
                {channel.type}
              </span>
            </span>
          }
          title={<span />}
          actions={
            roster.length > 0 ? (
              <div
                className="flex items-center gap-1"
                title={`${roster.length} member${roster.length !== 1 ? 's' : ''} online`}
              >
                {roster.slice(0, 5).map((p) => (
                  <span
                    key={p.accountId}
                    className="relative inline-flex items-center gap-1 bg-bg-elev2 border border-line rounded-pill pl-1 pr-2 py-0.5"
                    title={p.statusText
                      ? `${p.displayName} (${p.status}) — ${p.statusText}`
                      : `${p.displayName} (${p.status})`
                    }
                  >
                    <span
                      className="relative inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-[9px] font-bold flex-shrink-0"
                      style={{ backgroundColor: p.color }}
                    >
                      {(p.displayName || '?')[0].toUpperCase()}
                      <span className="absolute -bottom-0.5 -right-0.5">
                        <PresenceDot status={p.status} size={5} />
                      </span>
                    </span>
                    <span className="text-2xs text-ink-muted tracking-tightish truncate max-w-[80px]">
                      {p.displayName}
                    </span>
                  </span>
                ))}
                {roster.length > 5 && (
                  <span className="text-2xs text-ink-faint px-1">+{roster.length - 5}</span>
                )}
              </div>
            ) : null
          }
        />

        {/* Error banner */}
        {error && (
          <div className="px-4 py-2 bg-danger-bg border-b border-line text-xs text-danger flex items-center justify-between">
            {error}
            <IconButton size="sm" onClick={() => setError(null)} title="Dismiss">
              <X size={12} />
            </IconButton>
          </div>
        )}

        {/* Message list */}
        <MessageList
          messages={messages}
          onReply={openThread}
          onEdit={handleEdit}
          onDelete={handleDelete}
          currentUser={currentUser || 'me'}
          roster={roster}
        />

        <div ref={bottomRef} />

        {/* Compose */}
        <div className="px-4 py-3 border-t border-line bg-paper flex-shrink-0">
          {replyTo && (
            <div className="mb-2 flex items-center gap-2 text-2xs text-ink-muted bg-accent-tint border border-line rounded-sm px-3 py-1.5">
              <ChevronRight size={11} className="text-accent" />
              <span>
                Replying to{' '}
                <span className="font-semibold text-ink">{replyTo.author_id}</span>
              </span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                className="ml-auto text-ink-faint hover:text-ink"
              >
                <X size={11} />
              </button>
            </div>
          )}
          <div className="flex gap-2 items-end bg-paper border border-line rounded-md focus-within:border-accent focus-within:shadow-focus transition-[border-color,box-shadow] duration-fast ease-out">
            <textarea
              ref={composeRef}
              className="flex-1 bg-transparent outline-none px-3 py-2 text-sm resize-none max-h-40 text-ink placeholder:text-ink-faint"
              rows={1}
              placeholder={`Message ${isDM ? '' : '#'}${channel.name}…`}
              value={body}
              onChange={(e) => {
                setBody(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = e.target.scrollHeight + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button
              type="button"
              onClick={send}
              disabled={!body.trim() || sending}
              title="Send"
              aria-label="Send"
              className="m-1 inline-flex items-center justify-center h-8 w-8 rounded-sm bg-accent text-white shadow-e1 hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-[background,opacity] duration-fast ease-out flex-shrink-0"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>

      {liveThreadRoot && (
        <ThreadPanel
          root={liveThreadRoot}
          replies={threadReplies}
          onSend={sendThreadReply}
          onClose={() => setThreadRoot(null)}
          currentUser={currentUser || 'me'}
        />
      )}
    </div>
  )
}
