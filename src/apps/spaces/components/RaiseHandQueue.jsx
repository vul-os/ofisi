/**
 * RaiseHandQueue.jsx — visible queue of raised hands with FIFO position +
 * dismiss (lower hand) action for the host/speaker UI.
 *
 * Pure-presentation: state lives upstream. The parent passes
 *   queue          — ordered array of { peerId, displayName, raisedAt }
 *                    (raisedAt is a unix-ms timestamp; ties broken by peerId)
 *   onDismiss      — (peerId) => void; lowers that peer's hand (sends a
 *                    raise-hand:false message via the call data channel)
 *   localPeerId    — viewer's own peer id, so we render "you" badge + the
 *                    "Lower hand" button for the local entry
 *
 * The queue is intentionally a thin sidebar widget so it can be slotted into
 * either CallView (mesh) or LiveKitCallView (SFU) — both already track the
 * `peerHands` state.
 */
import { Hand, X } from 'lucide-react'

function formatRel(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export default function RaiseHandQueue({ queue = [], onDismiss, localPeerId }) {
  if (queue.length === 0) return null
  return (
    <aside
      className="border-l border-paper/10 w-56 bg-warning/[.04] flex flex-col overflow-hidden"
      data-testid="raise-hand-queue"
      aria-label="Raise-hand queue"
    >
      <header className="h-9 px-3 flex items-center gap-2 border-b border-paper/10">
        <Hand size={13} className="text-warning" />
        <span className="text-2xs uppercase tracking-eyebrow font-semibold text-paper/70">
          Hand queue ({queue.length})
        </span>
      </header>
      <ol className="flex-1 overflow-y-auto py-2">
        {queue.map((q, i) => {
          const isLocal = q.peerId === localPeerId
          return (
            <li
              key={q.peerId}
              className={[
                'px-3 py-1.5 flex items-center gap-2 text-sm tracking-tightish',
                i === 0 ? 'bg-warning/10' : '',
              ].join(' ')}
              data-testid="raise-hand-queue-item"
            >
              <span
                className={[
                  'inline-flex items-center justify-center w-5 h-5 rounded-pill text-[10px] font-semibold',
                  i === 0 ? 'bg-warning text-white' : 'bg-paper/10 text-paper/70',
                ].join(' ')}
                title={`Position ${i + 1}`}
              >
                {i + 1}
              </span>
              <span className="font-serif italic text-paper/90 truncate">
                {q.displayName || q.peerId.slice(0, 6)}
              </span>
              {isLocal && (
                <span className="text-[10px] uppercase tracking-eyebrow text-paper/40">
                  you
                </span>
              )}
              <span className="ml-auto text-[10px] text-paper/40 tracking-tightish">
                {formatRel(q.raisedAt)}
              </span>
              {onDismiss && (
                <button
                  type="button"
                  onClick={() => onDismiss(q.peerId)}
                  aria-label={`Lower hand for ${q.displayName || q.peerId}`}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-sm text-paper/50 hover:text-paper hover:bg-paper/10"
                  data-testid="raise-hand-dismiss"
                >
                  <X size={12} />
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
