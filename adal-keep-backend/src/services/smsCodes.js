/**
 * LMIS sign-in codes sent by the agency's phone (adal-phone SmsCodeReceiver:
 * "Send LMIS codes to Adal Keep" in Settings → This phone). Kept in memory
 * only, for 10 minutes.
 *
 * Who gets a code — always the one that pressed Sign In for the code's LMIS
 * account (asked on 2026-11-16, 2026-11-20: "identify the PC that sent the
 * LMIS code, and send specifically for him"; "make two PCs waiting at once
 * get the right code"):
 *   - The phone says which LMIS account(s) its SIM is for ("nuzla · 0911… |
 *     ZAD · 0922…"); with two SIMs, which SIM got the SMS ("1:nuzla · … |
 *     2:ZAD · …" and sim: 1|2), so only that SIM's account is meant.
 *   - An Adal Keep robot that pressed Sign In for that account waits for it
 *     (waitForSmsCode): it types it and carries on.
 *   - A person who pressed Sign In by hand: the main PC looks in its own Adal
 *     Browser and every Companion's it is connected to for the LMIS tab whose
 *     code box is open and which is that account's (its browser space), types
 *     the code there and presses the button.
 *   - Only one LMIS tab per account is ever open (services/lmisOne.js), so two
 *     PCs waiting at once are two accounts: each gets its own code.
 *   - The phone named no account (or none matches): the robot waiting longest,
 *     else the one waiting LMIS tab; nobody at all: every PC's tray (Copy).
 */
const codes = []    // { code, from, account, at, got, used, forRun }
const waiters = []  // { id, run, account, since }
const TTL = 10 * 60000
let nextWaiter = 1

const digits = (s) => String(s || '').replace(/\D/g, '')

/** The accounts the phone named: [{ sim, name, phone }] ("1:nuzla · 0911000000 | 2:ZAD · 0922…"). */
export function parseAccounts(text) {
  return String(text || '').split('|').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^([12]):\s*(.*)$/.exec(s)
    const rest = m ? m[2] : s
    const [name, phone = ''] = rest.split('·').map(x => x.trim())
    return { sim: m ? Number(m[1]) : 0, name: name || '', phone }
  })
}

/** Only the SIM's own accounts when the phone said which SIM got the SMS. */
export function accountsFor(text, sim = 0) {
  const all = parseAccounts(text)
  if (!sim || !all.some(a => a.sim)) return all
  return all.filter(a => !a.sim || a.sim === Number(sim))
}

