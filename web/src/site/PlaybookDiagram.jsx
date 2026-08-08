// Renders a playbook diagram on the marketing site.
//
// Mermaid is ~500kB — far too heavy to sit in the marketing site's critical
// path. It is imported dynamically, and only once the diagram scrolls into view,
// so a visitor who never reaches it never downloads it. Until then a readable
// source-code fallback is shown, which is also what people without JavaScript
// and screen-reader users get.
import { useEffect, useRef, useState } from 'react'
import { MERMAID_BRAND_CONFIG } from '../mermaid-theme.js'

let mermaidPromise = null
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize(MERMAID_BRAND_CONFIG)
      return mermaid
    })
  }
  return mermaidPromise
}

let seq = 0

export default function PlaybookDiagram({ code, className = '', label = 'Campaign playbook' }) {
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)
  const hostRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const node = hostRef.current
    if (!node) return

    const render = async () => {
      try {
        const mermaid = await loadMermaid()
        const id = `site-playbook-${++seq}`
        const { svg: rendered } = await mermaid.render(id, code)
        if (!cancelled) setSvg(rendered)
      } catch (err) {
        console.warn('[site] diagram render failed:', err?.message || err)
        if (!cancelled) setFailed(true)
      }
    }

    // No IntersectionObserver (old browser, jsdom): just render.
    if (typeof IntersectionObserver === 'undefined') {
      render()
      return () => { cancelled = true }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect()
          render()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(node)
    return () => { cancelled = true; observer.disconnect() }
  }, [code])

  return (
    <div ref={hostRef} className={className}>
      {svg && !failed ? (
        <div
          className="mermaid-canvas flex justify-center p-4 sm:p-6"
          role="img"
          aria-label={`${label} diagram`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="overflow-x-auto p-4 sm:p-6 text-[12.5px] leading-relaxed text-slate-600 font-mono">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
