import '@testing-library/jest-dom'

// ── jsdom has no layout engine ──────────────────────────────────────────────
// ProseMirror asks the DOM for geometry when it scrolls the selection into view
// (coordsAtPos → singleRect → getClientRects). jsdom does not implement
// Range.getClientRects, so any test that mounts a REAL TipTap editor and types
// into it throws "target.getClientRects is not a function" out of the view layer
// — an uncaught error that fails the run even though every assertion passed.
// Stub the geometry with empty rects: ProseMirror reads "no rects" as "nothing
// to scroll to" and carries on. This only ADDS methods jsdom leaves undefined;
// it never overrides real behaviour.
const emptyRectList = () => Object.assign([], { item: () => null })
const zeroRect = () => ({
  top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON: () => ({}),
})

for (const proto of [Range.prototype, Element.prototype]) {
  if (typeof proto.getClientRects !== 'function') proto.getClientRects = emptyRectList
  if (typeof proto.getBoundingClientRect !== 'function') proto.getBoundingClientRect = zeroRect
}

// Same reason: jsdom has no hit-testing, so ProseMirror's mousedown handler
// (posAtCoords → elementFromPoint) throws on any click into a live editor.
// Returning null is the documented "no element at this point" answer, which
// ProseMirror handles by leaving the selection where it is.
if (typeof Document.prototype.elementFromPoint !== 'function') {
  Document.prototype.elementFromPoint = () => null
}
