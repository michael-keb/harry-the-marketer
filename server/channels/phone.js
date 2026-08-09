// Phone helpers for SMS / WhatsApp. Harry stores whatever the user typed and
// normalises at the gate so Twilio always sees E.164.

const DIGITS = /^\+?[0-9\s().-]+$/

/**
 * Best-effort E.164. `defaultCountry` is an ISO country calling code digits
 * string without '+' (e.g. '61' for AU) used when the input has no leading +.
 * Returns '' when the value cannot be a phone number.
 */
export function toE164(raw, { defaultCountry = '61' } = {}) {
  const input = String(raw || '').trim()
  if (!input || !DIGITS.test(input)) return ''
  let digits = input.replace(/[^\d+]/g, '')
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`
  if (digits.startsWith('+')) {
    const n = digits.slice(1).replace(/\D/g, '')
    return n.length >= 8 && n.length <= 15 ? `+${n}` : ''
  }
  const n = digits.replace(/\D/g, '')
  if (!n) return ''
  // National trunk zero: 0412… → +61412…
  if (defaultCountry && n.startsWith('0') && n.length >= 9) {
    return `+${defaultCountry}${n.slice(1)}`
  }
  if (defaultCountry && n.length >= 8 && n.length <= 11) {
    return `+${defaultCountry}${n}`
  }
  return n.length >= 8 && n.length <= 15 ? `+${n}` : ''
}

export function samePhone(a, b) {
  const left = toE164(a)
  const right = toE164(b)
  return Boolean(left && right && left === right)
}
