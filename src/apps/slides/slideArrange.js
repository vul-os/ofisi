/**
 * slideArrange.js — pure arrange operations for positioned objects (P3).
 *
 * Every function takes (objects, selectedIds, ...) and returns a NEW objects
 * array (never mutates). Kept framework-free + pure so they are directly
 * unit-testable and reusable by the contextual toolbar.
 */

import { newObjectId, sortByZ, normalizeZ } from './slideObjects'

// ── z-order ─────────────────────────────────────────────────────────────────
export function bringToFront(objects, ids) {
  const maxZ = Math.max(0, ...objects.map((o) => o.z || 0))
  let n = 1
  return normalizeZ(objects.map((o) => (ids.includes(o.id) ? { ...o, z: maxZ + (n++) } : o)))
}
export function sendToBack(objects, ids) {
  const minZ = Math.min(0, ...objects.map((o) => o.z || 0))
  let n = 1
  return normalizeZ(objects.map((o) => (ids.includes(o.id) ? { ...o, z: minZ - (n++) } : o)))
}
export function bringForward(objects, ids) {
  // Nudge each selected object up one slot in the z-sorted stack.
  const sorted = sortByZ(objects)
  const order = sorted.map((o) => o.id)
  for (let i = order.length - 2; i >= 0; i--) {
    if (ids.includes(order[i]) && !ids.includes(order[i + 1])) {
      [order[i], order[i + 1]] = [order[i + 1], order[i]]
    }
  }
  return applyOrder(objects, order)
}
export function sendBackward(objects, ids) {
  const sorted = sortByZ(objects)
  const order = sorted.map((o) => o.id)
  for (let i = 1; i < order.length; i++) {
    if (ids.includes(order[i]) && !ids.includes(order[i - 1])) {
      [order[i], order[i - 1]] = [order[i - 1], order[i]]
    }
  }
  return applyOrder(objects, order)
}
function applyOrder(objects, order) {
  const zById = new Map()
  order.forEach((id, i) => zById.set(id, i + 1))
  return objects.map((o) => ({ ...o, z: zById.get(o.id) ?? o.z }))
}

// ── group / ungroup ──────────────────────────────────────────────────────────
export function groupObjects(objects, ids) {
  if (ids.length < 2) return objects
  const gid = newObjectId()
  return objects.map((o) => (ids.includes(o.id) ? { ...o, group: gid } : o))
}
export function ungroupObjects(objects, ids) {
  // Remove the group tag from any object in a group touched by the selection.
  const groups = new Set(objects.filter((o) => ids.includes(o.id) && o.group).map((o) => o.group))
  return objects.map((o) => {
    if (o.group && groups.has(o.group)) {
      const { group, ...rest } = o
      return rest
    }
    return o
  })
}
/** Expand a selection to include every sibling of any grouped selected object. */
export function expandSelectionToGroups(objects, ids) {
  const groups = new Set(objects.filter((o) => ids.includes(o.id) && o.group).map((o) => o.group))
  if (groups.size === 0) return ids
  const set = new Set(ids)
  for (const o of objects) if (o.group && groups.has(o.group)) set.add(o.id)
  return [...set]
}

// ── align ─────────────────────────────────────────────────────────────────
// When ≥2 objects are selected, align relative to the selection bounding box;
// with a single object, align relative to the slide (0..1).
export function align(objects, ids, edge) {
  const sel = objects.filter((o) => ids.includes(o.id))
  if (sel.length === 0) return objects
  const single = sel.length === 1
  const minX = single ? 0 : Math.min(...sel.map((o) => o.x))
  const maxX = single ? 1 : Math.max(...sel.map((o) => o.x + o.w))
  const minY = single ? 0 : Math.min(...sel.map((o) => o.y))
  const maxY = single ? 1 : Math.max(...sel.map((o) => o.y + o.h))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return objects.map((o) => {
    if (!ids.includes(o.id)) return o
    switch (edge) {
      case 'left':   return { ...o, x: minX }
      case 'right':  return { ...o, x: maxX - o.w }
      case 'center': return { ...o, x: cx - o.w / 2 }
      case 'top':    return { ...o, y: minY }
      case 'bottom': return { ...o, y: maxY - o.h }
      case 'middle': return { ...o, y: cy - o.h / 2 }
      default:       return o
    }
  })
}

// ── distribute ──────────────────────────────────────────────────────────────
// Even spacing of centres between the first and last object along an axis.
export function distribute(objects, ids, axis) {
  const sel = objects.filter((o) => ids.includes(o.id))
  if (sel.length < 3) return objects
  const key = axis === 'horizontal' ? 'x' : 'y'
  const sizeKey = axis === 'horizontal' ? 'w' : 'h'
  const sorted = [...sel].sort((a, b) => (a[key] + a[sizeKey] / 2) - (b[key] + b[sizeKey] / 2))
  const firstC = sorted[0][key] + sorted[0][sizeKey] / 2
  const lastC = sorted[sorted.length - 1][key] + sorted[sorted.length - 1][sizeKey] / 2
  const gap = (lastC - firstC) / (sorted.length - 1)
  const newCentre = new Map()
  sorted.forEach((o, i) => newCentre.set(o.id, firstC + gap * i))
  return objects.map((o) => {
    if (!newCentre.has(o.id)) return o
    return { ...o, [key]: newCentre.get(o.id) - o[sizeKey] / 2 }
  })
}
