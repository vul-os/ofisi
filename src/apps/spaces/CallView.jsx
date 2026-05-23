/**
 * CallView — Vulos Spaces 1:1 + group voice/video call surface.
 *
 * Design pass:
 *   - Backdrop: warm ink (`bg-ink` paired with paper text) rather than slate.
 *   - Active speaker: quiet 2px accent outline (no garish emerald).
 *   - Transport badge (P2P vs Relay): tiny accent-tint pill (or warning when relay).
 *   - Controls: IconButtons in a dock-style cluster; leave is the only persimmon.
 *   - Screen-share area: kept at 55% height per spec.
 *
 * Props:
 *   sessionId    — fabric session id for this call (channel id, DM id, room id)
 *   channelId    — Spaces channel/thread id for persisted in-call chat (OFFICE-66)
 *   threadParent — optional thread-parent message id for meeting-room threads
 *   identity     — { displayName, accountAddress, color }
 *   video        — start with camera on (default true)
 *   onLeave      — called after the call tears down
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Mic, MicOff, Video, VideoOff, PhoneOff, Users,
  Wifi, WifiOff, MessageSquare, Monitor, MonitorOff,
} from 'lucide-react'
import { createCall } from '../../lib/call/rtc'
import InCallChat from './InCallChat.jsx'
import { Tooltip } from '../../components/ui'

export default function CallView({
  sessionId, channelId, threadParent = '', identity, video = true, onLeave,
}) {
  const [call, setCall] = useState(null)
  const [error, setError] = useState(null)
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(!video)
  const [peers, setPeers] = useState([])
  const [activeSpeaker, setActiveSpeaker] = useState(null)
  const [transport, setTransport] = useState('p2p')
  const [state, setState] = useState('connecting')
  const [showRoster, setShowRoster] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [screenPresenter, setScreenPresenter] = useState(null)
  const localVideoRef = useRef(null)
  const screenPreviewRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let activeCall = null
    ;(async () => {
      try {
        const c = await createCall({ sessionId, identity, video })
        if (cancelled) { c.leave(); return }
        activeCall = c
        setCall(c)
        setState(c.state)
        setMuted(c.muted)
        setCameraOff(c.cameraOff)
        setScreenSharing(c.screenSharing)
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = c.localStream
        }
        c.on('peers-changed', (p) => setPeers([...p]))
        c.on('active-speaker', (id) => setActiveSpeaker(id))
        c.on('transport', (t) => setTransport(t))
        c.on('state', (s) => setState(s))
        c.on('screen-share', (peerId) => setScreenPresenter(peerId))
      } catch (e) {
        console.error(e)
        if (!cancelled) setError(e.message || String(e))
      }
    })()
    return () => {
      cancelled = true
      if (activeCall) activeCall.leave()
    }
  }, [sessionId])

  useEffect(() => {
    if (call && localVideoRef.current && localVideoRef.current.srcObject !== call.localStream) {
      localVideoRef.current.srcObject = call.localStream
    }
  }, [call, peers.length])

  useEffect(() => {
    if (screenPreviewRef.current) {
      screenPreviewRef.current.srcObject =
        screenSharing && call?.screenStream ? call.screenStream : null
    }
  }, [screenSharing, call])

  const handleMute = useCallback(() => {
    if (!call) return
    setMuted(call.toggleMute())
  }, [call])

  const handleCamera = useCallback(() => {
    if (!call) return
    setCameraOff(call.toggleCamera())
  }, [call])

  const handleLeave = useCallback(() => {
    if (call) call.leave()
    onLeave?.()
  }, [call, onLeave])

  const handleScreenShare = useCallback(async () => {
    if (!call) return
    if (screenSharing) {
      call.stopScreenShare()
      setScreenSharing(false)
      setScreenPresenter(null)
    } else {
      try {
        await call.startScreenShare()
        setScreenSharing(true)
        setScreenPresenter('local')
      } catch (e) {
        console.warn('[screen-share] aborted:', e.message)
      }
    }
  }, [call, screenSharing])

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

  const totalTiles = peers.length + 1
  const cols = totalTiles <= 1 ? 1 : totalTiles <= 4 ? 2 : 3

  const presentingPeer = screenPresenter && screenPresenter !== 'local'
    ? peers.find((p) => p.peerId === screenPresenter) ?? null
    : null

  const anyScreenActive = screenSharing || !!presentingPeer

  return (
    <div
      className="flex flex-col h-full text-paper"
      style={{ background: 'var(--ink)' }}
    >
      <CallHeader
        state={state}
        transport={transport}
        participantCount={totalTiles}
        onToggleRoster={() => setShowRoster((v) => !v)}
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {anyScreenActive && (
            <ScreenShareView
              isLocal={screenSharing && screenPresenter === 'local'}
              localRef={screenPreviewRef}
              presenterPeer={presentingPeer}
              presenterLabel={
                screenPresenter === 'local'
                  ? (identity?.displayName || 'You')
                  : (presentingPeer?.identity?.displayName || (presentingPeer?.peerId?.slice(0, 6) ?? 'Peer'))
              }
            />
          )}

          <div
            className="flex-1 grid gap-2 p-3 overflow-auto"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            <Tile
              label={identity?.displayName ? `${identity.displayName} (you)` : 'You'}
              muted={muted}
              cameraOff={cameraOff}
              isLocal
              videoRef={localVideoRef}
              color={identity?.color}
              isPresenting={screenPresenter === 'local'}
            />
            {peers.map((p) => (
              <RemoteTile
                key={p.peerId}
                peer={p}
                isSpeaking={activeSpeaker === p.peerId}
              />
            ))}
          </div>
        </div>

        {showRoster && (
          <Roster
            peers={peers}
            self={identity}
            activeSpeaker={activeSpeaker}
            screenPresenter={screenPresenter}
          />
        )}
        {showChat && channelId && (
          <InCallChat
            channelId={channelId}
            threadParent={threadParent}
            identity={identity}
            onClose={() => setShowChat(false)}
          />
        )}
      </div>

      <Controls
        muted={muted}
        cameraOff={cameraOff}
        screenSharing={screenSharing}
        onMute={handleMute}
        onCamera={handleCamera}
        onScreenShare={handleScreenShare}
        onLeave={handleLeave}
        onToggleRoster={() => setShowRoster((v) => !v)}
        rosterActive={showRoster}
        onToggleChat={channelId ? () => setShowChat((v) => !v) : null}
        chatActive={showChat}
      />
    </div>
  )
}

// ScreenShareView — prominent area at 55% height
function ScreenShareView({ isLocal, localRef, presenterPeer, presenterLabel }) {
  const remoteRef = useRef(null)
  useEffect(() => {
    if (!isLocal && remoteRef.current && presenterPeer?.stream) {
      if (remoteRef.current.srcObject !== presenterPeer.stream) {
        remoteRef.current.srcObject = presenterPeer.stream
      }
    }
  }, [isLocal, presenterPeer?.stream])

  return (
    <div
      className="relative mx-3 mt-3 rounded-lg overflow-hidden flex-shrink-0 border border-paper/10"
      style={{ height: '55%', minHeight: 200, background: '#000' }}
    >
      {isLocal ? (
        <video ref={localRef} autoPlay playsInline muted className="w-full h-full object-contain" />
      ) : (
        <video ref={remoteRef} autoPlay playsInline className="w-full h-full object-contain" />
      )}
      <div
        className="absolute top-2 left-3 flex items-center gap-1.5 px-2 py-1 rounded-pill text-2xs text-paper tracking-tightish"
        style={{ background: 'rgba(26,25,22,.6)' }}
      >
        <Monitor size={11} className="text-accent" />
        <span>{presenterLabel} is presenting</span>
        {isLocal && (
          <span className="ml-1 bg-accent text-white px-1.5 py-0.5 rounded-xs text-[9px] font-semibold uppercase tracking-eyebrow">
            You
          </span>
        )}
      </div>
    </div>
  )
}

function CallHeader({ state, transport, participantCount, onToggleRoster }) {
  const stateLabel =
    state === 'connecting' ? 'Connecting…' :
    state === 'connected' ? 'Connected' :
    state === 'closed' ? 'Call ended' : state

  const relay = transport === 'relay'
  return (
    <div className="px-4 h-11 flex items-center gap-3 text-xs border-b border-paper/10">
      <span className="text-paper/80 tracking-tightish">{stateLabel}</span>
      <span
        className={[
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-2xs font-medium tracking-tightish',
          relay
            ? 'bg-warning/15 text-warning border border-warning/30'
            : 'bg-accent/15 text-accent border border-accent/30',
        ].join(' ')}
      >
        {relay ? <WifiOff size={11} /> : <Wifi size={11} />}
        <span>{relay ? 'Relay (TURN)' : 'P2P'}</span>
      </span>
      <button
        type="button"
        onClick={onToggleRoster}
        className="ml-auto inline-flex items-center gap-1 text-paper/70 hover:text-paper transition-colors duration-fast"
        title="Participants"
      >
        <Users size={13} />
        <span className="tracking-tightish">{participantCount}</span>
      </button>
    </div>
  )
}

function Tile({ label, muted, cameraOff, isLocal, videoRef, color, isPresenting }) {
  return (
    <div
      className="relative rounded-lg overflow-hidden flex items-center justify-center min-h-[140px]"
      style={{
        background: 'rgba(255,255,255,.04)',
        outline: isPresenting
          ? '2px solid var(--accent)'
          : color
            ? `2px solid ${color}`
            : '1px solid rgba(255,255,255,.06)',
        outlineOffset: '-2px',
      }}
    >
      {!cameraOff && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className="w-full h-full object-cover"
        />
      )}
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
          {isPresenting && <Monitor size={10} className="text-accent" />}
          {label}
        </span>
        {muted && (
          <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-pill"
            style={{ background: 'rgba(26,25,22,.55)' }}
            title="Muted"
          >
            <MicOff size={11} />
          </span>
        )}
      </div>
    </div>
  )
}

function RemoteTile({ peer, isSpeaking }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current && peer.stream && ref.current.srcObject !== peer.stream) {
      ref.current.srcObject = peer.stream
    }
  }, [peer.stream])
  const label = peer.identity?.displayName || peer.peerId.slice(0, 6)
  const noVideo = !peer.stream || peer.stream.getVideoTracks().every((t) => !t.enabled)
  return (
    <div
      className="relative rounded-lg overflow-hidden flex items-center justify-center min-h-[140px] transition-[outline] duration-fast ease-out"
      style={{
        background: 'rgba(255,255,255,.04)',
        outline: peer.isPresenting
          ? '2px solid var(--accent)'
          : isSpeaking
            ? '2px solid var(--accent)'
            : '1px solid rgba(255,255,255,.06)',
        outlineOffset: '-2px',
      }}
    >
      <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />
      {noVideo && (
        <div className="absolute inset-0 flex items-center justify-center text-paper/40 text-3xl uppercase font-semibold tracking-tightish">
          {label.slice(0, 1)}
        </div>
      )}
      <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-2xs">
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill tracking-tightish text-paper"
          style={{ background: 'rgba(26,25,22,.55)' }}
        >
          {peer.isPresenting && <Monitor size={10} className="text-accent" />}
          {label}
        </span>
        {peer.usingRelay && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-pill text-[10px] font-medium uppercase tracking-eyebrow"
            style={{
              background: 'rgba(192,132,54,.18)',
              color: 'var(--signal-warning)',
              border: '1px solid rgba(192,132,54,.35)',
            }}
          >
            relay
          </span>
        )}
      </div>
    </div>
  )
}

function Roster({ peers, self, activeSpeaker, screenPresenter }) {
  return (
    <aside className="w-60 border-l border-paper/10 overflow-y-auto p-3 text-sm">
      <h3 className="text-2xs uppercase text-paper/50 mb-2 tracking-eyebrow font-semibold">
        Participants ({peers.length + 1})
      </h3>
      <ul className="space-y-1">
        <li className="flex items-center justify-between py-1 text-paper/90">
          <span className="inline-flex items-center gap-1.5 tracking-tightish">
            {screenPresenter === 'local' && <Monitor size={12} className="text-accent" />}
            <span className="font-serif italic">{self?.displayName || 'You'}</span>
            <span className="text-paper/40 text-2xs">(you)</span>
          </span>
        </li>
        {peers.map((p) => (
          <li key={p.peerId} className="flex items-center justify-between py-1">
            <span
              className={[
                'inline-flex items-center gap-1.5 tracking-tightish',
                activeSpeaker === p.peerId ? 'text-accent' : 'text-paper/85',
              ].join(' ')}
            >
              {p.isPresenting && <Monitor size={12} className="text-accent" />}
              <span className="font-serif italic">
                {p.identity?.displayName || p.peerId.slice(0, 6)}
              </span>
            </span>
            <span className="text-[10px] text-paper/40 uppercase tracking-eyebrow">
              {p.usingRelay ? 'relay' : p.state}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

// DockButton — IconButton-style affordance, themed for the dark call surface.
function DockButton({ onClick, active, title, children }) {
  return (
    <Tooltip label={title} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        aria-pressed={active ? 'true' : 'false'}
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

function Controls({
  muted, cameraOff, screenSharing,
  onMute, onCamera, onScreenShare, onLeave,
  onToggleRoster, rosterActive,
  onToggleChat, chatActive,
}) {
  return (
    <div className="px-4 py-3 border-t border-paper/10 flex items-center justify-center">
      <div
        className="inline-flex items-center gap-2 px-2 py-1.5 rounded-lg border border-paper/10"
        style={{ background: 'rgba(255,255,255,.04)' }}
      >
        <DockButton onClick={onMute} active={muted} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? <MicOff size={17} /> : <Mic size={17} />}
        </DockButton>
        <DockButton onClick={onCamera} active={cameraOff} title={cameraOff ? 'Camera on' : 'Camera off'}>
          {cameraOff ? <VideoOff size={17} /> : <Video size={17} />}
        </DockButton>
        <DockButton onClick={onScreenShare} active={screenSharing} title={screenSharing ? 'Stop sharing' : 'Share screen'}>
          {screenSharing ? <MonitorOff size={17} /> : <Monitor size={17} />}
        </DockButton>
        <span className="w-px h-6 bg-paper/10 mx-1" aria-hidden />
        <DockButton onClick={onToggleRoster} active={rosterActive} title="Participants">
          <Users size={17} />
        </DockButton>
        {onToggleChat && (
          <DockButton onClick={onToggleChat} active={chatActive} title="In-call chat">
            <MessageSquare size={17} />
          </DockButton>
        )}
        <span className="w-px h-6 bg-paper/10 mx-1" aria-hidden />
        <Tooltip label="Leave call" side="top">
          <button
            type="button"
            onClick={onLeave}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-md bg-danger text-white hover:opacity-90 text-sm font-medium tracking-tightish transition-opacity duration-fast focus-visible:outline-none focus-visible:shadow-focus"
          >
            <PhoneOff size={16} />
            <span>Leave</span>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
