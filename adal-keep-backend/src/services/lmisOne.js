/**
 * lmisOne.js — one LMIS per account (asked on 2026-11-20: "never make 2 LMIS
 * websites opened in the same account in the Adal Keep browser, to don't
 * confuse the system").
 *
 * Every LMIS sign-in of an account sends an SMS code and can sign the other
 * one out. So an account is open in one place only:
 *   - a run for an account whose LMIS is already open in some Adal Browser
 *     (this PC's or a Companion's) works there, in that tab (worker.js);
 *   - on one PC its runs take the tab that is there (tabManager.js), also
 *     when it works for another PC out of sight;
 *   - the SMS code goes to the tab of the code's account (smsCodes.js).
 * Which account a tab is: its browser space (browser.js accountSpace); the
 * browser's own space is the main account (the default, else the first).
 */

const LMIS = /(^|\.)lmis\.gov\.et$/i
// A tab's space key: '' in the browser's own space, '?' in a space nobody knows.
function keyOf(page, spaceOf) {
  try { if (page.browserContext() === page.browser().defaultBrowserContext()) return '' } catch {}
  return spaceOf(page) || '?'
}
const isLmis = (url) => { try { return LMIS.test(new URL(url).hostname) } catch { return false } }

async function mainAccount(db) {
  if (!db) return null
  return db('lmis_accounts').orderBy('is_default', 'desc').orderBy('id').first().catch(() => null)
}

/** The space key an LMIS account works in: '' (the browser's own) for the main account. */
export async function spaceKeyFor(db, accountId) {
  const main = await mainAccount(db)
  if (!accountId || !main || Number(main.id) === Number(accountId)) return ''
  return `lmis:${Number(accountId)}`
}

/** The LMIS account ({ id, name, phone }) a tab works in, from its browser space — or null. */
export async function accountOfPage(db, page, spaceOf = null) {
  const key = keyOf(page, spaceOf || spaceOfPage || (await import('./browser.js')).spaceOf)
  let row = null
  if (!key) row = await mainAccount(db)
  else if (/^lmis:\d+$/.test(key)) row = db ? await db('lmis_accounts').where('id', Number(key.split(':')[1])).first().catch(() => null) : null
  else return null   // another portal's space
  if (!row) return null
  return { id: row.id, name: row.name || '', phone: row.phone || row.login_value || '' }
}

// The browsers to look in: { device: '' (this PC) | Companion id, name, browser }.
let browsersOf = async () => {
  const out = []
  try { const b = await (await import('./browser.js')).openBrowserIfAny(); if (b) out.push({ device: '', name: 'this PC', browser: b }) } catch {}
  // Another PC's browser only with ADAL_LAN_ROBOTS=1 (sharePower.lanRobots): runs stay on this PC.
  if (process.env.ADAL_LAN_ROBOTS === '1') try { for (const x of await (await import('./remoteBrowsers.js')).connectedBrowsers()) out.push({ device: x.id, name: x.name, browser: x.browser }) } catch {}
  return out
}
let spaceOfPage = null
export function _setForTest({ browsers = null, spaceOf = null } = {}) { if (browsers) browsersOf = browsers; spaceOfPage = spaceOf }

const within = (p, ms, dflt) => Promise.race([Promise.resolve(p), new Promise(r => setTimeout(() => r(dflt), ms))]).catch(() => dflt)

/**
 * Where this LMIS account is open now: { device, name } of the PC whose Adal
 * Browser has an LMIS tab in the account's space, or null. A signed-in tab
 * (or one waiting for its SMS code) counts before one on the sign-in page.
 */
export async function lmisHome(db, accountId) {
  const main = await mainAccount(db)
  const want = await spaceKeyFor(db, accountId || main?.id)
  const spaceOf = spaceOfPage || (await import('./browser.js')).spaceOf
  let found = null
  for (const b of await within(browsersOf(), 8000, [])) {
    for (const page of await within(b.browser.pages(), 4000, [])) {
      let url = ''
      try { url = page.url() } catch {}
      if (!isLmis(url) || keyOf(page, spaceOf) !== want) continue
      const inside = !/\/(auth|login)/i.test(new URL(url).pathname)
      if (inside) return { device: b.device, name: b.name }
      found = found || { device: b.device, name: b.name }
    }
  }
  return found
}
