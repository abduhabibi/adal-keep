/**
 * The agency's WhatsApp number (the owner, 2026-11-26): +251 is fixed, a person types the
 * 9 digits (9… Ethio telecom, 7… Safaricom). Whatever is pasted (09…, 2519…, +251 9…,
 * spaces) becomes the same 9. Same rule as the backend's phoneDigits (waLinkCode.js).
 */
export const COUNTRY = '251'
export function phoneDigits(v, country = COUNTRY) {
  let d = String(v || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0')) d = country + d.slice(1)
  else if (d.length === 9 && /^[79]/.test(d)) d = country + d
  if (d.startsWith(country + '0')) d = country + d.slice(country.length + 1)
  return d
}
/** What goes in the box after +251: up to 9 digits, the first a 9 or a 7 ('' when it is not one). */
export function localPart(v) {
  const raw = String(v || '').replace(/\D/g, '')
  if (!raw) return ''
  // Typing (a few digits, no prefix): kept as typed, a leading 0 dropped.
  let d = raw.length < 9 && !raw.startsWith(COUNTRY) ? raw.replace(/^0+/, '') : phoneDigits(raw)
  if (d.startsWith(COUNTRY)) d = d.slice(COUNTRY.length)
  d = d.slice(0, 9)
  return /^[79]/.test(d) ? d : ''
}
export const isLocal = (d) => /^[79]\d{8}$/.test(d)
