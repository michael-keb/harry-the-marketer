import { Link, useLocation } from 'react-router-dom'
import { BRAND } from '../../../shared/site-content.js'
import { useSeo } from '../site/seo.js'
import { Lockup } from '../site/Logo.jsx'
import { Check } from '../site/ui.jsx'

/**
 * Two-column shell shared by /login and /signup.
 *
 * The left column is the form. The right column is the reassurance panel —
 * present on signup (where the visitor is deciding) and omitted on login
 * (where they have already decided and just want the form).
 */
export default function AuthLayout({ title, lede, children, footer, aside }) {
  const location = useLocation()
  useSeo(location.pathname)

  return (
    <div className="min-h-full flex flex-col bg-white">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link to="/" className="rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-400" aria-label={`${BRAND.name} home`}>
            <Lockup size={26} />
          </Link>
          <Link to="/" className="text-sm text-slate-600 hover:text-ink-900">← Back to site</Link>
        </div>
      </header>

      <div className={`flex-1 mx-auto w-full max-w-6xl px-5 sm:px-8 py-12 sm:py-16 ${aside ? 'grid gap-14 lg:grid-cols-2 lg:gap-20 lg:items-center' : ''}`}>
        <div className={aside ? '' : 'mx-auto w-full max-w-md'}>
          <div className={aside ? 'mx-auto w-full max-w-md lg:mx-0' : ''}>
            <h1 className="text-3xl font-bold tracking-tight text-ink-950 text-balance">{title}</h1>
            {lede && <p className="mt-3 text-slate-600 leading-relaxed text-pretty">{lede}</p>}
            <div className="mt-8">{children}</div>
            {footer && <div className="mt-6 text-sm text-slate-600">{footer}</div>}
          </div>
        </div>

        {aside && (
          <div className="hidden lg:block">
            <div className="rounded-xl border border-slate-200 bg-white p-8">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-accent-600">{aside.title}</h2>
              <ul className="mt-6 space-y-4">
                {aside.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm text-slate-700 leading-relaxed">
                    <Check className="size-4 shrink-0 mt-0.5 text-accent-600" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              {aside.footnote && <p className="mt-8 border-t border-slate-200 pt-5 text-xs text-slate-500 leading-relaxed">{aside.footnote}</p>}
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 sm:px-8 py-5 text-xs text-slate-500">
          <span>© {new Date().getFullYear()} {BRAND.name}</span>
          <span className="flex gap-4">
            <a href="/privacy" className="hover:text-accent-700">Privacy</a>
            <a href="/terms" className="hover:text-accent-700">Terms</a>
            <Link to="/contact" className="hover:text-accent-700">Contact</Link>
          </span>
        </div>
      </footer>
    </div>
  )
}
