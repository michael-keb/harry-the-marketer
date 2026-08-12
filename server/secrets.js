// At-rest encryption for OAuth mailbox tokens and Twilio auth tokens.
//
// Same AES-256-GCM shape as sender billing (server/parity/senders.js): a sealed
// blob is `v1.<iv>.<tag>.<ciphertext>`, all base64. Plaintext that is not sealed
// is returned as-is so existing rows keep working until the next write — or the
// boot sweep — re-seals them.
//
// Key material: TOKENS_ENCRYPTION_KEY if set, otherwise the persistent session
// secret already stored in kv. Encryption is always available; there is no
// "store in the clear because the key is missing" path.
//
// Key rotation: openSecret tries the preferred key first, then the other
// candidate (env ⇄ session). A hit on the fallback is logged and the boot
// sweep re-seals under the preferred key so the next decrypt is unambiguous.

import crypto from 'node:crypto'
import { db, sessionSecret } from './db.js'

const KEY_CACHE = new Map()
const KEY_SALT = 'harry-the-marketer/tokens-at-rest/v1'
const PREFIX = 'v1'

function deriveKey(raw) {
  const material = String(raw || '')
  if (!material) return null
  let key = KEY_CACHE.get(material)
  if (!key) {
    key = crypto.scryptSync(material, KEY_SALT, 32)
    KEY_CACHE.set(material, key)
  }
  return key
}

function preferredRaw() {
  return process.env.TOKENS_ENCRYPTION_KEY || sessionSecret()
}

function tokensKey() {
  return deriveKey(preferredRaw())
}

/** All distinct key candidates, preferred first. */
function candidateKeys() {
  const out = []
  const seen = new Set()
  for (const raw of [process.env.TOKENS_ENCRYPTION_KEY, sessionSecret()]) {
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    const key = deriveKey(raw)
    if (key) out.push({ raw, key, preferred: raw === preferredRaw() })
  }
  return out
}

function decryptWith(key, parts) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'))
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** Seal a secret for storage. Empty string stays empty. */
export function sealSecret(plaintext) {
  const text = String(plaintext ?? '')
  if (!text) return ''
  if (isSealed(text)) return text
  const key = tokensKey()
  if (!key) return text
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.')
}

/**
 * Open a sealed secret, or return plaintext unchanged (legacy rows).
 * Tries the preferred key, then the alternate (env ⇄ session) so a late
 * TOKENS_ENCRYPTION_KEY set does not zero every mailbox at once.
 */
export function openSecret(blob) {
  const text = String(blob ?? '')
  if (!text || !isSealed(text)) return text
  const parts = text.split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return ''
  const candidates = candidateKeys()
  if (!candidates.length) return ''
  for (const { key, preferred } of candidates) {
    try {
      const out = decryptWith(key, parts)
      if (!preferred) {
        console.warn(
          '[secrets] decrypted a token with a fallback key — set TOKENS_ENCRYPTION_KEY before connecting mailboxes and never change it; boot sweep will re-seal under the preferred key',
        )
      }
      return out
    } catch {
      // try next candidate
    }
  }
  console.error('[secrets] token decrypt failed with all key candidates — mailbox/SMS credentials are unreadable until the matching key is restored')
  return ''
}

export function isSealed(blob) {
  const text = String(blob ?? '')
  return text.startsWith(`${PREFIX}.`) && text.split('.').length === 4
}

/** Return a mailbox row with tokens opened for provider use. */
export function withOpenTokens(mailbox) {
  if (!mailbox) return mailbox
  return {
    ...mailbox,
    access_token: openSecret(mailbox.access_token),
    refresh_token: openSecret(mailbox.refresh_token),
  }
}

/**
 * Re-seal a stored blob under the preferred key when needed. Plaintext becomes
 * sealed; sealed-under-fallback becomes sealed-under-preferred; already under
 * the preferred key is left untouched (new IV every seal would defeat
 * idempotency of the boot sweep).
 */
export function migrateTokenBlob(blob) {
  const text = String(blob ?? '')
  if (!text) return ''
  if (!isSealed(text)) return sealSecret(text)

  const parts = text.split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return text
  const preferred = tokensKey()
  if (!preferred) return text
  try {
    decryptWith(preferred, parts)
    return text // already under the preferred key
  } catch {
    const opened = openSecret(text) // may succeed via fallback
    if (!opened) return text // leave alone rather than wipe
    return sealSecret(opened)
  }
}

/**
 * One-time (idempotent) boot sweep: seal any plaintext mailbox/Twilio tokens
 * and re-seal any that open only under the fallback key. Safe to run every
 * start — `isSealed` + preferred-key re-seal is a no-op for already-migrated rows.
 */
export function sealLegacyTokens() {
  let mailboxes = 0
  let channels = 0
  const mbRows = db.prepare(
    `SELECT id, access_token, refresh_token FROM mailboxes
      WHERE COALESCE(access_token, '') != '' OR COALESCE(refresh_token, '') != ''`
  ).all()
  const updMb = db.prepare(
    'UPDATE mailboxes SET access_token = ?, refresh_token = ? WHERE id = ?'
  )
  for (const row of mbRows) {
    const access = migrateTokenBlob(row.access_token)
    const refresh = migrateTokenBlob(row.refresh_token)
    if (access !== row.access_token || refresh !== row.refresh_token) {
      updMb.run(access, refresh, row.id)
      mailboxes += 1
    }
  }
  const chRows = db.prepare(
    `SELECT id, auth_token FROM channel_accounts WHERE COALESCE(auth_token, '') != ''`
  ).all()
  const updCh = db.prepare('UPDATE channel_accounts SET auth_token = ? WHERE id = ?')
  for (const row of chRows) {
    const sealed = migrateTokenBlob(row.auth_token)
    if (sealed !== row.auth_token) {
      updCh.run(sealed, row.id)
      channels += 1
    }
  }
  if (mailboxes || channels) {
    console.log(`[secrets] sealed legacy tokens: ${mailboxes} mailbox(es), ${channels} channel account(s)`)
  }
  return { mailboxes, channels }
}
