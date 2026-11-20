/**
 * LMIS sign-in codes sent by the agency's phone (adal-phone SmsCodeReceiver:
 * "Send LMIS codes to Adal Keep" in Settings → This phone). Kept in memory
 * only, for 10 minutes.
 *
 * Who gets a code (asked on 2026-11-16):
 *   - an Adal Keep robot that pressed LMIS's Sign In (so it made LMIS send
 *     the SMS) is waiting for it (waitForSmsCode): the code is that robot's —
 *     the one for the same LMIS account (its phone number or name), else the
 *     robot that has waited longest. The robot types it, presses the button
 *     and carries on; the code is not shown in anyone's tray.
 *   - nobody in Adal Keep asked for it (a person signed in to LMIS by hand):
 *     the PC whose Adal Browser has LMIS open on its code box is the one that
 *     pressed Sign In (asked on 2026-11-20: "identify the PC that sent the LMIS
 *     code, and send specifically for him"). The main PC looks at its own
 *     Adal Browser and every Companion's it is connected to, types the code
 *     into that tab and presses the button — nobody copies anything. Only when
 *     no such tab is found does every PC's tray show it with a Copy button.
 */
const codes = []    // { code, from, account, at, got, used, forRun }
const waiters = []  // { id, run, account, since }
const TTL = 10 * 60000
let nextWaiter = 1

const digits = (s) => String(s || '').replace(/\D/g, '')
/** Does the code's account (what the phone was told: "nuzla · 0912345678 | ZAD · …") name this robot's account? */
function sameAccount(codeAccount, w) {
  const text = String(codeAccount || '').toLowerCase()
  if (!text || !w.account) return false
  const phone = digits(w.account.phone).slice(-9)
  if (phone.length >= 7 && digits(text).includes(phone)) return true
  const name = String(w.account.name || '').trim().toLowerCase()
  return !!name && text.split('|').some(part => part.split('·')[0].trim() === name)
}

/**
 * A robot pressed LMIS's Sign In and waits for its SMS code. account: { phone, name }.
 * Returns the waiter's id; call stopWaiting(id) when signed in (or given up).
 */
export function waitForSmsCode({ run = null, account = {} } = {}) {
  const w = { id: nextWaiter++, run, account, since: Date.now() }
  waiters.push(w)
  return w.id
}
export function stopWaiting(id) {
  const i = waiters.findIndex(w => w.id === id)
  if (i >= 0) waiters.splice(i, 1)
  // A code it was given and never typed (it gave up): every PC's tray shows it after all.
  for (const c of codes) if (c.forRun === id && !c.used) c.forRun = null
}

export function addSmsCode({ code, from = '', account = '', at = Date.now() } = {}) {
  const c = String(code || '').replace(/\D/g, '')
  if (c.length < 4 || c.length > 8) throw Object.assign(new Error('Not a code'), { status: 400 })
  const now = Date.now()
  while (codes.length && now - codes[0].got > TTL) codes.shift()
  // The same SMS twice (the phone tried again): once.
  if (codes.some(x => x.code === c && now - x.got < 2 * 60000)) return { ok: true, twice: true }
  for (let i = waiters.length - 1; i >= 0; i--) if (now - waiters[i].since > TTL) waiters.splice(i, 1)
  // The robot that made LMIS send it: the same account's, else the one waiting longest.
  const w = waiters.find(x => sameAccount(account, x)) || [...waiters].sort((a, b) => a.since - b.since)[0] || null
  codes.push({ code: c, from: String(from || '').slice(0, 40), account: String(account || '').slice(0, 80), at: Math.min(Number(at) || now, now), got: now, used: false, forRun: w ? w.id : null })
  if (w) {
    console.log(`[sms] an LMIS code came from the phone → the robot signing in${w.run ? ` (run #${w.run})` : ''}`)
    return { ok: true, to: 'robot', run: w.run || null }
  }
  const entry = codes[codes.length - 1]
  entry.forRun = 'looking'   // in no tray while the PC that asked for it is looked for
  const toTrays = () => {
    entry.forRun = null
    console.log('[sms] an LMIS code came from the phone → every PC\'s tray (no LMIS tab waits for it)')
    import('./liveChannel.js').then(L => L.broadcast({ t: 'sms-code', at: now })).catch(() => {})
  }
  pending = typeIntoWaitingTab(c).then(pc => {
    if (!pc) return toTrays()
    entry.used = true
    entry.forRun = 'pc'
    entry.pc = pc
    console.log(`[sms] an LMIS code came from the phone → typed into LMIS on ${pc} (the PC that pressed Sign In)`)
  }).catch(toTrays)
  return { ok: true, to: 'looking' }
}

let pending = Promise.resolve()
/** Tests: wait until the last code found its PC (or the trays). */
export const settled = () => pending

// Where to look: this PC's Adal Browser (when open) and the Companions' it is connected to.
let browsersOf = async () => {
  const out = []
  try { const b = await (await import('./browser.js')).openBrowserIfAny(); if (b) out.push({ name: 'this PC', browser: b }) } catch {}
  try { out.push(...await (await import('./remoteBrowsers.js')).connectedBrowsers()) } catch {}
  return out
}
export function _setBrowsersForTest(fn) { browsersOf = fn }

/**
 * The LMIS tab whose code box shows, on whichever PC: the code is typed there
 * and its button pressed. Answers that PC's name, or '' when there is none.
 */
export async function typeIntoWaitingTab(code) {
  const { codeBoxUp, typeCodeInto, pressCodeButton } = await import('./tabManager.js')
  const within = (p, ms, dflt) => Promise.race([p, new Promise(r => setTimeout(() => r(dflt), ms))]).catch(() => dflt)
  for (const { name, browser } of await within(browsersOf(), 8000, [])) {
    for (const page of await within(browser.pages(), 4000, [])) {
      let url = ''
      try { url = page.url() } catch {}
      if (!/lmis/i.test(url)) continue
      if (!(await within(codeBoxUp(page), 3000, false))) continue
      if (!(await within(typeCodeInto(page, code), 3000, false))) continue
      await new Promise(r => setTimeout(r, 400))
      await within(pressCodeButton(page), 3000)
      return name || 'a PC'
    }
  }
  return ''
}

/**
 * The newest unused code for this waiter (or, with none of its own, one nobody
 * was given) that came after `since` (ms), marked used — or null.
 */
export function takeSmsCode(since = 0, waiter = null) {
  const fresh = (c) => !c.used && c.got >= since && Date.now() - c.got <= TTL
  const pick = [...codes].reverse().find(c => fresh(c) && waiter != null && c.forRun === waiter)
    || [...codes].reverse().find(c => fresh(c) && c.forRun == null)
  if (!pick) return null
  pick.used = true
  return pick.code
}

/** The codes of the last 10 minutes no robot was given, newest first (every PC's tray shows them). */
export function listSmsCodes() {
  const now = Date.now()
  return codes.filter(c => now - c.got <= TTL && c.forRun == null).map(c => ({ code: c.code, account: c.account, at: c.got, used: c.used })).reverse()
}
