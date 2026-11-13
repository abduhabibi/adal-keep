/**
 * LMIS sign-in codes sent by the agency's phone (adal-phone SmsCodeReceiver:
 * "Send LMIS codes to Adal Keep" in Settings → This phone). Kept in memory
 * only, for 10 minutes, and each is used once: the LMIS robot types the
 * newest one that came after it asked.
 */
const codes = []   // { code, from, at, used }
const TTL = 10 * 60000

export function addSmsCode({ code, from = '', at = Date.now() } = {}) {
  const c = String(code || '').replace(/\D/g, '')
  if (c.length < 4 || c.length > 8) throw Object.assign(new Error('Not a code'), { status: 400 })
  const now = Date.now()
  while (codes.length && now - codes[0].at > TTL) codes.shift()
  codes.push({ code: c, from: String(from || '').slice(0, 40), at: Math.min(Number(at) || now, now), got: now, used: false })
  console.log('[sms] an LMIS code came from the phone')
  return { ok: true }
}

/** The newest unused code that came after `since` (ms), marked used — or null. */
export function takeSmsCode(since = 0) {
  for (let i = codes.length - 1; i >= 0; i--) {
    const c = codes[i]
    if (c.used || c.got < since || Date.now() - c.got > TTL) continue
    c.used = true
    return c.code
  }
  return null
}
