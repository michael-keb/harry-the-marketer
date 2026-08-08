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

  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',

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
}

export const isProduction = () => env.NODE_ENV === 'production'

export const auth0Configured = () =>
  Boolean(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET)

export const googleConfigured = () =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

export const devLoginEnabled = () =>
  env.DEV_LOGIN !== undefined ? env.DEV_LOGIN === '1' || env.DEV_LOGIN === 'true' : !auth0Configured()
