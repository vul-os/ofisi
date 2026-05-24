/**
 * speakerGrid.js — responsive tile-grid layout helper for Vulos Meet.
 *
 * Returns Tailwind-friendly inline grid styles for a given tile count that
 * adapt to viewport width. The breakpoint targets are:
 *
 *   1 tile  → 1×1
 *   2       → 2×1
 *   3-4     → 2×2
 *   5-9     → 3×3
 *   10-16   → 4×4
 *   17-25   → 5×5
 *
 * On narrow viewports we cap columns to 1 (mobile) then 2 (≤640px) so faces
 * stay legible. Beyond 25 tiles we keep 5 columns and let the grid grow rows.
 *
 * Usage:
 *   const { style } = gridLayout(tileCount, viewportWidth)
 *   <div className="grid gap-2 p-3 overflow-auto" style={style}>...</div>
 *
 * The helper is exported as a plain function so it works in tests + storybook.
 */

export function gridColumnsFor(tileCount, viewportWidth = 1024) {
  if (tileCount <= 0) return 1
  if (viewportWidth <= 480) return 1
  if (viewportWidth <= 768) return tileCount <= 1 ? 1 : 2

  // Desktop ladder.
  if (tileCount <= 1) return 1
  if (tileCount <= 2) return 2
  if (tileCount <= 4) return 2
  if (tileCount <= 9) return 3
  if (tileCount <= 16) return 4
  return 5
}

export function gridLayout(tileCount, viewportWidth) {
  const cols = gridColumnsFor(tileCount, viewportWidth)
  return {
    cols,
    style: {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridAutoRows: 'minmax(140px, 1fr)',
    },
  }
}

/**
 * useViewportWidth — minimal SSR-safe hook returning the live window width.
 * Exported separately so non-React callers can use gridLayout() directly.
 */
import { useEffect, useState } from 'react'

export function useViewportWidth() {
  const get = () =>
    (typeof window !== 'undefined' && window.innerWidth) || 1024
  const [w, setW] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setW(window.innerWidth)
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return w
}
