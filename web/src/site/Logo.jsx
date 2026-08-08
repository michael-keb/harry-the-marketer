// The mark from LOGO-BRIEF.md §8 direction B: an H whose crossbar splits and
// diverges — the letterform *is* the decision point.
//
// Constraints it satisfies: no text, square artboard, two flat colours, legible
// at 32px, and it survives being flattened to one colour (pass `mono`).
export function Mark({ size = 28, mono = false, framed = true, className = '' }) {
  const stem = mono ? 'currentColor' : '#2fd79b'
  const branch = mono ? 'currentColor' : '#0f9d6e'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="Harry The Marketer"
    >
      {framed && <rect width="32" height="32" rx="7" fill={mono ? 'none' : '#0b1622'} stroke={mono ? 'currentColor' : '#23303e'} />}
      {/* Left stem, right stem, and the crossbar up to the split point. */}
      <path d="M9.5 7.5v17M22.5 7.5v17M9.5 16h4.5" stroke={stem} strokeWidth="2.6" strokeLinecap="round" />
      {/* The crossbar diverging into two edges — one path in, two paths out. */}
      <path d="M14 16l8.5-5M14 16l8.5 5" stroke={branch} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// `tone` follows the surface the lockup sits on: the site is white, the app
// shell and auth pages are still ink.
export function Lockup({ size = 28, className = '', tone = 'light', textClass }) {
  const dark = tone === 'dark'
  const text = textClass || `text-base font-bold tracking-tight ${dark ? 'text-slate-50' : 'text-ink-950'}`
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark size={size} />
      <span className={text}>
        Harry The <span className={dark ? 'text-accent-400' : 'text-accent-600'}>Marketer</span>
      </span>
    </span>
  )
}
