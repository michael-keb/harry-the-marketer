// Customer-facing auth errors. The server puts a short code in ?error=;
// both /login and /signup map it here so Auth0, logs, and token jargon
// never reach the visitor.

export const TRIAL_PLAN_IDS = ['starter', 'growth']

export function sanitizePlan(value) {
  const id = String(value || '').trim().toLowerCase()
  return TRIAL_PLAN_IDS.includes(id) ? id : ''
}

export function mapAuth0Error(error) {
  const e = String(error || '').toLowerCase()
  if (e === 'access_denied' || e === 'login_required' || e === 'cancelled') return 'cancelled'
  if (e === 'auth0_not_configured' || e === 'unavailable') return 'unavailable'
  if (e.includes('timeout') || e.includes('another tab')) return 'timeout'
  if (e === 'unverified_email') return 'unverified_email'
  return 'oauth_failed'
}

export function authErrorMessage(code, { intent = 'login' } = {}) {
  const signup = intent === 'signup'
  switch (String(code || '')) {
    case 'unavailable':
    case 'auth0_not_configured':
      return signup
        ? "We can't create accounts right now. Try again in a few minutes, or contact us if it keeps happening."
        : "We can't sign you in right now. Try again in a few minutes, or contact us if it keeps happening."
    case 'timeout':
      return signup
        ? 'That sign-up timed out or was started in another tab. Please try again.'
        : 'That sign-in timed out or was started in another tab. Please try again.'
    case 'unverified_email':
      return 'Verify your email address first — check your inbox for the confirmation link.'
    case 'cancelled':
    case 'access_denied':
      return signup
        ? 'Google sign-up was cancelled. You can try again whenever you are ready.'
        : 'Google sign-in was cancelled. You can try again whenever you are ready.'
    case 'oauth_failed':
    default:
      return signup
        ? "We couldn't create your account just now. Please try again."
        : "We couldn't sign you in just now. Please try again."
  }
}

// Query strings from older redirects may still carry a full sentence, or a
// leaked Auth0 description. Map those to the same catalogue.
export function displayAuthError(raw, intent = 'login') {
  const value = String(raw || '').trim()
  if (!value) return ''
  const known = [
    'unavailable', 'auth0_not_configured', 'timeout', 'unverified_email',
    'oauth_failed', 'cancelled', 'access_denied',
  ]
  if (known.includes(value)) return authErrorMessage(value, { intent })
  if (/auth0|server logs|token exchange|userinfo|invalid_state|openid/i.test(value)) {
    return authErrorMessage('oauth_failed', { intent })
  }
  return value
}
