/**
 * Layout — app shell.
 *
 * Composed against src/components/ui (Sidebar primitives, Topbar primitives).
 *
 * Aesthetic notes:
 *   - Sidebar uses an accent-rail to mark the active app instead of filling
 *     the row, so the rail "gets out of the way" of the work surface.
 *   - App icons keep one warm tint each (so users can find Sheets / Slides /
 *     Spaces at a glance) but those tints sit at low saturation and only show
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

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Home as HomeIcon, FileText, Table2, Presentation, FileSearch, MessageSquare,
  LogOut, ChevronLeft, ChevronRight, Settings as SettingsIcon, Plus,
  Sun, Moon, Monitor, CalendarDays, BookUser, Menu, X,
} from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { useFilesStore } from '../store/filesStore'
import NewFileModal from './NewFileModal'
import { Sidebar, IconButton, Tooltip, useTheme } from './ui'

// One restrained warm tint per app — these read as "category", not as accents.
// Avoiding indigo/blue keeps the deep-teal accent unique.
const NAV_APPS = [
  { label: 'Docs',     icon: FileText,      route: '/docs',     tint: 'text-oat-700' },
  { label: 'Sheets',   icon: Table2,        route: '/sheets',   tint: 'text-success' },
  { label: 'Slides',   icon: Presentation,  route: '/slides',   tint: 'text-warning' },
  { label: 'PDF',      icon: FileSearch,    route: '/pdf',      tint: 'text-danger'  },
  { label: 'Spaces',   icon: MessageSquare, route: '/spaces',   tint: 'text-info'    },
  { label: 'Calendar', icon: CalendarDays,  route: '/calendar', tint: 'text-accent', beta: true },
  { label: 'Contacts', icon: BookUser,      route: '/contacts', tint: 'text-accent', beta: true },
]

function ThemeCycler() {
  const { theme, cycle } = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor
  const label =
    theme === 'light' ? 'Theme: light (click for dark)' :
    theme === 'dark'  ? 'Theme: dark (click for system)' :
                        'Theme: system (click for light)'
  return (
    <Tooltip label={label} side="right">
      <IconButton size="sm" onClick={cycle}>
        <Icon size={14} />
      </IconButton>
    </Tooltip>
  )
}

/**
 * SidebarContent — the rail body, shared between the persistent (≥lg) column
 * and the mobile drawer. `collapsed` only applies to the desktop column;
 * `onNavigate` is fired on any destination tap so the drawer can close itself.
 */
function SidebarContent({ collapsed, onNavigate, onNewFile }) {
  const { status, logout } = useAuthStore()
  const { files } = useFilesStore()
  const navigate = useNavigate()

  const recentFiles = files.slice(0, 5)
  const typeRoute = (f) =>
    `/${f.type === 'doc' ? 'docs' : f.type === 'sheet' ? 'sheets' : 'slides'}/${f.id}`

  return (
    <>
      <Sidebar.Brand logoSrc="/vula-office.png" name="Vulos Office" />

      <Sidebar.Section>
        {/* "New" is the only emphatic button in the rail — primary accent. */}
        <button
          onClick={() => { onNewFile(); onNavigate?.() }}
          title="New file"
          className={[
            'relative flex items-center gap-2 h-9 px-3 rounded-md',
            'bg-accent text-white shadow-e1',
            'hover:bg-accent-hover active:bg-accent-press',
            'transition-colors duration-fast ease-out',
            'text-sm font-medium tracking-tightish',
            collapsed ? 'justify-center px-0' : '',
          ].join(' ')}
        >
          <Plus size={15} className="flex-shrink-0" />
          {!collapsed && <span>New</span>}
        </button>
      </Sidebar.Section>

      <Sidebar.Section>
        <Sidebar.Item to="/" end icon={HomeIcon} title="Home" onClick={onNavigate}>Home</Sidebar.Item>
      </Sidebar.Section>

      <Sidebar.Section label="Apps">
        {NAV_APPS.map(({ label, icon, route, tint, beta }) => (
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
              <span className="ml-1 text-[9px] px-1 py-px rounded bg-accent-tint text-accent font-medium leading-none align-middle">
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
              onClick={() => { navigate(typeRoute(f)); onNavigate?.() }}
              title={f.name}
            >
              {f.name}
            </Sidebar.Item>
          ))}
        </Sidebar.Section>
      )}

      <Sidebar.Footer>
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
          {/* Theme cycler + collapse toggle share the bottom row */}
          <div className="flex items-center gap-1 px-3 pb-2 -mt-1">
            <ThemeCycler />
            <Tooltip
              label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              side="right"
            >
              <IconButton size="sm" onClick={() => setCollapsed(!collapsed)}>
                {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
              </IconButton>
            </Tooltip>
          </div>
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
          <div className="absolute left-0 top-0 bottom-0 animate-slide-in-right">
            <Sidebar collapsed={false} className="h-full shadow-e3">
              <SidebarContent collapsed={false} onNavigate={closeMobile} onNewFile={openNew} />
              <div className="flex items-center gap-1 px-3 pb-2 -mt-1">
                <ThemeCycler />
              </div>
            </Sidebar>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-bg">
        {/* Mobile header — only below lg, where the rail is off-canvas */}
        <header className="lg:hidden flex items-center gap-2 h-12 px-2 border-b border-line bg-bg-elev2 flex-shrink-0">
          <IconButton size="md" onClick={() => setMobileOpen(true)} title="Open navigation">
            <Menu size={18} />
          </IconButton>
          <img src="/vula-office.png" alt="" className="w-6 h-6 rounded-md object-cover" />
          <span className="text-sm font-semibold tracking-tightish text-ink">Vulos Office</span>
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
