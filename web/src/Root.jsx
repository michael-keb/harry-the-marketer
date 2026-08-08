// Top-level routing.
//
//   /            marketing site      public
//   /login       sign in             public
//   /signup      create an account   public
//   /app/*       the product         requires a session
//
// Session state is fetched once here and shared: the marketing header uses it to
// say "Open the app" instead of "Sign in", and the app shell uses it to gate.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { api } from './api.js'
import { Spinner, ErrorState } from './ui.jsx'
import SiteLayout from './site/SiteLayout.jsx'
import Home from './site/Home.jsx'
import Login from './auth/Login.jsx'
import Signup from './auth/Signup.jsx'

// The marketing pages a first-time visitor does not need in the first byte.
const Product = lazy(() => import('./site/Product.jsx'))
const Pricing = lazy(() => import('./site/Pricing.jsx'))
const Security = lazy(() => import('./site/Security.jsx'))
const About = lazy(() => import('./site/About.jsx'))
const Contact = lazy(() => import('./site/Contact.jsx'))
const NotFound = lazy(() => import('./site/NotFound.jsx'))

// The whole authenticated product is one chunk, loaded only after sign-in.
const AppShell = lazy(() => import('./App.jsx'))

const PageFallback = () => <Spinner label="Loading…" />

// Send a signed-out visitor to /login, remembering where they were going.
function RequireAuth({ user, children }) {
  const location = useLocation()
  if (user === undefined) return <Spinner label="Checking your session…" />
  if (user === null) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }
  return children
}

export default function Root() {
  const [user, setUser] = useState(undefined) // undefined = loading, null = signed out
  const [error, setError] = useState(null)

  const loadUser = useCallback(async () => {
    setError(null)
    try {
      setUser(await api.get('/api/auth/me'))
    } catch (err) {
      if (err.status === 401) setUser(null)
      else setError(err)
    }
  }, [])

  useEffect(() => { loadUser() }, [loadUser])

  // A failure here means the API is unreachable — the marketing site would still
  // render, but silently pretending everything is fine would be worse.
  if (error) return <div className="p-10"><ErrorState error={error} onRetry={loadUser} /></div>

  const signedIn = Boolean(user)

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* ---- public marketing site ---- */}
        <Route element={<SiteLayout signedIn={signedIn} />}>
          <Route index element={<Home />} />
          <Route path="/product" element={<Product />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/security" element={<Security />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="*" element={<NotFound />} />
        </Route>

        {/* ---- authentication ---- */}
        <Route
          path="/login"
          element={signedIn ? <Navigate to="/app" replace /> : <Login onLoggedIn={loadUser} />}
        />
        <Route
          path="/signup"
          element={signedIn ? <Navigate to="/app" replace /> : <Signup onLoggedIn={loadUser} />}
        />

        {/* ---- the product ---- */}
        <Route
          path="/app/*"
          element={
            <RequireAuth user={user}>
              <AppShell user={user} onUserChanged={loadUser} />
            </RequireAuth>
          }
        />
      </Routes>
    </Suspense>
  )
}
