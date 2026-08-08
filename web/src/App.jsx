// The authenticated product shell. Mounted at /app/* by Root.jsx, which has
// already resolved the session — this component never renders signed out.
import { useCallback, useEffect, useState } from 'react'
import { Routes, Route, NavLink, Navigate, Link, useLocation } from 'react-router-dom'
import { api } from './api.js'
import { Icon } from './ui.jsx'
import CommandPalette from './CommandPalette.jsx'
import { UndoProvider } from './undo.jsx'
import ClientLens, { useClientLens } from './ClientLens.jsx'
import { Mark } from './site/Logo.jsx'
import Reports from './pages/Reports.jsx'
import Goals from './pages/Goals.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Leads from './pages/Leads.jsx'
import Campaigns from './pages/Campaigns.jsx'
import CampaignDetail from './pages/CampaignDetail.jsx'
import Inbox from './pages/Inbox.jsx'
import Mailboxes from './pages/Mailboxes.jsx'
import Monitoring from './pages/Monitoring.jsx'
import Settings from './pages/Settings.jsx'

const NAV = [
  { to: '/app', label: 'Dashboard', icon: 'dashboard' },
  { to: '/app/goals', label: 'Goals', icon: 'goal' },
  { to: '/app/campaigns', label: 'Campaigns', icon: 'campaigns' },
  { to: '/app/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/app/leads', label: 'Leads', icon: 'leads' },
  { to: '/app/reports', label: 'Reports', icon: 'reports' },
  { to: '/app/monitoring', label: 'Monitoring', icon: 'monitor' },
  { to: '/app/mailboxes', label: 'Mailboxes', icon: 'mailboxes' },
  { to: '/app/settings', label: 'Settings', icon: 'settings' },
]

// Two letters for the rail's avatar: initials from the display name, or the
// first two of the local part when all we have is an address.
function initialsOf(user) {
  const parts = String(user?.name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return String(user?.email || '?').slice(0, 2).toUpperCase()
}

export default function App({ user, onUserChanged }) {
  const location = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const lens = useClientLens()

  useEffect(() => { setNavOpen(false) }, [location.pathname])

  // The palette owns no global listener of its own — 200 endpoints now sit
  // behind nine navigation items, and the shortcut that reaches them belongs to
  // the shell rather than to a component that may not be mounted.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => { setPaletteOpen(false) }, [location.pathname])

  useEffect(() => {
    document.title = 'Harry The Marketer'
  }, [])

  const signOut = async () => {
    const result = await api.post('/api/auth/logout')
    window.location.href = result.redirect || '/'
  }

  // The rail's active state is a filled row, not a coloured label: the design
  // carries "you are here" on the surface (ink-800) and a green dot, which
  // survives being read at a glance far better than a hue change on 14px text.
  const navLink = ({ isActive }) =>
    `group flex items-center gap-3 rounded-lg px-3 py-2.5 text-md transition-colors ${
      isActive ? 'bg-ink-800 text-white font-medium' : 'text-slate-400 hover:bg-ink-800 hover:text-white'
    }`

  const sidebar = (
    <>
      <div className="px-4 pt-6 pb-1">
        <Link to="/" className="flex items-center gap-2.5" title="Back to the public site">
          <Mark size={24} />
          <span className="text-lg font-semibold tracking-tight text-white">
            Harry The <span className="text-accent-400">Marketer</span>
          </span>
        </Link>
        <div className="mt-1.5 text-xs text-slate-400">Outbound, on autopilot.</div>
      </div>
      <ClientLens />
      <div className="px-4 pt-4 pb-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          // Named explicitly: the visible label is split across a span and a
          // kbd, which leaves the computed name at the mercy of how a given
          // screen reader treats the shortcut hint.
          aria-label="Search everything (Command K)"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-800 px-3 py-2.5 text-left text-sm text-slate-400 transition-colors hover:border-slate-600 hover:text-white"
        >
          <Icon name="search" className="size-3.5" />
          <span className="flex-1">Search everything</span>
          <kbd className="rounded border border-ink-600 px-1.5 py-0.5 font-sans text-[11px] text-slate-400">⌘K</kbd>
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3" aria-label="Product">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/app'} className={navLink}>
            {({ isActive }) => (
              <>
                <Icon name={item.icon} className={isActive ? 'size-4 text-accent-400' : 'size-4'} />
                <span className="flex-1">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto flex items-start gap-2.5 border-t border-ink-700 px-4 py-4">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-600 text-xs font-semibold text-white"
          aria-hidden
        >
          {initialsOf(user)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white" title={user.email}>{user.name || user.email}</div>
          {user.workspace?.shared ? (
            <div className="mt-0.5 truncate text-xs text-accent-400" title={`Working in ${user.workspace.ownerEmail}'s workspace`}>
              {user.workspace.ownerEmail}
            </div>
          ) : (
            <div className="mt-0.5 truncate text-xs text-slate-400" title={user.email}>{user.email}</div>
          )}
          <button className="mt-1.5 cursor-pointer text-xs text-slate-400 hover:text-red-400" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </>
  )

  return (
    <UndoProvider>
    <div className="app-surface flex h-full">
      {/* Mobile top bar — the sidebar is a sheet below `md`. */}
      <div className="md:hidden fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-ink-700 app-rail px-4">
        <Link to="/app" className="flex items-center gap-2">
          <Mark size={22} />
          <span className="text-sm font-bold text-slate-100">Harry The <span className="text-accent-400">Marketer</span></span>
        </Link>
        <button
          type="button"
          className="rounded-lg border border-ink-700 p-1.5 text-slate-200 cursor-pointer"
          aria-expanded={navOpen}
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setNavOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="size-5" aria-hidden>
            {navOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="md:hidden fixed inset-0 z-30 bg-black/60 cursor-default"
          onClick={() => setNavOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-62 shrink-0 flex-col app-rail transition-transform md:static md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </aside>

      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">
        {/* Keyed on the client as well as the path: switching the lens has to
            re-ask the server, and remounting is the one way to be sure every
            page does — including the ones that fetch in a hook we do not own. */}
        <div
          // The design's column is 1040px. This is 1160: the parity tables
          // (fleet, leads, reports) declare a 960px minimum, and at 1040 minus
          // the page gutters they land just inside it and scroll on every
          // viewport. Same centred column, one notch wider than the mock.
          className="mx-auto max-w-[1160px] px-6 pt-8 pb-24 lg:px-11"
          key={`${location.pathname}::${lens.client?.id || 'all'}`}
        >
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="goals" element={<Goals />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="campaigns/:id" element={<CampaignDetail user={user} />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="leads" element={<Leads />} />
            <Route path="reports" element={<Reports />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="mailboxes" element={<Mailboxes />} />
            {/* Settings is seven areas under one item — the splat is which one,
                so every area has an address a link can point at. */}
            <Route path="settings/*" element={<Settings user={user} onSaved={onUserChanged} />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
    </UndoProvider>
  )
}
