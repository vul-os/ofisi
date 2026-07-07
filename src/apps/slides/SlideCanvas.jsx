/**
 * SlideCanvas.jsx — free-positioning object canvas for Vulos Slides (P2/P3/P4).
 *
 * Renders a slide's positioned objects on a fixed-aspect (16:9) stage. Objects
 * are absolutely positioned in normalized [0,1] slide space (see slideObjects.js)
 * and scaled to the measured stage px. Supports:
 *   • select (click), multi-select (shift-click + marquee)
 *   • drag-move, resize (8 handles), rotate
 *   • keyboard nudge / delete / escape
 *   • smart-alignment guides + snapping while dragging
 *
 * SECURITY: object content is rendered through React with sanitized HTML only
 * (text via dangerouslySetInnerHTML on ALREADY-sanitized html; image src gated;
 * shapes are pure SVG with clamped numeric geometry). No raw untrusted values
 * reach the DOM without passing sanitizeObjects()/sanitizeObject() upstream.
 *
 * This component is presentation + interaction; it does NOT own the objects
 * array. The parent (SlidesEditor) holds state + persists to the CRDT tree and
 * passes objects down with an onChange(nextObjects, opts) callback.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  MIN_OBJECT_SIZE, sortByZ, sanitizeObject,
} from './slideObjects'
import ShapeSvg from './ShapeSvg.jsx'

const ASPECT = 9 / 16          // stage height / width
const HANDLE = 8               // handle hit size (px)
const SNAP_PX = 6              // snap threshold in stage px
const NUDGE = 0.005            // keyboard nudge step (fraction)

// 8 resize handles: corners + edge midpoints. dx/dy are the unit direction the
// handle pulls (in object-local, unrotated space).
const HANDLES = [
  { key: 'nw', dx: -1, dy: -1, cursor: 'nwse-resize' },
  { key: 'n',  dx: 0,  dy: -1, cursor: 'ns-resize' },
  { key: 'ne', dx: 1,  dy: -1, cursor: 'nesw-resize' },
  { key: 'e',  dx: 1,  dy: 0,  cursor: 'ew-resize' },
  { key: 'se', dx: 1,  dy: 1,  cursor: 'nwse-resize' },
  { key: 's',  dx: 0,  dy: 1,  cursor: 'ns-resize' },
  { key: 'sw', dx: -1, dy: 1,  cursor: 'nesw-resize' },
  { key: 'w',  dx: -1, dy: 0,  cursor: 'ew-resize' },
]

export default function SlideCanvas({
  objects,
  background,
  selectedIds = [],
  onSelect,           // (ids: string[]) => void
  onChange,           // (nextObjects, { commit }) => void
  onEditText,         // (id) => void — double-click a text object to edit
  editable = true,
  className = '',
  overlay = null,     // optional node rendered inside the stage (e.g. text editor)
}) {
  const stageRef = useRef(null)
  const [stageSize, setStageSize] = useState({ w: 960, h: 540 })
  const [guides, setGuides] = useState({ v: [], h: [] })
  const [marquee, setMarquee] = useState(null) // {x,y,w,h} in fractions or null

  // ── Measure the stage so px⇄fraction conversion is exact ──────────────────
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0) setStageSize({ w: r.width, h: r.height })
    }
    measure()
    let ro
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const ordered = sortByZ(objects || [])
  const selSet = new Set(selectedIds)

  // Convert a pointer event to stage-fraction coords.
  const toFrac = useCallback((e) => {
    const r = stageRef.current.getBoundingClientRect()
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    }
  }, [])

  // ── Drag-move ─────────────────────────────────────────────────────────────
  const dragRef = useRef(null)
  const startMove = (e, obj) => {
    if (!editable) return
    e.stopPropagation()
    const additive = e.shiftKey
    let sel = selectedIds
    if (!selSet.has(obj.id)) {
      sel = additive ? [...selectedIds, obj.id] : [obj.id]
      onSelect?.(sel)
    } else if (additive) {
      sel = selectedIds.filter((i) => i !== obj.id)
      onSelect?.(sel)
      return
    }
    const start = toFrac(e)
    const moving = (objects || []).filter((o) => sel.includes(o.id))
    dragRef.current = {
      kind: 'move', start,
      origins: moving.map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h })),
      ids: moving.map((o) => o.id),
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  // ── Resize ────────────────────────────────────────────────────────────────
  const startResize = (e, obj, handle) => {
    if (!editable) return
    e.stopPropagation()
    const start = toFrac(e)
    dragRef.current = {
      kind: 'resize', start, handle,
      origin: { id: obj.id, x: obj.x, y: obj.y, w: obj.w, h: obj.h },
      keepAspect: e.shiftKey,
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  // ── Rotate ────────────────────────────────────────────────────────────────
  const startRotate = (e, obj) => {
    if (!editable) return
    e.stopPropagation()
    const r = stageRef.current.getBoundingClientRect()
    const cx = (obj.x + obj.w / 2) * r.width + r.left
    const cy = (obj.y + obj.h / 2) * r.height + r.top
    dragRef.current = {
      kind: 'rotate', cx, cy,
      origin: { id: obj.id, rotation: obj.rotation || 0 },
      startAngle: Math.atan2(e.clientY - cy, e.clientX - cx),
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const cur = toFrac(e)

    if (d.kind === 'move') {
      let dxF = cur.x - d.start.x
      let dyF = cur.y - d.start.y
      // Smart guides + snapping against non-selected objects.
      const primary = d.origins[0]
      const movedPrimary = { ...primary, x: primary.x + dxF, y: primary.y + dyF }
      const snap = computeSnap(movedPrimary, objects, d.ids, stageSize)
      dxF += snap.dx
      dyF += snap.dy
      setGuides(snap.guides)
      const next = (objects || []).map((o) => {
        const org = d.origins.find((g) => g.id === o.id)
        if (!org) return o
        return { ...o, x: org.x + dxF, y: org.y + dyF }
      })
      onChange?.(next, { commit: false })
    } else if (d.kind === 'resize') {
      const { origin, handle } = d
      let { x, y, w, h } = origin
      const dxF = cur.x - d.start.x
      const dyF = cur.y - d.start.y
      if (handle.dx < 0) { x = origin.x + dxF; w = origin.w - dxF }
      if (handle.dx > 0) { w = origin.w + dxF }
      if (handle.dy < 0) { y = origin.y + dyF; h = origin.h - dyF }
      if (handle.dy > 0) { h = origin.h + dyF }
      // Clamp minimums; keep the anchored edge fixed when a min is hit.
      if (w < MIN_OBJECT_SIZE) { if (handle.dx < 0) x = origin.x + origin.w - MIN_OBJECT_SIZE; w = MIN_OBJECT_SIZE }
      if (h < MIN_OBJECT_SIZE) { if (handle.dy < 0) y = origin.y + origin.h - MIN_OBJECT_SIZE; h = MIN_OBJECT_SIZE }
      const next = (objects || []).map((o) => (o.id === origin.id ? { ...o, x, y, w, h } : o))
      onChange?.(next, { commit: false })
    } else if (d.kind === 'rotate') {
      const ang = Math.atan2(e.clientY - d.cy, e.clientX - d.cx)
      let deg = d.origin.rotation + (ang - d.startAngle) * 180 / Math.PI
      if (e.shiftKey) deg = Math.round(deg / 15) * 15  // snap 15°
      deg = ((deg % 360) + 360) % 360
      const next = (objects || []).map((o) => (o.id === d.origin.id ? { ...o, rotation: deg } : o))
      onChange?.(next, { commit: false })
    }
  }, [objects, onChange, stageSize, toFrac])

  const onPointerUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null
      setGuides({ v: [], h: [] })
      onChange?.(objects, { commit: true })  // commit last state to CRDT
    }
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }, [objects, onChange, onPointerMove])

  // ── Marquee selection on empty-stage drag ─────────────────────────────────
  const marqueeRef = useRef(null)
  const startMarquee = (e) => {
    if (!editable || e.button !== 0) return
    if (e.target !== stageRef.current && !e.target.classList.contains('vslide-stage-bg')) return
    if (!e.shiftKey) onSelect?.([])
    const start = toFrac(e)
    marqueeRef.current = { start, additive: e.shiftKey, base: selectedIds }
    window.addEventListener('pointermove', onMarqueeMove)
    window.addEventListener('pointerup', onMarqueeUp)
  }
  const onMarqueeMove = useCallback((e) => {
    const m = marqueeRef.current
    if (!m) return
    const cur = toFrac(e)
    const box = {
      x: Math.min(m.start.x, cur.x), y: Math.min(m.start.y, cur.y),
      w: Math.abs(cur.x - m.start.x), h: Math.abs(cur.y - m.start.y),
    }
    setMarquee(box)
    const hit = (objects || []).filter((o) =>
      o.x < box.x + box.w && o.x + o.w > box.x && o.y < box.y + box.h && o.y + o.h > box.y
    ).map((o) => o.id)
    onSelect?.(m.additive ? [...new Set([...m.base, ...hit])] : hit)
  }, [objects, onSelect])
  const onMarqueeUp = useCallback(() => {
    marqueeRef.current = null
    setMarquee(null)
    window.removeEventListener('pointermove', onMarqueeMove)
    window.removeEventListener('pointerup', onMarqueeUp)
  }, [onMarqueeMove])

  // ── Keyboard: nudge / delete / escape ─────────────────────────────────────
  useEffect(() => {
    if (!editable) return
    const onKey = (e) => {
      if (selectedIds.length === 0) return
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return
      let dx = 0, dy = 0
      const step = e.shiftKey ? NUDGE * 4 : NUDGE
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else if (e.key === 'Escape') { onSelect?.([]); return }
      else return
      e.preventDefault(); e.stopPropagation()
      const next = (objects || []).map((o) =>
        selectedIds.includes(o.id) ? { ...o, x: o.x + dx, y: o.y + dy } : o)
      onChange?.(next, { commit: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editable, selectedIds, objects, onChange, onSelect])

  const px = (fracW, fracH) => ({
    left: `${fracW * 100}%`, top: `${fracH * 100}%`,
  })

  return (
    <div className={`vslide-canvas-wrap ${className}`} style={{ width: '100%' }}>
      <div
        ref={stageRef}
        className="vslide-stage relative overflow-hidden rounded-lg shadow-e3 border border-line"
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          background: background || 'var(--paper)',
        }}
        onPointerDown={startMarquee}
        role="group"
        aria-label="Slide canvas"
      >
        {/* transparent bg hit layer so clicks on empty space deselect */}
        <div className="vslide-stage-bg absolute inset-0" aria-hidden="true" />

        {ordered.map((obj) => {
          const selected = selSet.has(obj.id)
          return (
            <div
              key={obj.id}
              data-object-id={obj.id}
              role="button"
              tabIndex={editable ? 0 : -1}
              aria-label={`${obj.type} object`}
              aria-pressed={selected}
              className={[
                'vslide-object absolute',
                editable ? 'cursor-move' : '',
                selected ? 'outline outline-2 outline-accent' : '',
              ].join(' ')}
              style={{
                left: `${obj.x * 100}%`,
                top: `${obj.y * 100}%`,
                width: `${obj.w * 100}%`,
                height: `${obj.h * 100}%`,
                transform: `rotate(${obj.rotation || 0}deg)`,
                transformOrigin: 'center center',
                zIndex: obj.z || 1,
              }}
              onPointerDown={(e) => startMove(e, obj)}
              onDoubleClick={(e) => { e.stopPropagation(); if (obj.type === 'text') onEditText?.(obj.id) }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter') && obj.type === 'text') { e.preventDefault(); onEditText?.(obj.id) }
              }}
            >
              <ObjectBody obj={obj} stageW={stageSize.w} />
            </div>
          )
        })}

        {/* Selection chrome (handles + rotate) for the single selected object */}
        {editable && selectedIds.length === 1 && (() => {
          const obj = (objects || []).find((o) => o.id === selectedIds[0])
          if (!obj) return null
          return (
            <div
              className="vslide-selbox absolute pointer-events-none"
              style={{
                left: `${obj.x * 100}%`, top: `${obj.y * 100}%`,
                width: `${obj.w * 100}%`, height: `${obj.h * 100}%`,
                transform: `rotate(${obj.rotation || 0}deg)`,
                transformOrigin: 'center center',
                zIndex: MAX_CHROME_Z,
              }}
            >
              {HANDLES.map((h) => (
                <div
                  key={h.key}
                  className="absolute bg-paper border border-accent rounded-xs pointer-events-auto"
                  style={{
                    width: HANDLE, height: HANDLE, cursor: h.cursor,
                    left: `calc(${(h.dx + 1) * 50}% - ${HANDLE / 2}px)`,
                    top: `calc(${(h.dy + 1) * 50}% - ${HANDLE / 2}px)`,
                  }}
                  onPointerDown={(e) => startResize(e, obj, h)}
                  aria-label={`Resize ${h.key}`}
                />
              ))}
              {/* Rotate handle above the top edge */}
              <div
                className="absolute bg-accent rounded-pill pointer-events-auto"
                style={{
                  width: 10, height: 10, cursor: 'grab',
                  left: `calc(50% - 5px)`, top: -22,
                }}
                onPointerDown={(e) => startRotate(e, obj)}
                aria-label="Rotate"
              />
              <div className="absolute bg-accent" style={{ width: 1, height: 17, left: 'calc(50% - 0.5px)', top: -17 }} aria-hidden="true" />
            </div>
          )
        })()}

        {/* Multi-select bounding outline */}
        {editable && selectedIds.length > 1 && (() => {
          const sel = (objects || []).filter((o) => selectedIds.includes(o.id))
          if (sel.length === 0) return null
          const minX = Math.min(...sel.map((o) => o.x))
          const minY = Math.min(...sel.map((o) => o.y))
          const maxX = Math.max(...sel.map((o) => o.x + o.w))
          const maxY = Math.max(...sel.map((o) => o.y + o.h))
          return (
            <div
              className="absolute pointer-events-none border border-dashed border-accent/70"
              style={{
                left: `${minX * 100}%`, top: `${minY * 100}%`,
                width: `${(maxX - minX) * 100}%`, height: `${(maxY - minY) * 100}%`,
                zIndex: MAX_CHROME_Z,
              }}
              aria-hidden="true"
            />
          )
        })()}

        {/* Smart-alignment guides */}
        {guides.v.map((gx, i) => (
          <div key={`v${i}`} className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: `${gx * 100}%`, width: 1, background: 'var(--accent)', zIndex: MAX_CHROME_Z + 1 }} aria-hidden="true" />
        ))}
        {guides.h.map((gy, i) => (
          <div key={`h${i}`} className="absolute left-0 right-0 pointer-events-none"
            style={{ top: `${gy * 100}%`, height: 1, background: 'var(--accent)', zIndex: MAX_CHROME_Z + 1 }} aria-hidden="true" />
        ))}

        {/* Marquee rectangle */}
        {marquee && (
          <div className="absolute pointer-events-none border border-accent bg-accent/10"
            style={{
              left: `${marquee.x * 100}%`, top: `${marquee.y * 100}%`,
              width: `${marquee.w * 100}%`, height: `${marquee.h * 100}%`,
              zIndex: MAX_CHROME_Z + 2,
            }} aria-hidden="true" />
        )}

        {/* Optional overlay (e.g. inline text editor) — inside the stage so it
            uses the same normalized coordinate box. */}
        {overlay}
      </div>
    </div>
  )
}

