/**
 * One Tasheer sign-in for the whole agency (asked on 2026-11-11). Tasheer
 * keeps one session per account: the agency's lives in the main PC's Adal
 * Browser, where the Tasheer robot works. Every PC sees who signed it in, from
 * which PC and when; "Sign in here" on any PC takes it over: Tasheer's old
 * session on this browser ends (its cookies go), the sign-in opens with the
 * name and password filled, and the person on that PC types the captcha in
 * the live view of the tab (LiveTab "site-tasheer") — the captcha is always a
 * person's. Never while a Tasheer robot is working (it would be cut off).
 * Since 2026-11-21 the captcha comes by notification (its picture and a code
 * box on the PC and the phones, call SIGNIN_CALL): the code typed there goes in
 * and LOGIN is pressed — the live view is only needed when no picture is found.
 */
import { getBrowser, openForPerson, openBrowserIfAny, sendAway } from './browser.js'
import { START, hasPassword, fillLogin, concurrentShown, afterConcurrentLogin, captchaByNotice, loginCodeWanted } from './tasheer.js'
import { askCaptcha as askCall, doneWith } from './attention.js'

/** The notification bar's call for this sign-in (it has no run: a number no run has). */
export const SIGNIN_CALL = -1
// What tasheer.js's captchaByNotice needs to ask here.
const codeCtx = {
  runId: SIGNIN_CALL,
  onLog: async (level, msg) => console.log(`[tasheer] sign-in: ${msg}`),
  askCaptcha: (image, answer, opts) => {
    askCall(SIGNIN_CALL, image, answer, { ...opts, title: opts?.title || 'Tasheer sign-in: type the code' })
    import('./liveChannel.js').then(L => L.broadcast({ t: 'ring', id: Date.now(), title: opts?.title || 'Tasheer sign-in: type the code', run: SIGNIN_CALL, at: Date.now() })).catch(() => {})
    import('./worker.js').then(w => w.beep?.()).catch(() => {})
  },
  forgetCaptcha: () => doneWith(SIGNIN_CALL, { force: true }),
}

const KEY = 'tasheer_holder'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const onTasheer = (p) => { try { return /(^|\.)tasheer\.com$/i.test(new URL(p.url()).hostname) } catch { return false } }
export const signedInUrl = (url) => { try { const u = new URL(url); return /tasheer\.com$/i.test(u.hostname) && /\/auth\//i.test(u.pathname) } catch { return false } }

let tab = null          // the take-over's tab (live view "site-tasheer")
let watching = false
let chosen = null       // the Tasheer account chosen for this sign-in

export async function holderOf(db) {
  const r = await db('settings').where({ key: KEY }).first('value').catch(() => null)
  try { return JSON.parse(r?.value || 'null') } catch { return null }
}
export async function setHolder(db, h) {
  const value = JSON.stringify({ ...h, at: h.at || new Date().toISOString() })
  const n = await db('settings').where({ key: KEY }).update({ value }).catch(() => 0)
  if (!n) await db('settings').insert({ key: KEY, value }).catch(() => {})
}

/** The live view's tab for a site sign-in ("site-tasheer"), or null. */
export async function siteTab(name) {
  if (name !== 'site-tasheer') return null
  if (tab && !tab.isClosed?.()) return tab
  const browser = await openBrowserIfAny()
  const pages = browser ? await browser.pages().catch(() => []) : []
  return pages.find(p => onTasheer(p) && !p.isClosed?.()) || null
}

/** Who has Tasheer now: { by, pc, at, state } plus whether a Tasheer tab is signed in. */
export async function tasheerNow(db) {
  const h = await holderOf(db)
  const browser = await openBrowserIfAny()
  const pages = browser ? await browser.pages().catch(() => []) : []
  const signedIn = pages.some(p => onTasheer(p) && signedInUrl(p.url()))
  return { ...(h || {}), signedIn, signingIn: !!(tab && !tab.isClosed?.() && !signedIn && h?.state === 'signing-in') }
}

/** "Sign in here": the agency's Tasheer sign-in moves to this person. */
export async function takeOver(db, { by = '', pc = '', accountId = null, quiet = false } = {}) {
  const working = await db('automation_queue').where('status', 'running').where('workflow_id', 'like', 'tasheer%').first('id').catch(() => null)
  if (working) throw new Error(`A Tasheer robot is working now (run #${working.id}) — wait until it is done, or stop it, then sign in.`)
  const acct = await (accountId ? db('tasheer_accounts').where('id', Number(accountId)) : db('tasheer_accounts').orderBy('is_default', 'desc')).first().catch(() => null)
  chosen = acct?.id || null
  if (!acct?.username || !acct?.password) throw new Error('No Tasheer account yet — add one under AI Actions → Tasheer → Login')
  const browser = await getBrowser()
  const pages = (await browser.pages().catch(() => [])).filter(p => onTasheer(p) && !p.isClosed?.())
  // (The morning sign-in, from start-up: a tab out of sight, never a window — the live view shows it.)
  const page = pages[0] || (quiet ? await (await import('./browser.js')).newRunTab(browser, null, { quiet: true }) : await openForPerson())
  for (const p of pages.slice(1)) await p.close().catch(() => {})
  // The old session ends here: Tasheer's cookies go, so the sign-in is a new one.
  const cdp = await page.createCDPSession()
  try {
    const { cookies } = await cdp.send('Network.getAllCookies')
    for (const c of cookies.filter(c => /tasheer\.com$/i.test(String(c.domain).replace(/^\./, '')))) {
      await cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }).catch(() => {})
    }
  } finally { await cdp.detach().catch(() => {}) }
  tab = page
  await setHolder(db, { by: by || 'someone', pc: pc || 'a PC', state: 'signing-in', at: new Date().toISOString() })
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
  // Cloudflare's check (a person ticks it in the live view) and then the sign-in form.
  let filled = false
  for (const end = Date.now() + 60000; Date.now() < end && !filled;) {
    await sleep(2000)
    if (await hasPassword(page)) filled = await fillLogin(page, acct.username, acct.password).catch(() => false)
  }
  watch(db, page, { by, pc })
  return { ok: true, live: 'site-tasheer', filled }
}

