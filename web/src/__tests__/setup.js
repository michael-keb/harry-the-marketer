// Test environment setup — runs once per test file, before any test.
//
// Everything in here compensates for something jsdom does not do. Nothing in
// here changes how a component behaves in a browser.

import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom has no layout engine, so `HTMLElement.offsetParent` is hard-wired to
// null for every element, visible or not.
//
// That matters because the focus traps in ui.jsx (Modal) and parity-ui.jsx
// (Drawer) use `el.offsetParent !== null` as their "is this control actually
// on screen" filter — the cheap, dependency-free version of a visibility check.
// Under stock jsdom that filter removes *every* candidate, the trap bails out
// at `if (!items.length) return`, and a Tab-wrapping test would pass or fail
// for reasons that have nothing to do with the component.
//
// So: a minimal stand-in that answers the one question the traps actually ask —
// is this element rendered and not hidden. Elements outside the document, and
// elements under a `display: none` or `hidden` ancestor, report null exactly as
// a browser would; everything else reports its offset ancestor.
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden) return null
      const style = window.getComputedStyle(node)
      if (style.display === 'none') return null
    }
    if (!this.isConnected || this === document.body) return null
    return this.offsetParentElementForTests ?? document.body
  },
})

// Also missing from jsdom for want of a layout engine: scrollIntoView. The
// command palette calls it to keep the active row on screen as the arrow keys
// walk past the fold. A no-op is the honest stand-in — there is no viewport to
// scroll — and it keeps the absence of a browser API from reading as a bug in
// the component.
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}

// React 19 warns loudly about updates outside act(); several components here
// settle promises after a click, and the tests await those settles explicitly.
// Nothing is silenced — this only makes the warning fail the test rather than
// scroll past in the output.
const originalError = console.error
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) {
    throw new Error(`Unexpected React state update outside act():\n${args[0]}`)
  }
  originalError(...args)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})