const MAX_CHROME_Z = 200000

/** Render an object's inner content. SECURITY: html is pre-sanitized upstream. */
function ObjectBody({ obj, stageW }) {
  if (obj.type === 'text') {
    const alignItems = obj.valign === 'middle' ? 'center' : obj.valign === 'bottom' ? 'flex-end' : 'flex-start'
    return (
      <div
        className="vslide-text w-full h-full overflow-hidden"
        style={{
          display: 'flex', flexDirection: 'column',
          justifyContent: alignItems,
          textAlign: obj.align || 'left',
          // Scale text with the stage so it reads consistently across sizes.
          fontSize: `${Math.max(10, stageW * 0.028)}px`,
          padding: '2%',
        }}
        // eslint-disable-next-line react/no-danger — html is sanitizeSlideHtml()'d
        // at every ingress (sanitizeObject + ensureObjects); never raw peer input.
        dangerouslySetInnerHTML={{ __html: obj.html || '' }}
      />
    )
  }
  if (obj.type === 'image') {
    // src gated by isSafeImageSrc in sanitizeObject; safe to render.
    return (
      <img
        src={obj.src}
        alt=""
        className="w-full h-full"
        style={{ objectFit: 'contain', pointerEvents: 'none' }}
        draggable={false}
      />
    )
  }
  if (obj.type === 'shape') {
    return <ShapeSvg obj={obj} />
  }
  return null
}

