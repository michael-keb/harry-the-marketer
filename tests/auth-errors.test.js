import test from 'node:test'
import assert from 'node:assert/strict'
import { authErrorMessage, displayAuthError, mapAuth0Error, sanitizePlan } from '../shared/auth-errors.js'

test('Auth0 codes never leak jargon to the visitor', () => {
  assert.equal(mapAuth0Error('access_denied'), 'cancelled')
  assert.equal(mapAuth0Error('auth0_not_configured'), 'unavailable')
  assert.match(authErrorMessage('oauth_failed', { intent: 'signup' }), /create your account/i)
  assert.match(authErrorMessage('oauth_failed', { intent: 'login' }), /sign you in/i)
  assert.doesNotMatch(authErrorMessage('oauth_failed', { intent: 'signup' }), /Auth0|server logs/i)
})

test('legacy query strings with Auth0 jargon are rewritten', () => {
  const shown = displayAuthError('Login failed — check server logs and Auth0 settings', 'signup')
  assert.match(shown, /create your account/i)
  assert.doesNotMatch(shown, /Auth0|server logs/i)
})

test('only self-serve trial plans survive sanitise', () => {
  assert.equal(sanitizePlan('starter'), 'starter')
  assert.equal(sanitizePlan('growth'), 'growth')
  assert.equal(sanitizePlan('scale'), '')
  assert.equal(sanitizePlan('https://evil.example'), '')
})
