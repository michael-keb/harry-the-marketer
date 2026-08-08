// Presentational primitives for the public marketing site.
//
// Kept separate from web/src/ui.jsx (the app's primitives) on purpose: the site
// has a different rhythm — wider containers, larger type, more air — and mixing
// the two makes both harder to change.
import { Link } from 'react-router-dom'
import { BRAND } from '../../../shared/site-content.js'

export function Container({ children, className = '', size = 'default' }) {
  const width = size === 'narrow' ? 'max-w-3xl' : size === 'wide' ? 'max-w-7xl' : 'max-w-6xl'
  return <div className={`${width} mx-auto px-5 sm:px-8 ${className}`}>{children}</div>
}

// `tone` picks the surface. The site is white; `dark` is the inverted ink band
// kept as a deliberate accent (the diagram is the product's visual language, so
// the dark "canvas" look still belongs on the page — just not everywhere).
const SECTION_TONES = {
  default: '',
  soft: 'bg-slate-50',
  dark: 'bg-ink-950 text-slate-300',
}

export function Section({ children, className = '', id, bordered = false, tone = 'default' }) {
  const border = bordered ? (tone === 'dark' ? 'border-t border-ink-800' : 'border-t border-slate-200') : ''
  return (
    <section id={id} className={`py-16 sm:py-24 ${SECTION_TONES[tone] || ''} ${border} ${className}`}>
      {children}
    </section>
  )
}

export function Eyebrow({ children, tone = 'default' }) {
  const color = tone === 'dark' ? 'text-accent-400' : 'text-accent-600'
  return (
    <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${color} mb-3`}>{children}</p>
  )
}

export function SectionHeading({ eyebrow, title, lede, align = 'left', className = '', tone = 'default' }) {
  const centered = align === 'center'
  const dark = tone === 'dark'
  return (
    <div className={`${centered ? 'text-center mx-auto max-w-2xl' : 'max-w-2xl'} ${className}`}>
      {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
      <h2 className={`text-3xl sm:text-4xl font-bold tracking-tight text-balance ${dark ? 'text-white' : 'text-ink-950'}`}>
        {title}
      </h2>
      {lede && (
        <p className={`mt-4 text-lg leading-relaxed text-pretty ${dark ? 'text-slate-400' : 'text-slate-600'}`}>
          {lede}
        </p>
      )}
    </div>
  )
}

// The site's two button weights. Rendered as Link, <a>, or <button> depending on
// what it is given, so a CTA is always the right element for what it does.
export function Cta({ to, href, onClick, children, variant = 'primary', size = 'default', className = '', ...rest }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 disabled:opacity-40 disabled:cursor-not-allowed'
  const sizes = {
    default: 'px-4 py-2.5 text-sm',
    large: 'px-5 py-3 text-base',
    small: 'px-3 py-1.5 text-xs',
  }
  const variants = {
    // Same green as the product's .btn-primary: white on accent-600 clears AA,
    // white on accent-500 does not.
    primary: 'bg-accent-600 text-white hover:bg-accent-700 font-semibold shadow-sm',
    secondary: 'border border-slate-300 text-ink-900 bg-white hover:border-ink-950',
    quiet: 'text-slate-600 hover:text-accent-700',
    // For use on the inverted ink bands.
    onDark: 'border border-ink-600 text-slate-100 hover:border-accent-400 hover:text-accent-300',
  }
  const cls = `${base} ${sizes[size]} ${variants[variant]} ${className}`
  if (to) return <Link to={to} className={cls} {...rest}>{children}</Link>
  if (href) return <a href={href} className={cls} {...rest}>{children}</a>
  return <button type="button" onClick={onClick} className={cls} {...rest}>{children}</button>
}

export function Card({ children, className = '', as: As = 'div', tone = 'default' }) {
  const surface = tone === 'dark'
    ? 'border-ink-700 bg-ink-900'
    : 'border-slate-200 bg-white'
  return (
    <As className={`rounded-xl border ${surface} ${className}`}>{children}</As>
  )
}

export function Check({ className = 'size-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function Dash({ className = 'size-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" className={className} aria-hidden>
      <path d="M6 12h12" />
    </svg>
  )
}

export function FeatureList({ items, className = '' }) {
  return (
    <ul className={`space-y-2.5 ${className}`}>
      {items.map((item) => (
        <li key={item} className="flex gap-2.5 text-sm text-slate-700">
          <Check className="size-4 shrink-0 mt-0.5 text-accent-600" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

// A native <details> accordion — keyboard accessible and works without JS state.
export function Faq({ items }) {
  return (
    <div className="divide-y divide-slate-200 border-y border-slate-200">
      {items.map((item) => (
        <details key={item.q} className="group py-5">
          <summary className="flex cursor-pointer items-start justify-between gap-4 list-none text-ink-950 font-medium marker:content-['']">
            <span className="text-pretty">{item.q}</span>
            <span className="shrink-0 mt-1 text-accent-600 transition-transform group-open:rotate-45" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
          </summary>
          <p className="mt-3 text-slate-600 leading-relaxed max-w-3xl text-pretty">{item.a}</p>
        </details>
      ))}
    </div>
  )
}

// Monospace code sample. Deliberately still dark: a playbook is source, and the
// ink panel is where source lives in this product's visual language.
export function CodeBlock({ children, label, className = '' }) {
  return (
    <div className={`rounded-xl border border-ink-800 bg-ink-950 overflow-hidden shadow-lg shadow-ink-950/10 ${className}`}>
      {label && (
        <div className="border-b border-ink-800 px-4 py-2 text-[11px] uppercase tracking-widest text-slate-500">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-slate-300 font-mono">
        <code>{children}</code>
      </pre>
    </div>
  )
}

// The closing band is the page's second inverted block — white page, ink finish.
export function CtaBand({ title, lede, primary, secondary }) {
  return (
    <Section bordered>
      <Container>
        <Card tone="dark" className="relative overflow-hidden px-6 py-12 sm:px-12 sm:py-16 text-center">
          <div className="pointer-events-none absolute inset-0 opacity-[0.07]" aria-hidden
            style={{ backgroundImage: 'linear-gradient(#0f9d6e 1px, transparent 1px)', backgroundSize: '100% 2.5rem' }} />
          <div className="relative">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white text-balance">{title}</h2>
            {lede && <p className="mt-3 text-slate-400 max-w-xl mx-auto text-pretty">{lede}</p>}
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Cta to={primary.to} size="large">{primary.label}</Cta>
              {secondary && <Cta to={secondary.to} variant="onDark" size="large">{secondary.label}</Cta>}
            </div>
            <p className="mt-4 text-xs text-slate-500">
              No card required · Sandbox mailbox means you can run a full campaign before connecting Gmail
            </p>
          </div>
        </Card>
      </Container>
    </Section>
  )
}

export function Wordmark({ className = '' }) {
  return (
    <span className={className}>
      {BRAND.nameLead} <span className="text-accent-600">{BRAND.nameAccent}</span>
    </span>
  )
}
