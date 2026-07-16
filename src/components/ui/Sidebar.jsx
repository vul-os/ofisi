/**
 * Sidebar primitives — Ofisi's warm vertical app rail (sand chrome on ivory).
 *
 * Pieces:
 *   - <Sidebar>             root container; manages width (collapsed/expanded)
 *   - <Sidebar.Brand>       Ofisi mark + serif wordmark (fades collapsed)
 *   - <Sidebar.Section>     labelled group; mono uppercase label, hides collapsed
 *   - <Sidebar.Item>        nav row; ember left-rail + calm tint when active,
 *                           optional per-app icon tint at rest
 *   - <Sidebar.Footer>      sticky bottom region (settings, collapse toggle…)
 *
 * Design DNA:
 *   - Surface is warm sand, one step off the ivory canvas, with a hairline edge.
 *   - Active = a 2.5px ember left-rail + a calm accent-tint bg (no coloured
 *     border) + the icon brightening to ember. The rail marks, it doesn't box.
 *   - At rest, app icons carry one calm tint each (iconAccent) so
 *     Docs/Sheets/Slides/Board/PDF are findable at a glance.
 *   - Mono uppercase section labels; width transitions 200ms so it feels considered.
 */

import { createContext, useContext } from 'react'
import { NavLink } from 'react-router-dom'

const SidebarCtx = createContext({ collapsed: false })

/**
 * OfisiMark — the brand glyph: an ember rounded tile with an ivory "O" ring.
 * Self-contained inline SVG (no asset request), so it's crisp at any size and
 * inherits the warm palette. Reused by the rail brand + the mobile header.
 */
export function OfisiMark({ size = 32, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="ofisi-mark-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E86A3E" />
          <stop offset="1" stopColor="#CF4620" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#ofisi-mark-grad)" />
      <circle cx="16" cy="16" r="8.4" fill="none" stroke="#FBF3E9" strokeWidth="4.4" />
      <circle cx="16" cy="16" r="2.2" fill="#FBF3E9" />
    </svg>
  )
}

function Sidebar({ collapsed, children, className = '' }) {
  return (
    <SidebarCtx.Provider value={{ collapsed }}>
      <aside
        className={[
          'relative flex flex-col flex-shrink-0',
          'bg-bg-elev2 text-ink-muted border-r border-line',
          'transition-[width] duration-base ease-out',
          collapsed ? 'w-[60px]' : 'w-[244px]',
          className,
        ].join(' ')}
      >
        {children}
      </aside>
    </SidebarCtx.Provider>
  )
}

Sidebar.Brand = function SidebarBrand({ name = 'Ofisi' }) {
  const { collapsed } = useContext(SidebarCtx)
  return (
    <div className={[
      'flex items-center gap-2.5 h-14 border-b border-line flex-shrink-0',
      collapsed ? 'justify-center px-0' : 'px-4',
    ].join(' ')}>
      <OfisiMark size={30} className="flex-shrink-0 rounded-lg shadow-e1" />
      {!collapsed && (
        <div className="flex flex-col min-w-0">
          <span className="font-serif text-[19px] font-semibold tracking-tight text-ink truncate leading-none">
            {name}
          </span>
          <span className="font-mono text-[8.5px] font-medium uppercase tracking-[0.22em] text-ink-faint leading-none mt-[4px]">
            Office Suite
          </span>
        </div>
      )}
    </div>
  )
}

Sidebar.Section = function SidebarSection({ label, children, className = '' }) {
  const { collapsed } = useContext(SidebarCtx)
  return (
    <div className={`px-2 ${className}`}>
      {!collapsed && label && (
        <p className="px-2 pt-3.5 pb-1.5 font-mono text-[10px] font-medium text-ink-faint uppercase tracking-wider select-none">
          {label}
        </p>
      )}
      {collapsed && label && <div className="border-t border-line mx-2 my-2" />}
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

/**
 * Sidebar.Item — accepts either `to` (renders NavLink) or `onClick` (button).
 * Active = teal left-rail + selected tint + hairline teal border + teal icon.
 */
Sidebar.Item = function SidebarItem({
  to,
  end,
  onClick,
  icon: Icon,
  iconAccent,    // optional category tint for the icon when not active
  dense,         // tighter row height + smaller glyph (Recent files)
  title,
  children,
  variant = 'nav',
}) {
  const { collapsed } = useContext(SidebarCtx)
  const glyph = dense ? 14 : 16

  const renderInner = (isActive) => (
    <>
      {/* Accent left-rail — the active marker. A calm bar that "gets out of the
          way" instead of boxing the whole row. */}
      <span
        aria-hidden
        className={[
          'absolute left-0 top-1 bottom-1 w-[2.5px] rounded-r-full bg-accent',
          'transition-opacity duration-fast ease-out',
          isActive ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      />
      {Icon && (
        <Icon
          size={glyph}
          strokeWidth={isActive ? 2.1 : 1.8}
          className={[
            'flex-shrink-0 transition-colors duration-fast ease-out',
            isActive ? 'text-accent-press' : iconAccent || 'text-ink-faint group-hover:text-ink-muted',
          ].join(' ')}
        />
      )}
      {!collapsed && (
        <span className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="truncate text-[13px] tracking-tightish">{children}</span>
        </span>
      )}
    </>
  )

  const cn = (isActive) =>
    [
      'group relative flex items-center gap-2.5 px-2.5 rounded-md',
      dense ? 'h-7' : 'h-8',
      'transition-colors duration-fast ease-out',
      collapsed ? 'justify-center' : '',
      // Active = subtle accent tint + rail (above) + brightened icon. No
      // coloured border, so the row reads calm rather than filled/boxed.
      isActive
        ? 'bg-accent-tint text-ink border border-transparent'
        : 'text-ink-muted border border-transparent hover:bg-bg-hover hover:text-ink',
      variant === 'danger' ? 'hover:bg-danger-bg hover:text-danger hover:border-transparent' : '',
    ].join(' ')

  if (to) {
    return (
      <NavLink to={to} end={end} title={title} onClick={onClick} className={({ isActive }) => cn(isActive)}>
        {({ isActive }) => renderInner(isActive)}
      </NavLink>
    )
  }
  return (
    <button type="button" onClick={onClick} title={title} className={cn(false)}>
      {renderInner(false)}
    </button>
  )
}

Sidebar.Footer = function SidebarFooter({ children }) {
  return (
    <div className="mt-auto border-t border-line pt-2 pb-1 px-2 flex flex-col gap-px">
      {children}
    </div>
  )
}

export { Sidebar }
export default Sidebar
