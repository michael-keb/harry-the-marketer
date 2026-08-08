import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { BRAND, SITE_NAV, FOOTER_NAV } from '../../../shared/site-content.js'
import { useSeo, useScrollRestoration } from './seo.js'
import { Mark, Lockup } from './Logo.jsx'
import { Container, Cta } from './ui.jsx'

function MobileMenuIcon({ open }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="size-5" aria-hidden>
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  )
}

function Header({ signedIn }) {
  const [open, setOpen] = useState(false)
  const location = useLocation()

  // Any navigation closes the mobile sheet.
  useEffect(() => { setOpen(false) }, [location.pathname])

  // Lock body scroll while the sheet is open.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  const linkClass = ({ isActive }) =>
    `text-sm transition-colors ${isActive ? 'text-accent-700 font-medium' : 'text-slate-600 hover:text-ink-950'}`

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur">
      <Container>
        <div className="flex h-16 items-center justify-between gap-6">
          <Link to="/" className="shrink-0 rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-400" aria-label={`${BRAND.name} home`}>
            <Lockup size={26} />
          </Link>

          <nav className="hidden md:flex items-center gap-7" aria-label="Main">
            {SITE_NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className={linkClass}>{item.label}</NavLink>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            {signedIn ? (
              <Cta to="/app" size="small">Open the app</Cta>
            ) : (
              <>
                <Cta to="/login" variant="quiet" size="small">Sign in</Cta>
                <Cta to="/signup" size="small">Start free trial</Cta>
              </>
            )}
          </div>

          <button
            type="button"
            className="md:hidden rounded-lg border border-slate-300 p-2 text-slate-600 hover:text-ink-950 cursor-pointer"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            <MobileMenuIcon open={open} />
          </button>
        </div>
      </Container>

      {open && (
        <div id="mobile-nav" className="md:hidden border-t border-slate-200 bg-white">
          <Container className="py-4">
            <nav className="flex flex-col" aria-label="Main">
              {SITE_NAV.map((item) => (
                <NavLink key={item.to} to={item.to}
                  className={({ isActive }) =>
                    `py-3 border-b border-slate-200 text-base ${isActive ? 'text-accent-700' : 'text-slate-700'}`}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-5 flex flex-col gap-3">
              {signedIn ? (
                <Cta to="/app" size="large">Open the app</Cta>
              ) : (
                <>
                  <Cta to="/signup" size="large">Start free trial</Cta>
                  <Cta to="/login" variant="secondary" size="large">Sign in</Cta>
                </>
              )}
            </div>
          </Container>
        </div>
      )}
    </header>
  )
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <Container className="py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="max-w-xs">
            <Lockup size={26} />
            <p className="mt-4 text-sm text-slate-600 leading-relaxed">{BRAND.promise} {BRAND.tagline}</p>
            <a href={`mailto:${BRAND.supportEmail}`} className="mt-4 inline-block text-sm text-accent-700 hover:text-accent-600">
              {BRAND.supportEmail}
            </a>
          </div>

          {FOOTER_NAV.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{group.title}</h3>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    {link.href ? (
                      // Server-rendered legal pages — a full page load, deliberately.
                      <a href={link.href} className="text-sm text-slate-600 hover:text-accent-700">{link.label}</a>
                    ) : (
                      <Link to={link.to} className="text-sm text-slate-600 hover:text-accent-700">{link.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <p className="text-xs text-slate-500 max-w-xl sm:text-right">
            Outreach is regulated. You are responsible for having a lawful basis to contact the people you upload —
            see the <a href="/acceptable-use" className="text-slate-600 hover:text-accent-700 underline underline-offset-2">Acceptable Use Policy</a>.
          </p>
        </div>
      </Container>
    </footer>
  )
}

export default function SiteLayout({ signedIn }) {
  const location = useLocation()
  useSeo(location.pathname)
  useScrollRestoration(location.pathname, location.hash)

  return (
    <div className="min-h-full flex flex-col bg-white">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-lg focus:bg-ink-950 focus:px-4 focus:py-2 focus:text-sm focus:text-slate-100"
      >
        Skip to content
      </a>
      <Header signedIn={signedIn} />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}

export { Mark }
