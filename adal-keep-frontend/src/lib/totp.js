/**
 * The Musaned authenticator's code (RFC 6238), made on this device — the
 * same code the PC makes (backend services/musanedTotp.js totp): the phone
 * shows each account's code from the agency's locked vault (asked on
 * 2026-11-15), with the PC on or off.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out = []
  for (const c of clean) {
    const i = B32.indexOf(c)
    if (i < 0) continue
    value = (value << 5) | i; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(out)
}
const ALG = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }

export async function totp({ secret, digits = 6, period = 30, algorithm = 'SHA1' }, at = Date.now()) {
  const counter = Math.floor(at / 1000 / period)
  const msg = new DataView(new ArrayBuffer(8))
  msg.setUint32(0, Math.floor(counter / 2 ** 32)); msg.setUint32(4, counter >>> 0)
  const key = await crypto.subtle.importKey('raw', base32(secret), { name: 'HMAC', hash: ALG[String(algorithm).toUpperCase().replace('-', '')] || 'SHA-1' }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg.buffer))
  const o = h[h.length - 1] & 15
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 10 ** digits).padStart(digits, '0')
}

/** { accountId: { label, code, left, digits, next } } — what GET /musaned/authenticators answers. */
export async function codesOf(keys = {}) {
  const now = Date.now(), out = {}
  for (const [id, k] of Object.entries(keys || {})) {
    const period = k.period || 30
    try {
      out[id] = { label: k.label || '', code: await totp(k, now), left: period - (Math.floor(now / 1000) % period), digits: k.digits || 6, next: await totp(k, now + period * 1000), used: false }
    } catch {}
  }
  return out
}
