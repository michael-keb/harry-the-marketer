// Which mailbox providers are real sending accounts (not sandbox).
export const OAUTH_PROVIDERS = new Set(['gmail', 'outlook'])

export function isOAuthProvider(provider) {
  return OAUTH_PROVIDERS.has(provider)
}

export function isPacedProvider(provider) {
  return isOAuthProvider(provider)
}
