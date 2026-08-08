import { Link } from 'react-router-dom'
import { SITE_NAV } from '../../../shared/site-content.js'
import { Container, Section, Cta } from './ui.jsx'

export default function NotFound() {
  return (
    <Section>
      <Container size="narrow">
        <div className="py-10 text-center">
          <p className="font-mono text-sm text-accent-600">404</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-ink-950 text-balance">
            That edge does not lead anywhere
          </h1>
          <p className="mt-4 text-slate-600 leading-relaxed max-w-md mx-auto text-pretty">
            The page you asked for is not here. It may have moved, or the link may be wrong.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Cta to="/">Back to the homepage</Cta>
            <Cta to="/contact" variant="secondary">Tell us the link was broken</Cta>
          </div>

          <nav className="mt-12 border-t border-slate-200 pt-8" aria-label="Site sections">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Try one of these</p>
            <ul className="mt-4 flex flex-wrap justify-center gap-x-6 gap-y-2">
              {SITE_NAV.map((item) => (
                <li key={item.to}>
                  <Link to={item.to} className="text-sm text-slate-600 hover:text-accent-700">{item.label}</Link>
                </li>
              ))}
              <li>
                <Link to="/app" className="text-sm text-slate-600 hover:text-accent-700">Open the app</Link>
              </li>
            </ul>
          </nav>
        </div>
      </Container>
    </Section>
  )
}
