/**
 * The Musaned authenticator, inside Adal Keep (asked for on 2026-11-03).
 *
 * Musaned's sign-in asks for a 6-digit code from an authenticator app. The
 * agency gives Adal Keep the same QR code the app was set up with (a picture
 * or screenshot of it: dropped or chosen in Settings → Portals → Musaned, per
 * Musaned account) — or the key written under it. Adal Keep keeps the key
 * locked on this PC (secretStore: AES-256-GCM, a key only this PC has) and
 * types the code when Musaned asks. With the reCAPTCHA passing by itself, a
 * Musaned sign-in then needs no person at all.
 */
import crypto from 'crypto'
import { getSecret, setSecret, removeSecret } from './secretStore.js'

const nameOf = (accountId) => `musaned_totp_${Number(accountId)}`

// ── base32 (RFC 4648) ────────────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '')
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('That is not an authenticator key (letters A–Z and digits 2–7)')
  let bits = 0, value = 0
  const out = []
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

/** The code now (RFC 6238): 6 digits, 30 s, SHA-1 unless the QR said otherwise. */
export function totp({ secret, digits = 6, period = 30, algorithm = 'SHA1' }, at = Date.now()) {
  const counter = Math.floor(at / 1000 / period)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac(algorithm.toLowerCase().replace('-', ''), base32(secret)).update(msg).digest()
  const o = h[h.length - 1] & 15
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 10 ** digits).padStart(digits, '0')
}

/** "otpauth://totp/Musaned:name?secret=…&digits=6" (or the bare key) → its parts. */
export function parseKey(text) {
  const t = String(text || '').trim()
  if (/^otpauth-migration:/i.test(t)) throw new Error('This is a Google Authenticator "export" QR — use the QR Musaned showed when the authenticator was set up (or the key written under it)')
  if (/^otpauth:\/\//i.test(t)) {
    const u = new URL(t)
    const secret = u.searchParams.get('secret')
    if (!secret) throw new Error('The QR code has no key in it')
    base32(secret)
    return {
      secret: secret.toUpperCase(), label: decodeURIComponent(u.pathname.replace(/^\//, '')),
      issuer: u.searchParams.get('issuer') || '', digits: Number(u.searchParams.get('digits')) || 6,
      period: Number(u.searchParams.get('period')) || 30, algorithm: (u.searchParams.get('algorithm') || 'SHA1').toUpperCase(),
    }
  }
  base32(t)
  return { secret: t.toUpperCase().replace(/[\s=-]/g, ''), label: '', issuer: '', digits: 6, period: 30, algorithm: 'SHA1' }
}

/** The text of the QR code in a picture (PNG / JPEG / WebP / screenshot). */
export async function readQr(buf) {
  const sharp = (await import('sharp')).default
  const { default: jsQR } = await import('jsqr')
  // Try it as it is, then larger and sharper (a phone photo of a screen).
  for (const width of [null, 1200, 800]) {
    let img = sharp(buf).rotate().ensureAlpha()
    if (width) img = img.resize({ width, withoutEnlargement: false }).sharpen()
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
    const r = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, { inversionAttempts: 'attemptBoth' })
    if (r?.data) return r.data
  }
  throw new Error('No QR code found in this picture — use a clear picture or screenshot of the QR')
}

/** Saves the account's authenticator (from a QR picture or the key) and says the code now. */
export async function saveAuthenticator(accountId, { image = null, text = '' } = {}) {
  const k = parseKey(image ? await readQr(image) : text)
  setSecret(nameOf(accountId), JSON.stringify(k))
  return { ok: true, label: k.label || k.issuer || '', code: totp(k) }
}

export function removeAuthenticator(accountId) { removeSecret(nameOf(accountId)) }

function keyOf(accountId) {
  if (!accountId) return null
  try { return JSON.parse(getSecret(nameOf(accountId)) || 'null') } catch { return null }
}
export const hasAuthenticator = (accountId) => !!keyOf(accountId)

/** The code for this account now — null when it has no authenticator. A code
 *  with under 5 s left waits for the next one (it would expire on the way). */
export async function codeFor(accountId) {
  const k = keyOf(accountId)
  if (!k) return null
  const left = k.period - (Math.floor(Date.now() / 1000) % k.period)
  if (left < 5) await new Promise(r => setTimeout(r, left * 1000 + 300))
  return totp(k)
}