// Until the person has signed in (30 minutes at most): then it is theirs.
function watch(db, page, who) {
  if (watching) return
  watching = true
  ;(async () => {
    let asks = 0
    try {
      for (const end = Date.now() + 30 * 60000; Date.now() < end;) {
        await sleep(3000)
        if (page.isClosed?.()) break
        // "Concurrent Login": SUBMIT, the same name and password again, the
        // person types only the new captcha, LOGIN pressed for them.
        if (await concurrentShown(page)) {
          const acct = await (chosen ? db('tasheer_accounts').where('id', chosen) : db('tasheer_accounts').orderBy('is_default', 'desc')).first().catch(() => null)
          if (acct?.username && acct?.password) {
            const creds = { user: acct.username, pass: acct.password }
            const out = await afterConcurrentLogin(page, acct.username, acct.password, {
              say: (m) => console.log(`[tasheer] sign-in: ${m}`), captchaMs: Math.max(60000, end - Date.now()),
              ask: asks < 6 ? (title) => { asks++; return captchaByNotice(page, codeCtx, { title, press: 'login', creds, gone: async () => !(await hasPassword(page)) }) } : null,
            }).catch(() => '')
            if (out === 'no-captcha-typed') asks = 6        // nobody answered in 5 minutes: the live view is theirs
            continue
          }
        }
        // The sign-in waits for its captcha: asked by notification (5 minutes; up to 6 times for wrong codes).
        if (asks < 6 && await loginCodeWanted(page)) {
          const acct = await (chosen ? db('tasheer_accounts').where('id', chosen) : db('tasheer_accounts').orderBy('is_default', 'desc')).first().catch(() => null)
          asks++
          const r = await captchaByNotice(page, codeCtx, {
            title: asks > 1 ? 'Not accepted: type the new Tasheer code' : 'Tasheer sign-in: type the code', press: 'login',
            creds: acct ? { user: acct.username, pass: acct.password } : null, gone: async () => !(await hasPassword(page)),
          }).catch(() => 'gone')
          if (r === 'expired') { asks = 6; console.log('[tasheer] sign-in: nobody typed the code within 5 minutes — left to the live view') }
          if (r === 'typed') await sleep(5000)
          continue
        }
        // The form came back empty (a wrong captcha, Cloudflare): filled again.
        if (await hasPassword(page)) {
          const acct = await (chosen ? db('tasheer_accounts').where('id', chosen) : db('tasheer_accounts').orderBy('is_default', 'desc')).first().catch(() => null)
          const empty = await page.evaluate(() => ![...document.querySelectorAll('input[type="password"]')].some(i => i.value)).catch(() => false)
          if (acct && empty) await fillLogin(page, acct.username, acct.password).catch(() => {})
          continue
        }
        if (signedInUrl(page.url())) {
          await setHolder(db, { ...who, state: 'signed-in', at: new Date().toISOString() })
          console.log(`[tasheer] signed in by ${who.by || 'someone'} (${who.pc || 'a PC'})`)
          await sendAway(page).catch(() => {})
          break
        }
      }
    } finally { watching = false; doneWith(SIGNIN_CALL, { force: true }) }
  })()
}

/** A Tasheer robot signed in (a person typed its captcha): the sign-in is theirs. */
export async function robotSignedIn(db, by = '', pc = '') {
  await setHolder(db, { by: by || 'the Tasheer robot', pc: pc || 'main PC', state: 'signed-in', at: new Date().toISOString() })
}
