/**
 * BreakoutRooms.jsx — wires the MEET-SPACES-01 breakout stub into a working
 * admin flow.
 *
 * Backend contract (vulos-cloud MEET-BREAKOUT-01, behind feature flag):
 *   POST   /api/meet/breakouts                — { parentRoomId, rooms: [{ name }] }
 *                                              → { breakoutSessionId, rooms: [{ id, name }] }
 *   POST   /api/meet/breakouts/{id}/assign    — { roomId, participantIds[] }
 *                                              → 204
 *   POST   /api/meet/breakouts/{id}/recall    — recall everyone to the main
 *                                              → 204
 *   GET    /api/meet/breakouts/{id}           — current assignments / status
 *
 * Until the cloud endpoint is live the create call will 404; we surface a
 * friendly "Breakouts unavailable in this workspace" notice in that case so
 * the UI degrades cleanly. Local in-memory assignment state lets the host
 * preview the split before committing.
 *
 * Drift in/out — the host can re-assign any participant by clicking the
 * room column in their row. A "Return to main" button reverses all drifts.
 *
 * Props:
 *   parentRoomId    — the main-room session id
 *   participants    — [{ peerId, identity?: { displayName, accountAddress } }]
 *   localPeerId     — the viewer's own peer id (so we never auto-move them)
 *   isOrganizer     — only organizers can create / recall (UI gating)
 *   onJoinBreakout  — (roomId) => void; the parent navigates the viewer
 *                     into a different sessionId when they personally are
 *                     assigned to a breakout
 *   onClose         — closes the panel
 *   baseURL         — same-origin '' by default
 *   fetchFn         — testing seam (defaults to global fetch)
 */
import { useCallback, useMemo, useState } from 'react'
import { Layers, X, ArrowLeftRight, Undo2 } from 'lucide-react'

const MAIN = '__main__'

