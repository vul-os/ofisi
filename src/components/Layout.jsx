/**
 * Layout — app shell.
 *
 * Composed against src/components/ui (Sidebar primitives, Topbar primitives).
 *
 * Aesthetic notes:
 *   - Sidebar uses an accent-rail to mark the active app instead of filling
 *     the row, so the rail "gets out of the way" of the work surface.
 *   - App icons keep one warm tint each (so users can find Sheets / Slides /
 *     PDF at a glance) but those tints sit at low saturation and only show
 *     on the icon itself, never on a row background.
 *   - The bottom-right "theme cycler" gives users explicit control over the
 *     warm-dark mode — calmer than slamming the inversion on every load.
 *
 * Responsive:
 *   - ≥lg: the rail is a persistent column, collapsible to an icon strip.
 *   - <lg: the rail collapses off-canvas. A slim mobile header (hamburger +
 *     brand) sits above the work surface; tapping the hamburger slides the rail
 *     in over a scrim. Selecting any destination closes the drawer.
 *
 * Routes / props: unchanged — it still wraps `children` and reads from
 * `useAuthStore` + `useFilesStore`.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Home as HomeIcon, FileText, Table2, Presentation, FileSearch, PenTool,
  LogOut, ChevronLeft, ChevronRight, Settings as SettingsIcon, Plus,
  Menu, X, Bell,
} from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useFilesStore } from '../store/filesStore'
import { useNotificationsStore } from '../store/notificationsStore'
import NewFileModal from './NewFileModal'
import NotificationsPanel from './NotificationsPanel'
import { Sidebar, IconButton, Tooltip, ThemeSwitch } from './ui'

// Each app icon carries one low-saturation tint at rest (so users find
// Sheets/Slides/PDF at a glance); it brightens to accent only when its app is
// active — the cloud "restrained accent" trait. Tints live on the icon glyph
// only (never a row bg) and match the Home page cards so rail ↔ content agree.
// Office is documents-only: chat/video and calendar/contacts are third-party and
// are NOT launched from here.
const NAV_APPS = [
  { label: 'Docs',        icon: FileText,      route: '/docs',        tint: 'text-app-docs'   },
  { label: 'Sheets',      icon: Table2,        route: '/sheets',      tint: 'text-app-sheets' },
  { label: 'Slides',      icon: Presentation,  route: '/slides',      tint: 'text-app-slides' },
  { label: 'Whiteboards', icon: PenTool,       route: '/whiteboards', tint: 'text-app-board'  },
  { label: 'PDF',         icon: FileSearch,    route: '/pdf',         tint: 'text-app-pdf'    },
]

// Recent-file rows mirror the app tints so a recent doc/sheet/slide/whiteboard
// reads the same hue as its app in the rail above.
const RECENT_ICON = { doc: FileText, sheet: Table2, slide: Presentation, whiteboard: PenTool }
const RECENT_TINT = { doc: 'text-app-docs', sheet: 'text-app-sheets', slide: 'text-app-slides', whiteboard: 'text-app-board' }

/**
 * SidebarContent — the rail body, shared between the persistent (≥lg) column
 * and the mobile drawer. `collapsed` only applies to the desktop column;
 * `onNavigate` is fired on any destination tap so the drawer can close itself.
 */
