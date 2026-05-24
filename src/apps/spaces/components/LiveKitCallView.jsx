/**
 * LiveKitCallView.jsx — Large-room (Pro tier) call surface using livekit-client.
 *
 * MEET-SPACES-01. Companion to CallView.jsx (the mesh path). Both surfaces
 * are kept side-by-side: Room.jsx route-selects per call. Do NOT delete the
 * mesh path — it's the intimate-call default + the no-cloud-needed fallback.
 *
 * Visual parity with CallView.jsx: same dock controls, same tile look, same
 * active-speaker accent. Differences are intentional:
 *   - Speaker grid caps at ~25 visible tiles with a "+N more" indicator,
 *     because mesh can't reach the room sizes this view targets.
 *   - Raise-hand sent over LiveKit data channel.
 *   - Breakout-room selector stub (UI shell only — backend in next sub-wave).
 *   - Recording toggle calls the cloud MEET-RECORDING-01 endpoint (TODO).
 *
 * Props mirror CallView for drop-in compatibility:
 *   sessionId    — the room id (must already be in `<tenant>:<rest>` form
 *                  for vulos-meet to accept the token; the lobby builds it)
 *   identity     — { displayName, accountAddress, color }
 *   video        — start with camera on (default true)
 *   isOrganizer  — toggles spotlight/recording-toggle visibility
 *   onLeave      — fires after disconnect
 *   tokenURL     — optional override (defaults to /api/meet/token on cloud)
 *   livekitURL   — optional override (default '' → comes from token response)
 *   createRoom   — testing seam: defaults to createLiveKitRoom
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Mic, MicOff, Video, VideoOff, PhoneOff, Users,
  Wifi, MessageSquare, Hand, Layers, Circle, Square,
} from 'lucide-react'
import { createLiveKitRoom } from '../../../lib/call/livekitClient'
import { Tooltip } from '../../../components/ui'

const MAX_VISIBLE_TILES = 25

export default function LiveKitCallView({
  sessionId, identity, video = true, isOrganizer = false, onLeave,
  tokenURL, livekitURL,
  createRoom = createLiveKitRoom,
}) {
  const [room, setRoom] = useState(null)
  const [error, setError] = useState(null)
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(!video)
  const [participants, setParticipants] = useState([])
  const [activeSpeakers, setActiveSpeakers] = useState([])
  const [state, setState] = useState('connecting')
  const [handRaised, setHandRaised] = useState(false)
  const [peerHands, setPeerHands] = useState({})
  const [showRoster, setShowRoster] = useState(false)
  const [recording, setRecording] = useState(false)
  const [breakoutOpen, setBreakoutOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    let activeRoom = null
    ;(async () => {
      try {
        const r = await createRoom({
          roomId: sessionId,
          identity,
          video,
          audio: true,
          tokenURL,
          livekitURL,
        })
        if (cancelled) { r.leave(); return }
        activeRoom = r
        setRoom(r)
        setState(r.state)
        setMuted(r.muted)
        setCameraOff(r.cameraOff)
        setParticipants([...r.participants])

        r.on('participants-changed', (p) => setParticipants([...p]))
        r.on('active-speakers', (ids) => setActiveSpeakers(ids))
        r.on('state', (s) => setState(s))
        r.on('raise-hand', ({ peerId, raised }) => {
          setPeerHands((prev) => ({ ...prev, [peerId]: raised }))
        })
      } catch (e) {
        console.error('[livekit] join failed', e)
        if (!cancelled) setError(e.message || String(e))
      }
    })()
    return () => {
      cancelled = true
      if (activeRoom) activeRoom.leave()
    }
  }, [sessionId])

  const handleMute = useCallback(async () => {
    if (!room) return
    setMuted(await room.toggleMute())
  }, [room])

  const handleCamera = useCallback(async () => {
    if (!room) return
    setCameraOff(await room.toggleCamera())
  }, [room])

  const handleLeave = useCallback(() => {
    if (room) room.leave()
    onLeave?.()
  }, [room, onLeave])

  const handleHandToggle = useCallback(async () => {
    if (!room) return
    const next = !handRaised
    setHandRaised(next)
    await room.raiseHand(next)
  }, [room, handRaised])

  // TODO(MEET-RECORDING-01): wire to vulos-cloud recording control endpoint.
  // The endpoint is queued for the next sub-wave; here we just toggle local
  // UI state and POST to a stub URL so MEET-RECORDING-01 has a target shape.
  const handleRecordingToggle = useCallback(async () => {
    if (!room) return
    const next = !recording
    setRecording(next)
    try {
      await fetch('/api/meet/recording', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ room_id: sessionId, recording: next }),
      })
    } catch { /* stub — endpoint may not exist yet */ }
  }, [room, recording, sessionId])

  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full p-8 text-paper"
        style={{ background: 'var(--ink)' }}
      >
        <div className="text-xl mb-1 font-serif">Couldn't start the call</div>
        <div className="text-sm text-paper/60 mb-6">{error}</div>
        <button
          type="button"
          onClick={handleLeave}
          className="px-4 h-8 rounded-md bg-danger text-white hover:opacity-90 text-sm font-medium tracking-tightish"
        >
          Close
        </button>
      </div>
    )
  }

  const totalTiles = participants.length + 1
  const visible = participants.slice(0, MAX_VISIBLE_TILES - 1)
  const overflowCount = Math.max(0, participants.length - visible.length)

  const stateLabel =
    state === 'connecting' ? 'Connecting…' :
    state === 'connected' ? 'Connected' :
    state === 'reconnecting' ? 'Reconnecting…' :
    state === 'closed' ? 'Call ended' : state

  const gridCols =
    totalTiles <= 1 ? 1 :
    totalTiles <= 4 ? 2 :
    totalTiles <= 9 ? 3 :
    totalTiles <= 16 ? 4 : 5

  return (
    <div className="flex flex-col h-full text-paper" style={{ background: 'var(--ink)' }}>
      {/* Header */}
      <div className="px-4 h-11 flex items-center gap-3 text-xs border-b border-paper/10">
        <span className="text-paper/80 tracking-tightish">{stateLabel}</span>
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-2xs font-medium tracking-tightish bg-accent/15 text-accent border border-accent/30"
        >
          <Wifi size={11} />
          <span>SFU</span>
        </span>
        {recording && (
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-2xs font-medium tracking-tightish bg-danger/20 text-danger border border-danger/30"
            aria-live="polite"
          >
            <Circle size={9} fill="currentColor" />
            <span>REC</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowRoster((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 text-paper/70 hover:text-paper transition-colors duration-fast"
          title="Participants"
          aria-label="Toggle participants"
        >
          <Users size={13} />
          <span className="tracking-tightish">{totalTiles}</span>
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Speaker grid */}
        <div
          className="flex-1 grid gap-2 p-3 overflow-auto"
          style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
          data-testid="livekit-speaker-grid"
        >
          <SelfTile
            label={identity?.displayName ? `${identity.displayName} (you)` : 'You'}
            muted={muted}
            cameraOff={cameraOff}
            color={identity?.color}
            handRaised={handRaised}
          />
          {visible.map((p) => (
            <ParticipantTile
              key={p.peerId}
              participant={p}
              isSpeaking={activeSpeakers.includes(p.peerId)}
              handRaised={peerHands[p.peerId]}
            />
          ))}
          {overflowCount > 0 && (
            <div
              className="relative rounded-lg flex items-center justify-center min-h-[140px] text-paper/70 text-sm font-medium tracking-tightish"
              style={{ background: 'rgba(255,255,255,.04)', border: '1px dashed rgba(255,255,255,.15)' }}
              data-testid="livekit-overflow-tile"
            >
              +{overflowCount} more
            </div>
          )}
        </div>

        {showRoster && (
          <aside className="w-60 border-l border-paper/10 overflow-y-auto p-3 text-sm">
            <h3 className="text-2xs uppercase text-paper/50 mb-2 tracking-eyebrow font-semibold">
              Participants ({totalTiles})
            </h3>
            <ul className="space-y-1">
              <li className="flex items-center justify-between py-1 text-paper/90">
                <span className="font-serif italic">
                  {identity?.displayName || 'You'} <span className="text-paper/40 text-2xs">(you)</span>
                </span>
              </li>
              {participants.map((p) => (
                <li key={p.peerId} className="flex items-center justify-between py-1">
                  <span
                    className={[
                      'inline-flex items-center gap-1.5 tracking-tightish',
                      activeSpeakers.includes(p.peerId) ? 'text-accent' : 'text-paper/85',
                    ].join(' ')}
                  >
                    {peerHands[p.peerId] && <span title="Hand raised">✋</span>}
                    <span className="font-serif italic">
                      {p.identity?.displayName || p.peerId.slice(0, 6)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {/* Breakout panel stub */}
      {breakoutOpen && (
        <BreakoutPanel onClose={() => setBreakoutOpen(false)} participantCount={totalTiles} />
      )}

      {/* Controls */}
      <div className="px-4 py-3 border-t border-paper/10 flex items-center justify-center">
        <div
          className="inline-flex items-center gap-2 px-2 py-1.5 rounded-lg border border-paper/10"
          style={{ background: 'rgba(255,255,255,.04)' }}
        >
          <DockButton onClick={handleMute} active={muted} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? <MicOff size={17} /> : <Mic size={17} />}
          </DockButton>
          <DockButton onClick={handleCamera} active={cameraOff} title={cameraOff ? 'Camera on' : 'Camera off'}>
            {cameraOff ? <VideoOff size={17} /> : <Video size={17} />}
          </DockButton>
          <DockButton onClick={handleHandToggle} active={handRaised} title={handRaised ? 'Lower hand' : 'Raise hand'}>
            <Hand size={17} />
          </DockButton>
          <DockButton onClick={() => setBreakoutOpen((v) => !v)} active={breakoutOpen} title="Breakout rooms">
            <Layers size={17} />
          </DockButton>
          {isOrganizer && (
            <DockButton
              onClick={handleRecordingToggle}
              active={recording}
              title={recording ? 'Stop recording' : 'Start recording'}
              testid="livekit-recording-toggle"
            >
              {recording ? <Square size={15} /> : <Circle size={15} />}
            </DockButton>
          )}
          <span className="w-px h-6 bg-paper/10 mx-1" aria-hidden />
          <DockButton onClick={() => setShowRoster((v) => !v)} active={showRoster} title="Participants">
            <Users size={17} />
          </DockButton>
          <span className="w-px h-6 bg-paper/10 mx-1" aria-hidden />
          <Tooltip label="Leave call" side="top">
            <button
              type="button"
              onClick={handleLeave}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-danger text-white hover:opacity-90 text-sm font-medium tracking-tightish transition-opacity duration-fast focus-visible:outline-none focus-visible:shadow-focus"
            >
              <PhoneOff size={16} />
              <span>Leave</span>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

function DockButton({ onClick, active, title, children, testid }) {
  return (
    <Tooltip label={title} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        aria-pressed={active ? 'true' : 'false'}
        data-testid={testid}
        className={[
          'inline-flex items-center justify-center w-10 h-10 rounded-md',
          'transition-[background,color] duration-fast ease-out',
          'focus-visible:outline-none focus-visible:shadow-focus',
          active
            ? 'bg-accent text-white hover:bg-accent-hover'
            : 'bg-paper/10 text-paper hover:bg-paper/20',
        ].join(' ')}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function SelfTile({ label, muted, cameraOff, color, handRaised }) {
  return (
    <div
      className="relative rounded-lg overflow-hidden flex items-center justify-center min-h-[140px]"
      style={{
        background: 'rgba(255,255,255,.04)',
        outline: color ? `2px solid ${color}` : '1px solid rgba(255,255,255,.06)',
        outlineOffset: '-2px',
      }}
    >
      {cameraOff && (
        <div className="text-paper/40 text-3xl uppercase font-semibold tracking-tightish">
          {(label || '?').slice(0, 1)}
        </div>
      )}
      <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-2xs text-paper">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill tracking-tightish"
          style={{ background: 'rgba(26,25,22,.55)' }}
        >
          {label}
        </span>
        <span className="inline-flex items-center gap-1">
          {handRaised && (
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-pill bg-warning/90 text-white"
              title="Hand raised"
            >
              ✋
            </span>
          )}
          {muted && (
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-pill"
              style={{ background: 'rgba(26,25,22,.55)' }}
              title="Muted"
            >
              <MicOff size={11} />
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

function ParticipantTile({ participant, isSpeaking, handRaised }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    // Attach the first video publication if available (livekit-client v2 API).
    const pubs = participant.videoTracks
    let videoTrack = null
    if (pubs && typeof pubs.forEach === 'function') {
      pubs.forEach((pub) => {
        if (!videoTrack && pub?.track) videoTrack = pub.track
      })
    }
    if (videoTrack && typeof videoTrack.attach === 'function') {
      try {
        videoTrack.attach(ref.current)
        return () => { try { videoTrack.detach(ref.current) } catch {} }
      } catch {}
    }
  }, [participant.videoTracks])

  const label = participant.identity?.displayName || participant.peerId?.slice(0, 6) || 'Peer'

  return (
    <div
      className="relative rounded-lg overflow-hidden flex items-center justify-center min-h-[140px] transition-[outline] duration-fast ease-out"
      style={{
        background: 'rgba(255,255,255,.04)',
        outline: isSpeaking
          ? '2px solid var(--accent)'
          : '1px solid rgba(255,255,255,.06)',
        outlineOffset: '-2px',
      }}
      data-testid="livekit-participant-tile"
    >
      <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />
      <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-2xs">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill tracking-tightish text-paper"
          style={{ background: 'rgba(26,25,22,.55)' }}
        >
          {label}
        </span>
        {handRaised && (
          <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-pill bg-warning/90 text-white text-[10px]"
            title="Hand raised"
          >
            ✋
          </span>
        )}
      </div>
    </div>
  )
}

// Breakout-room panel (stub — UI shell only).
//
// TODO(MEET-BREAKOUT-01): full creation+routing is queued for a later wave.
// This shell just lets the host pick a count and a label per room.
function BreakoutPanel({ onClose, participantCount }) {
  const [count, setCount] = useState(2)
  const [creating, setCreating] = useState(false)
  return (
    <div className="px-4 py-3 border-t border-paper/10 bg-paper/5">
      <div className="flex items-center gap-3">
        <Layers size={14} className="text-paper/70" />
        <span className="text-sm text-paper/80 tracking-tightish font-medium">Breakout rooms</span>
        <span className="text-2xs text-paper/40 uppercase tracking-eyebrow">soon</span>
        <span className="ml-auto inline-flex items-center gap-2 text-2xs text-paper/60">
          <label htmlFor="breakout-count">Rooms</label>
          <input
            id="breakout-count"
            type="number"
            min={2}
            max={20}
            value={count}
            onChange={(e) => setCount(Math.max(2, Math.min(20, parseInt(e.target.value, 10) || 2)))}
            className="w-14 h-7 px-2 text-sm bg-paper/10 border border-paper/10 rounded-md text-paper outline-none"
          />
          <span className="text-paper/40">
            ≈ {Math.max(1, Math.floor(participantCount / count))} per room
          </span>
        </span>
        <button
          type="button"
          disabled={creating}
          onClick={() => { setCreating(true); setTimeout(() => { setCreating(false); onClose?.() }, 400) }}
          className="inline-flex items-center justify-center h-7 px-3 rounded-md text-xs font-medium tracking-tightish bg-paper/10 text-paper hover:bg-paper/20 disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create (stub)'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-paper/60 hover:text-paper tracking-tightish"
        >
          Close
        </button>
      </div>
    </div>
  )
}
