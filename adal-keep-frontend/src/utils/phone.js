/**
 * Normalize Ethiopian mobile numbers.
 * Always returns 251 + 9 digits (total 12) or empty string.
 * Example: 251912345678
 */
export function normalizePhone(value) {
  if (!value) return ''
  let digits = String(value).replace(/\D/g, '')

  // remove leading zeros
  digits = digits.replace(/^0+/, '')

  // already starts with 251
  if (digits.startsWith('251')) {
    const rest = digits.slice(3).slice(0, 9)   // take only 9 digits after 251
    return rest.length === 9 ? '251' + rest : '251' + rest
  }

  // local format starting with 9
  if (digits.startsWith('9')) {
    const rest = digits.slice(0, 9)
    return rest.length === 9 ? '251' + rest : '251' + rest
  }

  // anything else – just take last 9 digits if possible
  const last9 = digits.slice(-9)
  return last9.length === 9 ? '251' + last9 : ''
}

/**
 * Display format: 251 9XX XXX XXX
 */
export function formatPhone(value) {
  const n = normalizePhone(value)
  if (!n || n.length < 12) return n
  return `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}`
}

/**
 * Valid only when exactly 251 + 9 digits
 */
export function isValidEthiopianMobile(value) {
  return /^2519\d{8}$/.test(normalizePhone(value))
}
