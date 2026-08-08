// Client-side counterpart to shared/seo.js.
//
// The first HTML response already carries the right tags (injected by the server
// or the Vite plugin). This keeps them correct after a client-side navigation,
// which matters for the browser tab, for shared links copied from the address
// bar, and for crawlers that do execute JavaScript.
import { useEffect } from 'react'
import { metaFor } from '../../../shared/seo.js'

function setTag(selector, attrs) {
  let el = document.head.querySelector(selector)
  if (!el) {
    el = document.createElement(attrs.tag || 'meta')
    document.head.appendChild(el)
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (k !== 'tag') el.setAttribute(k, v)
  }
  return el
}

export function useSeo(pathname) {
  useEffect(() => {
    const meta = metaFor(pathname)
    const canonical = `${window.location.origin}${meta.path === '/' ? '/' : meta.path}`

    document.title = meta.title
    setTag('meta[name="description"]', { name: 'description', content: meta.description })
    setTag('link[rel="canonical"]', { tag: 'link', rel: 'canonical', href: canonical })
    setTag('meta[name="robots"]', {
      name: 'robots',
      content: meta.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large',
    })
    setTag('meta[property="og:title"]', { property: 'og:title', content: meta.title })
    setTag('meta[property="og:description"]', { property: 'og:description', content: meta.description })
    setTag('meta[property="og:url"]', { property: 'og:url', content: canonical })
    setTag('meta[name="twitter:title"]', { name: 'twitter:title', content: meta.title })
    setTag('meta[name="twitter:description"]', { name: 'twitter:description', content: meta.description })
  }, [pathname])
}

// Scroll handling for the marketing site: top on route change, but honour an
// in-page #anchor when there is one.
export function useScrollRestoration(pathname, hash) {
  useEffect(() => {
    if (hash) {
      const target = document.getElementById(hash.slice(1))
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
    window.scrollTo(0, 0)
  }, [pathname, hash])
}
