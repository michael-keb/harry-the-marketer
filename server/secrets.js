// At-rest encryption for OAuth mailbox tokens and Twilio auth tokens.
//
// Same AES-256-GCM shape as sender billing (server/parity/senders.js): a sealed
// blob is `v1.<iv>.<tag>.<ciphertext>`, all base64. Plaintext that is not sealed
// is returned as-is so existing rows keep working until the next write re-seals
// them (lazy migration — no downtime rewrite).
//
// Key material: TOKENS_ENCRYPTION_KEY if set, otherwise the persistent session
// secret already stored in kv. Encryption is always available; there is no
// "store in the clear because the key is missing" path.

import crypto from 'node:crypto'
import { sessionSecret } from './db.js'

const KEY_CACHE = new Map()
const KEY_SALT = 'harry-the-marketer/tokens-at-rest/v1'
const PREFIX = 'v1'

function tokensKey() {
  const raw = process.env.TOKENS_ENCRYPTION_KEY || sessionSecret()
  if (!raw) return null
  let key = KEY_CACHE.get(raw)
  if (!key) {
    key = crypto.scryptSync(String(raw), KEY_SALT, 32)
    KEY_CACHE.set(raw, key)
  }
  return key
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

/** Open a sealed secret, or return plaintext unchanged (legacy rows). */
export function openSecret(blob) {
  const text = String(blob ?? '')
  if (!text || !isSealed(text)) return text
  const key = tokensKey()
  if (!key) return ''
  const parts = text.split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return ''
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'))
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return ''
  }
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