function SidebarContent({ collapsed, onNavigate, onNewFile }) {
  const { status, logout } = useAuthStore()
  const { files } = useFilesStore()
  const navigate = useNavigate()
  const { items: notifs, fetch: fetchNotifs } = useNotificationsStore()
  const [notifOpen, setNotifOpen] = useState(false)

  // Poll for @-mention notifications so the badge stays fresh.
  useEffect(() => {
    fetchNotifs()
    const t = setInterval(fetchNotifs, 60000)
    return () => clearInterval(t)
  }, [fetchNotifs])
  const unread = notifs.filter((n) => !n.read).length
  const fileTypeOf = (id) => files.find((f) => f.id === id)?.type

  const recentFiles = files.slice(0, 5)
  const TYPE_ROUTE = { doc: 'docs', sheet: 'sheets', slide: 'slides', whiteboard: 'whiteboards' }
  const typeRoute = (f) => `/${TYPE_ROUTE[f.type] || 'docs'}/${f.id}`

  return (
    <>
      <Sidebar.Brand logoSrc="/vulos-office.png" name="Vulos Office" />

      <Sidebar.Section>
        {/* "New" is the only emphatic button in the rail — primary accent. */}
        <button
          onClick={() => { onNewFile(); onNavigate?.() }}
          title="New file"
          className={[
            'relative flex items-center gap-2 h-9 mt-2 rounded-lg',
            'bg-accent text-white border border-accent shadow-e1',
            'hover:bg-accent-hover active:translate-y-px',
            'transition-[background,transform] duration-fast ease-out',
            'text-[13px] font-semibold tracking-tightish',
            collapsed ? 'justify-center px-0' : 'px-3',
          ].join(' ')}
        >
          <Plus size={16} strokeWidth={2.2} className="flex-shrink-0" />
          {!collapsed && <span>New file</span>}
        </button>
        <div className="mt-1.5">
          <Sidebar.Item to="/" end icon={HomeIcon} title="Home" onClick={onNavigate}>Home</Sidebar.Item>
        </div>
      </Sidebar.Section>

      <Sidebar.Section label="Apps">
        {NAV_APPS.map(({ label, icon, route, beta, tint }) => (
          <Sidebar.Item
            key={route}
            to={route}
            icon={icon}
            iconAccent={tint}
            title={beta ? `${label} (beta)` : label}
            onClick={onNavigate}
          >
            {label}
            {beta && !collapsed && (
              <span className="font-mono text-[8.5px] px-1 py-px rounded-sm bg-brand-purple-subtle text-brand-purple font-medium leading-none uppercase tracking-wide">
                beta
              </span>
            )}
          </Sidebar.Item>
        ))}
      </Sidebar.Section>

      {recentFiles.length > 0 && !collapsed && (
        <Sidebar.Section label="Recent">
          {recentFiles.map((f) => (
            <Sidebar.Item
              key={f.id}
              dense
              icon={RECENT_ICON[f.type] || FileText}
              iconAccent={RECENT_TINT[f.type] || 'text-ink-faint'}
              onClick={() => { navigate(typeRoute(f)); onNavigate?.() }}
              title={f.name}
            >
              {f.name}
            </Sidebar.Item>
          ))}
        </Sidebar.Section>
      )}

      <Sidebar.Footer>
        {/* @-mention notifications — a bell with an unread badge + popover. */}
        <div className="relative">
          <button
            onClick={() => setNotifOpen((v) => !v)}
            title="Notifications"
            className={[
              'relative w-full flex items-center gap-2 h-8 rounded-lg text-[13px] tracking-tightish transition-colors',
              collapsed ? 'justify-center px-0' : 'px-2.5',
              notifOpen ? 'bg-accent-tint text-ink' : 'text-ink-muted hover:bg-bg-elev2 hover:text-ink',
            ].join(' ')}
          >
            <span className="relative flex-shrink-0">
              <Bell size={15} />
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[13px] h-[13px] px-0.5 rounded-full bg-accent text-white text-[8px] font-bold flex items-center justify-center leading-none">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </span>
            {!collapsed && <span>Notifications</span>}
          </button>
          {notifOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
              <div className="absolute bottom-full left-0 mb-2 z-50">
                <NotificationsPanel onClose={() => setNotifOpen(false)} fileTypeOf={fileTypeOf} />
              </div>
            </>
          )}
        </div>
        <Sidebar.Item to="/settings" icon={SettingsIcon} title="Settings" onClick={onNavigate}>
          Settings
        </Sidebar.Item>
        {status?.enabled && (
          <Sidebar.Item
            onClick={() => { logout(); onNavigate?.() }}
            icon={LogOut}
            title="Sign out"
            variant="danger"
          >
            Sign out
          </Sidebar.Item>
        )}
      </Sidebar.Footer>
    </>
  )
}

function Shell({ children }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const openNew = () => setShowNew(true)
  const closeMobile = () => setMobileOpen(false)

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-ink">
      {/* Persistent rail — ≥lg only */}
      <div className="hidden lg:flex">
        <Sidebar collapsed={collapsed}>
          <SidebarContent collapsed={collapsed} onNewFile={openNew} />
          {/* Appearance control + collapse toggle. Expanded → labelled
              segmented theme switch over its own row, collapse toggle below;
              collapsed → both shrink to single icon buttons side by side. */}
          {collapsed ? (
            <div className="flex flex-col items-center gap-1 px-2 pb-2 -mt-1">
              <ThemeSwitch collapsed />
              <Tooltip label="Expand sidebar" side="right">
                <IconButton size="sm" onClick={() => setCollapsed(false)}>
                  <ChevronRight size={14} />
                </IconButton>
              </Tooltip>
            </div>
          ) : (
            <div className="px-3 pb-2.5 pt-1 space-y-2">
              <ThemeSwitch />
              <Tooltip label="Collapse sidebar" side="right" className="w-full">
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  className="flex items-center gap-1.5 w-full h-7 px-2 rounded-md text-ink-faint hover:text-ink hover:bg-bg-hover transition-colors duration-fast ease-out text-[11px] font-medium tracking-tightish"
                >
                  <ChevronLeft size={14} className="flex-shrink-0" />
                  <span>Collapse</span>
                </button>
              </Tooltip>
            </div>
          )}
        </Sidebar>
      </div>

      {/* Mobile drawer — <lg */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40 animate-fade-in"
            onClick={closeMobile}
            aria-hidden
          />
          <div className="absolute left-0 top-0 bottom-0 animate-drawer-in">
            <Sidebar collapsed={false} className="h-full shadow-e3">
              <SidebarContent collapsed={false} onNavigate={closeMobile} onNewFile={openNew} />
              <div className="px-3 pb-3 pt-1">
                <ThemeSwitch />
              </div>
            </Sidebar>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-bg">
        {/* Mobile header — only below lg, where the rail is off-canvas */}
        <header className="lg:hidden flex items-center gap-2.5 h-12 px-2 border-b border-line bg-bg-elev2 flex-shrink-0">
          <IconButton size="md" onClick={() => setMobileOpen(true)} title="Open navigation">
            <Menu size={18} />
          </IconButton>
          <img src="/vulos-office.png" alt="" className="w-7 h-7 rounded-lg object-cover ring-1 ring-line-strong shadow-e1" />
          <span className="text-sm font-semibold tracking-tight text-ink leading-none">Vulos</span>
          <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.2em] text-ink-faint leading-none">Office</span>
        </header>
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">{children}</div>
      </main>

      {showNew && <NewFileModal onClose={() => setShowNew(false)} />}
    </div>
  )
}

export default function Layout({ children }) {
  return <Shell>{children}</Shell>
}