/** Is `acct` ({ phone, name }) one of the named accounts? */
export function isNamed(named, acct) {
  if (!acct || !named.length) return false
  const phone = digits(acct.phone).slice(-9)
  const name = String(acct.name || '').trim().toLowerCase()
  return named.some(a => (phone.length >= 7 && digits(a.phone).slice(-9) === phone) || (!!name && a.name.toLowerCase() === name))
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

let pending = Promise.resolve()
/** Tests: wait until the last code found its robot, its tab (or the trays). */
export const settled = () => pending

export function addSmsCode({ code, from = '', account = '', at = Date.now(), sim = 0 } = {}, { db = null } = {}) {
  const c = String(code || '').replace(/\D/g, '')
  if (c.length < 4 || c.length > 8) throw Object.assign(new Error('Not a code'), { status: 400 })
  const now = Date.now()
  while (codes.length && now - codes[0].got > TTL) codes.shift()
  // The same SMS twice (the phone tried again): once.
  if (codes.some(x => x.code === c && now - x.got < 2 * 60000)) return { ok: true, twice: true }
  for (let i = waiters.length - 1; i >= 0; i--) if (now - waiters[i].since > TTL) waiters.splice(i, 1)
  const named = accountsFor(account, sim)
  const entry = { code: c, from: String(from || '').slice(0, 40), account: String(account || '').slice(0, 120), sim: Number(sim) || 0, at: Math.min(Number(at) || now, now), got: now, used: false, forRun: null }
  codes.push(entry)
  const toRobot = (w) => {
    entry.forRun = w.id
    console.log(`[sms] an LMIS code came from the phone → the robot signing in${w.run ? ` (run #${w.run})` : ''}`)
    return { ok: true, to: 'robot', run: w.run || null }
  }
  // The robot that pressed Sign In for this very account.
  const mine = waiters.find(x => isNamed(named, x.account))
  if (mine) return toRobot(mine)

  // Else the tab a person pressed Sign In in (on whichever PC), this account's first.
  entry.forRun = 'looking'   // in no tray, and no other robot takes it, while it is looked for
  const toTrays = () => {
    entry.forRun = null
    console.log('[sms] an LMIS code came from the phone → every PC\'s tray (nothing waits for it)')
    import('./liveChannel.js').then(L => L.broadcast({ t: 'sms-code', at: now })).catch(() => {})
  }
  pending = (async () => {
    const tabs = await waitingTabs(db)
    const own = tabs.find(t => isNamed(named, t.account))
    const oldest = [...waiters].sort((a, b) => a.since - b.since)[0]
    // Nothing names this account: the robot waiting longest, else the only waiting tab.
    const pick = own || (oldest ? null : tabs.length === 1 ? tabs[0] : tabs.find(t => !t.account) || tabs[0])
    if (!pick && oldest) { toRobot(oldest); return }
    if (!pick || !(await typeInto(pick.page, c))) return toTrays()
    entry.used = true
    entry.forRun = 'pc'
    entry.pc = pick.name
    console.log(`[sms] an LMIS code came from the phone → typed into LMIS on ${pick.name}${pick.account?.name ? ` (${pick.account.name})` : ''}, the tab that pressed Sign In`)
  })().catch(toTrays)
  return { ok: true, to: 'looking' }
}

// Where to look: this PC's Adal Browser (when open) and the Companions' it is connected to.
let browsersOf = async () => {
  const out = []
  try { const b = await (await import('./browser.js')).openBrowserIfAny(); if (b) out.push({ name: 'this PC', browser: b }) } catch {}
  try { out.push(...await (await import('./remoteBrowsers.js')).connectedBrowsers()) } catch {}
  return out
}
// Which LMIS account a tab is signed in to: its browser space's (the main account in the browser's own).
let accountOfTab = async (db, page) => (await import('./lmisOne.js')).accountOfPage(db, page)
export function _setBrowsersForTest(fn, accountFn = null) { browsersOf = fn; if (accountFn) accountOfTab = accountFn }

const within = (p, ms, dflt) => Promise.race([Promise.resolve(p), new Promise(r => setTimeout(() => r(dflt), ms))]).catch(() => dflt)

/** The LMIS tabs, on any PC, whose code box is open and that no robot works in: [{ name, page, account }]. */
export async function waitingTabs(db = null) {
  const { codeBoxUp, isRunTab } = await import('./tabManager.js')
  const out = []
  for (const { name, browser } of await within(browsersOf(), 8000, [])) {
    for (const page of await within(browser.pages(), 4000, [])) {
      let url = ''
      try { url = page.url() } catch {}
      if (!/lmis/i.test(url) || isRunTab(page)) continue
      if (!(await within(codeBoxUp(page), 3000, false))) continue
      out.push({ name: name || 'a PC', page, account: await within(accountOfTab(db, page), 3000, null) })
    }
  }
  return out
}

async function typeInto(page, code) {
  const { typeCodeInto, pressCodeButton } = await import('./tabManager.js')
  if (!(await within(typeCodeInto(page, code), 3000, false))) return false
  await new Promise(r => setTimeout(r, 400))
  await within(pressCodeButton(page), 3000)
  return true
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

/** The codes of the last 10 minutes nothing was given, newest first (every PC's tray shows them). */
export function listSmsCodes() {
  const now = Date.now()
  return codes.filter(c => now - c.got <= TTL && c.forRun == null).map(c => ({ code: c.code, account: c.account, at: c.got, used: c.used })).reverse()
}
