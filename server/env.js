// Tiny .env loader — no dependency. Loads KEY=VALUE lines from .env at repo root
// (values already present in process.env win).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const envPath = path.join(ROOT, '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const [, key, raw] = m
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.replace(/^["']|["']$/g, '')
  }
}

export const env = {
  PORT: Number(process.env.PORT || 8130),
  APP_URL: process.env.APP_URL || 'http://localhost:8131',
  NODE_ENV: process.env.NODE_ENV || 'development',

  AUTH0_DOMAIN: process.env.AUTH0_DOMAIN || '',
  AUTH0_CLIENT_ID: process.env.AUTH0_CLIENT_ID || '',
  AUTH0_CLIENT_SECRET: process.env.AUTH0_CLIENT_SECRET || '',
  // First-party API audience — lets Auth0 skip the "Authorize App" consent screen.
  AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE || 'https://harrythemarketer.com/api',

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  // Set to 1 after Google approves OAuth verification (Publishing status = In production).
  // Until then the Connections page explains Testing-mode test users.
  GOOGLE_OAUTH_VERIFIED: process.env.GOOGLE_OAUTH_VERIFIED === '1' || process.env.GOOGLE_OAUTH_VERIFIED === 'true',

  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID || '',
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET || '',

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-opus-5',

  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-5-mini',
  // openai | anthropic | auto (auto prefers OpenAI when its key is set)
  AI_PROVIDER: process.env.AI_PROVIDER || 'auto',

  // Explicit opt-in/out; when unset, dev login is enabled iff Auth0 is not configured.
  DEV_LOGIN: process.env.DEV_LOGIN,
  ENGINE_INTERVAL_MS: Number(process.env.ENGINE_INTERVAL_MS || 20000),

  // Public site: operator details rendered into the legal pages. Set these before
  // going live — the defaults are visibly marked as unconfirmed.
  LEGAL_ENTITY_NAME: process.env.LEGAL_ENTITY_NAME || '',
  LEGAL_JURISDICTION: process.env.LEGAL_JURISDICTION || '',
  LEGAL_PRIVACY_EMAIL: process.env.LEGAL_PRIVACY_EMAIL || '',
  LEGAL_SUPPORT_EMAIL: process.env.LEGAL_SUPPORT_EMAIL || '',

  // Set to '1' to keep the public site out of search indexes (staging deploys).
  SITE_NOINDEX: process.env.SITE_NOINDEX === '1' || process.env.SITE_NOINDEX === 'true',
  // Trust X-Forwarded-* headers (set when running behind a reverse proxy / PaaS).
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',

  // Persistent SQLite directory (Render disk mount in production).
  DATA_DIR: process.env.DATA_DIR || '',

  // Stripe Payment Links — hosted checkout; no card data touches this app.
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_PAYMENT_LINK_STARTER: process.env.STRIPE_PAYMENT_LINK_STARTER || '',
  STRIPE_PAYMENT_LINK_GROWTH: process.env.STRIPE_PAYMENT_LINK_GROWTH || '',
  STRIPE_PAYMENT_LINK_SCALE: process.env.STRIPE_PAYMENT_LINK_SCALE || '',

  // Fail fast on unsafe production config (default: warn only).
  PRODUCTION_STRICT: process.env.PRODUCTION_STRICT === '1' || process.env.PRODUCTION_STRICT === 'true',

  // SMSFlow — the SMS provider. When the API key is set, allow-listed
  // workspaces can send SMS without connecting an account in Settings.
  // SMSFLOW_FROM_NUMBER is optional (Sender ID / dedicated number).
  SMSFLOW_API_KEY: process.env.SMSFLOW_API_KEY || '',
  SMSFLOW_FROM_NUMBER: process.env.SMSFLOW_FROM_NUMBER || '',

  // SMS access allowlist — comma-separated workspace-owner emails. When set,
  // only these workspaces may configure or send SMS; when empty, SMS is open
  // to every workspace (dev / existing behaviour).
  SMS_ALLOWED_EMAILS: process.env.SMS_ALLOWED_EMAILS || '',

  // Twilio (legacy) — pre-SMSFlow accounts keep sending; new setups use SMSFlow.
  // TWILIO_PHONE_NUMBER is an alias for TWILIO_FROM_NUMBER.
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER || '',
  TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
  // Dev only: skip Twilio request signature checks (never in production).
  TWILIO_SKIP_SIGNATURE: process.env.TWILIO_SKIP_SIGNATURE || '',
}

export const isProduction = () => env.NODE_ENV === 'production'

export const auth0Configured = () =>
  Boolean(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET)

export const googleConfigured = () =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

export const googleOAuthVerified = () => Boolean(env.GOOGLE_OAUTH_VERIFIED)

export const microsoftConfigured = () =>
  Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET)

export const twilioEnvConfigured = () =>
  Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID))

export const smsflowEnvConfigured = () => Boolean(env.SMSFLOW_API_KEY)

/** Lower-cased SMS allowlist; empty array means SMS is open to everyone. */
export const smsAllowedEmails = () =>
  String(env.SMS_ALLOWED_EMAILS || '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

export const devLoginEnabled = () =>
  env.DEV_LOGIN !== undefined ? env.DEV_LOGIN === '1' || env.DEV_LOGIN === 'true' : !auth0Configured()
