// One address, one identity. Sign-in providers hand back the account's real
// address, not the alias someone typed into an invite: Google in particular
// returns michael@gmail.com whether the person entered michael+coach@gmail.com
// or m.i.c.h.a.e.l@gmail.com. Comparing raw strings therefore left an invite
// waiting forever while the person it was meant for signed in beside it.
//
// canonicalEmail() is the form two addresses are compared in. It lower-cases
// and trims everything; for Gmail it also drops the +tag and the dots, and
// folds googlemail.com onto gmail.com, because Gmail delivers all of those to
// the same inbox. Other domains keep their local part as typed — plus-tags
// are not universal and a stranger's mail server is not ours to second-guess.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export function canonicalEmail(email) {
  const raw = String(email || '').trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at < 1) return raw
  let local = raw.slice(0, at)
  let domain = raw.slice(at + 1)
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com'
    const plus = local.indexOf('+')
    if (plus > 0) local = local.slice(0, plus)
    local = local.replaceAll('.', '')
  }
  return `${local}@${domain}`
}

// True when two addresses reach the same person under the rules above.
export function sameEmail(a, b) {
  return canonicalEmail(a) === canonicalEmail(b)
}