export default function BreakoutRooms({
  parentRoomId,
  participants = [],
  localPeerId,
  isOrganizer = false,
  onJoinBreakout,
  onClose,
  baseURL = '',
  fetchFn,
}) {
  const _fetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null)
  const [roomCount, setRoomCount] = useState(2)
  // session: null | { id, rooms: [{ id, name }] }
  const [session, setSession] = useState(null)
  // assignment: peerId → roomId (or MAIN)
  const [assignment, setAssignment] = useState({})
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [recalling, setRecalling] = useState(false)

  const previewRooms = useMemo(() => {
    if (session) return session.rooms
    return Array.from({ length: roomCount }, (_, i) => ({
      id: `preview:${i + 1}`,
      name: `Room ${i + 1}`,
    }))
  }, [session, roomCount])

  const handleCreate = useCallback(async () => {
    if (!_fetch || !isOrganizer) return
    setCreating(true)
    setError(null)
    try {
      const r = await _fetch(`${baseURL}/api/meet/breakouts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          parentRoomId,
          rooms: previewRooms.map((rm) => ({ name: rm.name })),
        }),
      })
      if (r.status === 404 || r.status === 501) {
        setError('Breakouts unavailable in this workspace.')
        return
      }
      if (!r.ok) {
        setError(`Couldn't create breakouts (${r.status})`)
        return
      }
      const j = await r.json()
      setSession({ id: j.breakoutSessionId, rooms: j.rooms || previewRooms })
      // Even-split participants by index, keep local peer in the first room
      // so the host can navigate into their own breakout if they want.
      const rooms = j.rooms || previewRooms
      const next = {}
      const others = participants.filter((p) => p.peerId !== localPeerId)
      others.forEach((p, i) => {
        next[p.peerId] = rooms[i % rooms.length].id
      })
      if (localPeerId) next[localPeerId] = rooms[0].id
      setAssignment(next)
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setCreating(false)
    }
  }, [_fetch, baseURL, parentRoomId, previewRooms, participants, localPeerId, isOrganizer])

  const handleDrift = useCallback((peerId, newRoomId) => {
    setAssignment((prev) => ({ ...prev, [peerId]: newRoomId }))
  }, [])

  const handleCommitAssignments = useCallback(async () => {
    if (!_fetch || !session) return
    setError(null)
    try {
      const byRoom = {}
      for (const [peerId, roomId] of Object.entries(assignment)) {
        if (!roomId || roomId === MAIN) continue
        ;(byRoom[roomId] = byRoom[roomId] || []).push(peerId)
      }
      for (const [roomId, peerIds] of Object.entries(byRoom)) {
        const r = await _fetch(
          `${baseURL}/api/meet/breakouts/${encodeURIComponent(session.id)}/assign`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ roomId, participantIds: peerIds }),
          },
        )
        if (!r.ok && r.status !== 204) {
          setError(`Assign failed for ${roomId} (${r.status})`)
          return
        }
      }
    } catch (e) {
      setError(e?.message || 'Network error')
    }
  }, [_fetch, baseURL, session, assignment])

  const handleRecall = useCallback(async () => {
    if (!_fetch || !session || !isOrganizer) return
    setRecalling(true)
    setError(null)
    try {
      const r = await _fetch(
        `${baseURL}/api/meet/breakouts/${encodeURIComponent(session.id)}/recall`,
        { method: 'POST', credentials: 'include' },
      )
      if (!r.ok && r.status !== 204) {
        setError(`Recall failed (${r.status})`)
        return
      }
      setAssignment(Object.fromEntries(participants.map((p) => [p.peerId, MAIN])))
      setSession(null)
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setRecalling(false)
    }
  }, [_fetch, baseURL, session, participants, isOrganizer])

  const handleJoinMyBreakout = useCallback(() => {
    if (!session || !localPeerId) return
    const roomId = assignment[localPeerId]
    if (!roomId || roomId === MAIN) return
    onJoinBreakout?.(roomId)
  }, [session, assignment, localPeerId, onJoinBreakout])

  return (
    <aside
      className="border-l border-paper/10 w-80 flex flex-col overflow-hidden bg-paper/[.02]"
      data-testid="breakout-rooms-panel"
      aria-label="Breakout rooms"
    >
      <header className="h-11 px-3 flex items-center gap-2 border-b border-paper/10">
        <Layers size={14} className="text-accent" />
        <span className="text-2xs uppercase tracking-eyebrow font-semibold text-paper/70">
          Breakout rooms
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close breakouts"
          className="ml-auto inline-flex items-center justify-center w-6 h-6 rounded-sm text-paper/60 hover:text-paper hover:bg-paper/10"
        >
          <X size={14} />
        </button>
      </header>

      {error && (
        <div
          className="px-3 py-2 text-2xs text-warning border-b border-warning/30 bg-warning/10"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="px-3 py-2 border-b border-paper/10 flex items-center gap-2 text-2xs text-paper/70">
        <label htmlFor="breakout-count">Rooms</label>
        <input
          id="breakout-count"
          type="number"
          min={2}
          max={20}
          value={roomCount}
          disabled={!!session || !isOrganizer}
          onChange={(e) =>
            setRoomCount(Math.max(2, Math.min(20, parseInt(e.target.value, 10) || 2)))
          }
          className="w-14 h-7 px-2 text-sm bg-paper/10 border border-paper/10 rounded-md text-paper outline-none disabled:opacity-50"
          data-testid="breakout-room-count"
        />
        {!session && isOrganizer && (
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="ml-auto inline-flex items-center justify-center h-7 px-3 rounded-md text-xs font-medium tracking-tightish bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            data-testid="breakout-create"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        )}
        {session && isOrganizer && (
          <button
            type="button"
            onClick={handleRecall}
            disabled={recalling}
            className="ml-auto inline-flex items-center gap-1 h-7 px-3 rounded-md text-xs font-medium tracking-tightish bg-paper/10 text-paper hover:bg-paper/20 disabled:opacity-50"
            data-testid="breakout-recall"
          >
            <Undo2 size={12} />
            {recalling ? 'Recalling…' : 'Return to main'}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {previewRooms.map((rm) => {
          const members = participants.filter((p) => assignment[p.peerId] === rm.id)
          return (
            <div key={rm.id} className="mb-3" data-testid="breakout-room">
              <div className="text-xs font-semibold text-paper/80 tracking-tightish mb-1">
                {rm.name}
                <span className="ml-2 text-2xs text-paper/40 font-normal">
                  ({members.length})
                </span>
              </div>
              {members.length === 0 && (
                <div className="text-2xs text-paper/35 italic px-1 py-1">No members</div>
              )}
              {members.map((p) => (
                <div
                  key={p.peerId}
                  className="flex items-center gap-2 px-1 py-1 text-sm text-paper/85"
                >
                  <span className="truncate font-serif italic">
                    {p.identity?.displayName || p.peerId.slice(0, 6)}
                  </span>
                  {session && isOrganizer && (
                    <select
                      value={rm.id}
                      onChange={(e) => handleDrift(p.peerId, e.target.value)}
                      className="ml-auto h-6 text-2xs bg-paper/10 border border-paper/10 rounded-sm text-paper outline-none"
                      aria-label={`Move ${p.identity?.displayName || p.peerId} to another room`}
                      data-testid="breakout-drift-select"
                    >
                      {previewRooms.map((r2) => (
                        <option key={r2.id} value={r2.id}>{r2.name}</option>
                      ))}
                      <option value={MAIN}>Main</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {session && (
        <div className="px-3 py-2 border-t border-paper/10 flex items-center gap-2">
          {isOrganizer && (
            <button
              type="button"
              onClick={handleCommitAssignments}
              className="inline-flex items-center gap-1 h-7 px-3 rounded-md text-2xs font-medium tracking-tightish bg-paper/10 text-paper hover:bg-paper/20"
              data-testid="breakout-commit"
            >
              <ArrowLeftRight size={12} />
              Apply assignments
            </button>
          )}
          {localPeerId && assignment[localPeerId] && assignment[localPeerId] !== MAIN && (
            <button
              type="button"
              onClick={handleJoinMyBreakout}
              className="ml-auto inline-flex items-center justify-center h-7 px-3 rounded-md text-2xs font-medium tracking-tightish bg-accent text-white hover:bg-accent-hover"
              data-testid="breakout-join-mine"
            >
              Join my breakout
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
