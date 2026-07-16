/**
 * useTheme — tiny hook for explicit light/dark/system theme toggling.
 *
 * Storage:
 *   localStorage 'ofisi.theme' = 'light' | 'dark' | 'system' (default)
 *
 * Side-effects:
 *   Always resolves to a concrete [data-theme="light"|"dark"] on <html> — in
 *   'system' mode it reads prefers-color-scheme and follows OS changes live.
 *   Ofisi is LIGHT by default (the token :root), so an absent attribute would
 *   read light; resolving explicitly keeps 'system' honest for OS-dark users.
 */

import { useEffect, useState, useCallback } from 'react'

const STORE_KEY = 'ofisi.theme'
// Back-compat: honour a previously-persisted key from the old brand.
const LEGACY_KEY = 'vulos.theme'

function osPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme
  return osPrefersDark() ? 'dark' : 'light'
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme))
}

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_KEY) || 'system' } catch { return 'system' }
  })

  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(STORE_KEY, theme) } catch {}
    // In 'system' mode, follow live OS theme changes.
    if (theme !== 'system') return
    let mq
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch { return }
    const onChange = () => applyTheme('system')
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [theme])

  const cycle = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'))
  }, [])

  return { theme, setTheme, cycle }
}
