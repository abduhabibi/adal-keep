/**
 * LMIS sign-in codes sent by the agency's phone (adal-phone SmsCodeReceiver:
 * "Send LMIS codes to Adal Keep" in Settings → This phone). Kept in memory
 * only, for 10 minutes. The LMIS robot types the newest one that came after
 * it asked (used once), and every PC's document tray shows them with a Copy
 * button, so anyone can type it and carry on (asked on 2026-11-15).
 */
const codes = []   // { code, from, account, at, got, used }
const TTL = 10 * 60000

export function addSmsCode({ code, from = '', account = '', at = Date.now() } = {}) {
  const c = String(code || '').replace(/\D/g, '')
  if (c.length < 4 || c.length > 8) throw Object.assign(new Error('Not a code'), { status: 400 })
  const now = Date.now()
  while (codes.length && now - codes[0].got > TTL) codes.shift()
  // The same SMS twice (the phone tried again): once.
  if (codes.some(x => x.code === c && now - x.got < 2 * 60000)) return { ok: true }
  codes.push({ code: c, from: String(from || '').slice(0, 40), account: String(account || '').slice(0, 80), at: Math.min(Number(at) || now, now), got: now, used: false })
  console.log('[sms] an LMIS code came from the phone')
  import('./liveChannel.js').then(L => L.broadcast({ t: 'sms-code', at: now })).catch(() => {})
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

/** The codes of the last 10 minutes, newest first (the trays show them). */
export function listSmsCodes() {
  const now = Date.now()
  return codes.filter(c => now - c.got <= TTL).map(c => ({ code: c.code, account: c.account, at: c.got, used: c.used })).reverse()
}