// ── Smart-guide + snapping ─────────────────────────────────────────────────
// Compares the moving object's edges/centre against every other object's
// edges/centres AND the slide centre; returns a small correction + guide lines.
function computeSnap(moved, objects, movingIds, stageSize) {
  const snapFracX = SNAP_PX / (stageSize.w || 960)
  const snapFracY = SNAP_PX / (stageSize.h || 540)
  const targetsX = [0.5] // slide vertical centre
  const targetsY = [0.5]
  for (const o of objects || []) {
    if (movingIds.includes(o.id)) continue
    targetsX.push(o.x, o.x + o.w / 2, o.x + o.w)
    targetsY.push(o.y, o.y + o.h / 2, o.y + o.h)
  }
  const movEdgesX = [moved.x, moved.x + moved.w / 2, moved.x + moved.w]
  const movEdgesY = [moved.y, moved.y + moved.h / 2, moved.y + moved.h]

  let bestDx = 0, bestDistX = snapFracX
  const vGuides = []
  for (const me of movEdgesX) {
    for (const t of targetsX) {
      const dist = Math.abs(me - t)
      if (dist <= bestDistX) { bestDistX = dist; bestDx = t - me; }
    }
  }
  if (bestDx !== 0 || bestDistX < snapFracX) {
    for (const t of targetsX) {
      if (movEdgesX.some((me) => Math.abs(me + bestDx - t) < 0.001)) vGuides.push(t)
    }
  }
  let bestDy = 0, bestDistY = snapFracY
  const hGuides = []
  for (const me of movEdgesY) {
    for (const t of targetsY) {
      const dist = Math.abs(me - t)
      if (dist <= bestDistY) { bestDistY = dist; bestDy = t - me; }
    }
  }
  if (bestDy !== 0 || bestDistY < snapFracY) {
    for (const t of targetsY) {
      if (movEdgesY.some((me) => Math.abs(me + bestDy - t) < 0.001)) hGuides.push(t)
    }
  }
  return { dx: bestDx, dy: bestDy, guides: { v: [...new Set(vGuides)], h: [...new Set(hGuides)] } }
}

// Re-export so callers can build objects safely.
export { sanitizeObject }
