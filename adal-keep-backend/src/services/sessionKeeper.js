/**
 * Sign in once in the morning, good for the whole day (asked on 2026-11-10).
 *
 * Every 4 minutes each site's signed-in tab gets a sign of life, out of sight:
 * a mouse move and a key (what a site's "you were idle" timer listens to) and
 * its own page asked for again in the background — never brought to the
 * front, never a tab a robot is working in, never a page with something typed
 * in it. Every 20 minutes a quiet tab is reloaded too (a site that keeps its
 * sign-in only while its pages load) — never LMIS: there two of its own menu
 * links are clicked in turn instead (asked on 2026-11-15). The robots then find the site signed in
 * and go straight to work there (tabManager.borrowSignIn / findFreeTab).
 *
 * GET  /api/sessions             each site: signed in or not, its tabs, last kept
 * POST /api/sessions/:key/open   a window on that site to sign in
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getBrowser, openBrowserIfAny, quitBrowser, newRunTab, spaceOf } from './browser.js'
import { hostOf, handTabToPerson } from './tabManager.js'

export const SITES = [
  { key: 'musaned', name: 'Musaned', host: /(^|\.)musaned\.com\.sa$/, start: 'https://tawtheeq.musaned.com.sa/', out: /\/(login|auth)\b|sso\.|wahid\.sa/i },
  { key: 'mofa', name: 'Enjaz (visa)', host: /(^|\.)visa\.mofa\.gov\.sa$/, start: 'https://visa.mofa.gov.sa/', out: /\/account\/login/i },
  { key: 'insurance', name: 'Insurance', host: /(^|\.)niscofetap\.com$/, start: 'https://agency.niscofetap.com/', out: /login|sign-?in|auth/i },
  { key: 'lmis', name: 'LMIS', host: /(^|\.)lmis\.gov\.et$/, start: 'https://lmis.gov.et/', out: /\/(auth|login)/i },
  // One sign-in for the agency (services/tasheerSession.js): signed in = its inner pages (/auth/…).
  { key: 'tasheer', name: 'Tasheer', host: /(^|\.)tasheer\.com$/, start: 'https://agents.tasheer.com/AgentTasheer/', out: /^(?!.*\/auth\/)/i },
]
const EVERY_MS = 4 * 60000, RELOAD_MS = 20 * 60000
export const kept = {}   // site key → { at, tabs, signedIn, error }
let timer = null, busy = false, db = null

const siteOf = (url) => { try { const h = hostOf(url); return SITES.find(s => s.host.test(h)) || null } catch { return null } }
const signedInAt = (site, url) => { try { return !site.out.test(new URL(url).pathname + new URL(url).hostname) } catch { return false } }

async function runningTabs() {
  const ids = new Set((await db('automation_queue').where('status', 'running').select('id').catch(() => [])).map(r => Number(r.id)))
  return ids
}

// Never a link that does something: out, delete, pay, a new form.
const RISKY = /log ?out|sign ?out|ውጣ|delete|remove|cancel|pay|submit|create|add|new\b|apply|print|download|ሰርዝ/i

/**
 * Which two LMIS menu links to click: one away from this page, then the one
 * back to it (else a second menu page). links: [{ path, text, menu }].
 */
export function pickLmisLinks(links, here) {
  const ok = links.filter(l => l.path && !/\/(auth|login)/i.test(l.path) && !RISKY.test(l.text || '') && !RISKY.test(l.path.replace(/^\/new-agency/, '')))
  const away = ok.filter(l => l.path !== here).sort((a, b) => (b.menu ? 1 : 0) - (a.menu ? 1 : 0))
  if (!away.length) return []
  const back = ok.find(l => l.path === here) || away.find(l => l.path !== away[0].path)
  return back ? [away[0], back] : [away[0]]
}

/**
 * LMIS's sign of life: two of its own menu links clicked in turn, inside the
 * app (its router, no page load), out of sight. False when no link was found
 * or the tab left the app (the mouse/key nudge was still given).
 */
async function clickBackAndForth(p) {
  const inTime = (x, ms = 8000) => Promise.race([x, new Promise(r => setTimeout(() => r(null), ms))])
  const links = await inTime(p.evaluate(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    return [...document.querySelectorAll('a[href]')].filter(a => seen(a) && a.host === location.host && a.target !== '_blank' && !/^javascript:/i.test(a.getAttribute('href') || ''))
      .map(a => ({ path: a.pathname, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60), menu: !!a.closest('nav, aside, [class*="sidebar" i], [class*="menu" i], [role="menu"]') }))
  }).catch(() => null))
  let here = ''
  try { here = new URL(p.url()).pathname } catch { return false }
  const pick = pickLmisLinks(links || [], here)
  if (!pick.length) return false
  // No run takes the tab while it is clicked through (tabManager.findFreeTab skips a borrowed tab).
  p.__adalBorrowed = true
  try {
    for (const l of pick) {
      const clicked = await inTime(p.evaluate((path) => {
        const a = [...document.querySelectorAll('a[href]')].find(x => x.pathname === path && x.host === location.host && x.getBoundingClientRect().width > 0)
        a?.click()
        return !!a
      }, l.path).catch(() => false))
      if (!clicked) return false
      await new Promise(r => setTimeout(r, 4000))
      try { if (/\/(auth|login)/i.test(new URL(p.url()).pathname)) return false } catch { return false }
    }
    return true
  } finally { p.__adalBorrowed = false }
}

/** Is this tab signed in to its site? (Musaned by its own menu, LMIS not its public home.) */
export async function tabSignedIn(site, p) {
  let inNow = signedInAt(site, p.url())
  if (inNow && site.key === 'musaned') {
    const st = await Promise.race([import('./musanedWorkflow.js').then(w => w.snapshotState(p)).catch(() => null), new Promise(r => setTimeout(() => r(null), 8000))])
    inNow = !!(st && (st.hasDashboardNav || st.hasHrPoolPage) && !st.hasPassword)
  }
  if (inNow && site.key === 'lmis') {
    const pub = await Promise.race([p.evaluate(() => { const t = [...document.querySelectorAll('a, button')].map(e => (e.innerText || '').trim()); return t.some(x => /^(log ?in|sign ?in)$/i.test(x)) && !t.some(x => /log ?out|sign ?out|ውጣ/i.test(x)) }).catch(() => false), new Promise(r => setTimeout(() => r(false), 8000))])
    if (pub) inNow = false
  }
  return inNow
}

export const IDLE_BROWSER_MS = Number(process.env.ADAL_IDLE_BROWSER_MS) || 10 * 60 * 1000
let blankSince = 0
const BLANK = /^(|about:blank|chrome:\/\/new-?tab(-page)?\/?.*|chrome-untrusted:.*|data:,)$/i
/**
 * An open browser with only blank tabs and no run: how long it has been so, and whether to quit it.
 * since: when it was first seen so (0 = not so). Pure (tested).
 */
export function idleBrowser(urls, runs, since, now = Date.now(), limit = IDLE_BROWSER_MS) {
  if (runs > 0 || urls.some(u => !BLANK.test(String(u)))) return { quit: false, since: 0 }
  const from = since || now
  return { quit: now - from >= limit, since: from }
}
/** A window a person opened to sign in (kept even when blank for a moment): never quit under them. */
async function hasPersonWindow(browser) {
  try { return (await browser.pages()).some(p => p.__adalBorrowed || p.__adalPerson) } catch { return true }
}

/** One round: every site tab that is signed in gets its sign of life. */
export async function keepAlive() {
  if (busy) return kept
  busy = true
  try {
    // Never starts the browser (2026-11-22: this look every 4 minutes brought Adal Browser back on a swamped PC
    // each time it was closed): no browser open = nothing to keep signed in.
    const browser = await openBrowserIfAny().catch(() => null)
    if (!browser) { blankSince = 0; return kept }
    const running = await runningTabs()
    const pages = await browser.pages().catch(() => [])
    // Open with nothing in it (blank tabs only), nothing running, for IDLE_BROWSER_MS: quit.
    const idle = idleBrowser(pages.filter(p => !p.isClosed?.()).map(p => { try { return p.url() } catch { return '' } }), running.size, blankSince)
    blankSince = idle.since
    if (idle.quit && !(await hasPersonWindow(browser))) { blankSince = 0; await quitBrowser().catch(() => {}); return kept }
    const seen = Object.fromEntries(SITES.map(s => [s.key, { tabs: 0, signedIn: false, spaces: {} }]))
    for (const p of pages) {
      if (p.isClosed?.()) continue
      const site = siteOf(p.url())
      if (!site) continue
      seen[site.key].tabs++
      const inNow = await tabSignedIn(site, p)
      // Which account: its browser space ("musaned:7"; '' = the site's main account).
      if (inNow) { seen[site.key].signedIn = true; seen[site.key].spaces[spaceOf(p)] = true }
      // Musaned's "Access Denied" (/403, a page opened before the agency was
      // chosen): back to its front page and the agency's own card again.
      if (site.key === 'musaned' && /\/403\b/.test(p.url()) && !p.__adalBorrowed && !running.has(Number(p.__adalRunId))) {
        try {
          await p.goto('https://tawtheeq.musaned.com.sa/', { waitUntil: 'domcontentloaded', timeout: 60000 })
          await new Promise(r => setTimeout(r, 3000))
          const acct = await db('musaned_accounts').orderBy('is_default', 'desc').orderBy('id').first().catch(() => null)
          const w = await import('./musanedWorkflow.js')
          const st = await w.snapshotState(p).catch(() => null)
          const ctx = { db, account_id: acct?.id, musaned_username: acct?.username, musaned_name: acct?.name }
          if (st?.hasAgencyPicker) { await w.stepClickAgencyCard(p, ctx).catch(() => {}); await w.stepClickGoToDashboard(p, ctx).catch(() => {}) }
          else if (st?.hasGoToDashboard) await w.stepClickGoToDashboard(p, ctx).catch(() => {})
          console.log('[sessions] Musaned was on "Access Denied" — back to the agency dashboard')
        } catch {}
        continue
      }
      // Never a tab a robot is working in, nor one a person is typing in.
      if (!inNow || p.__adalBorrowed || running.has(Number(p.__adalRunId))) continue
      try {
        const typed = await Promise.race([p.evaluate(async () => {
          const typed = [...document.querySelectorAll('input, textarea')].some(e => !['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue)
          // What an idle timer listens to — a person moving the mouse and pressing a key.
          const x = 40 + Math.floor(Math.random() * 200), y = 40 + Math.floor(Math.random() * 200)
          for (const t of ['mousemove', 'mousedown', 'mouseup']) document.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y }))
          document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }))
          document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
          window.dispatchEvent(new Event('scroll'))
          // Its own page, asked for again in the background: the site's sign-in stays fresh.
          try { await fetch(location.href, { credentials: 'include', cache: 'no-store' }) } catch {}
          return typed
        }), new Promise(r => setTimeout(() => r(null), 15000))])
        // LMIS: back and forth between two of its own menu pages, never a reload
        // (a reload of its app can lose the sign-in, and a new one costs an SMS code) (asked on 2026-11-15).
        if (site.key === 'lmis') {
          if (typed === false && !(await clickBackAndForth(p)) && !signedInAt(site, p.url())) seen[site.key].signedIn = false
          continue
        }
        // Now and then a quiet tab loads again (sites that keep the sign-in only while pages load).
        if (typed === false && Date.now() - (p.__adalReloaded || 0) > RELOAD_MS) {
          p.__adalReloaded = Date.now()
          await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
          if (!signedInAt(site, p.url())) seen[site.key].signedIn = false
        }
      } catch {}
    }
    const at = new Date().toISOString()
    for (const s of SITES) kept[s.key] = { ...seen[s.key], at }
    if (Object.values(seen).some(x => x.signedIn)) await saveSessionCookies(browser).catch(e => console.warn('[sessions] cookies not kept:', e.message))
    await closeSpareTabs(pages).catch(e => console.warn('[sessions] spare tabs:', e.message))
    await wafidStandby(browser, pages, running).catch(e => console.warn('[sessions] Wafid standby:', e.message))
    return kept
  } finally { busy = false }
}

// ── a day's sign-ins survive the browser starting again (the owner, 2026-11-24: "not relogin at all and keep
// every login for a day") ──────────────────────────────────────────────────────────────────────────────────
// A site's sign-in that lives only while the browser is open (a "session" cookie) was lost each time the
// robot browser started again (Adal Keep starts it without its last tabs). Every 4 minutes those cookies of
// the portals are kept here, locked with the account vault; a browser started again gets them back (24 h).
const PORTAL_COOKIES = /(^|\.)(musaned\.com\.sa|wahid\.sa|visa\.mofa\.gov\.sa|niscofetap\.com|lmis\.gov\.et|tasheer\.com|wafid\.com)$/i
const COOKIE_FILE = process.env.ADAL_SESSION_COOKIES || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'session-cookies.json')
export const COOKIES_KEPT_MS = 24 * 3600e3
export const portalSessionCookies = (cookies = []) => cookies
  .filter(c => c.session && PORTAL_COOKIES.test(String(c.domain || '').replace(/^\./, '')))
  .map(({ name, value, domain, path, secure, httpOnly, sameSite }) => ({ name, value, domain, path, secure, httpOnly, ...(sameSite ? { sameSite } : {}) }))

export async function saveSessionCookies(browser, { file = COOKIE_FILE, now = Date.now() } = {}) {
  const cdp = await browser.target().createCDPSession()
  try {
    const { cookies } = await cdp.send('Storage.getCookies')
    const keep = portalSessionCookies(cookies)
    if (!keep.length) return 0
    const { seal } = await import('./accountVault.js')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ at: now, cookies: seal(JSON.stringify(keep)) }), { mode: 0o600 })
    return keep.length
  } finally { cdp.detach().catch(() => {}) }
}

/** A robot browser just started: the day's sign-ins back (none older than 24 h). → how many cookies. */
export async function restoreSessionCookies(browser, { file = COOKIE_FILE, now = Date.now() } = {}) {
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return 0 }
  if (!saved?.cookies || !(now - Number(saved.at) < COOKIES_KEPT_MS)) return 0
  const { open } = await import('./accountVault.js')
  let cookies = []
  try { cookies = JSON.parse(open(saved.cookies) || '[]') } catch { return 0 }
  if (!cookies.length) return 0
  const cdp = await browser.target().createCDPSession()
  try { await cdp.send('Storage.setCookies', { cookies }) } finally { cdp.detach().catch(() => {}) }
  console.log(`[sessions] the day's sign-ins are back in the robot browser (${cookies.length} cookies, kept ${Math.round((now - saved.at) / 60000)} min ago)`)
  return cookies.length
}

/**
 * What to close of a site's tabs (each { owned, signedIn, typed, borrowed }): none while no tab is signed in;
 * else every tab no run needs any more (its run ended, or none) that is signed out or a spare copy — one free
 * signed-in tab stays for the next run. Never a run's tab, a borrowed one, or one with something typed. Pure.
 */
export function spareTabs(tabs) {
  if (!tabs.some(t => t.signedIn)) return []
  const free = tabs.filter(t => !t.owned && !t.borrowed && !t.typed)
  const keepOne = tabs.some(t => t.signedIn && (t.owned || t.borrowed)) ? null : free.find(t => t.signedIn)
  return free.filter(t => t !== keepOne)
}
// Finished runs' tabs and a stray signed-out tab cost memory and processor on a weak PC (2026-11-24: two
// forms waiting for Save, a /login tab, the standby): closed every 4 minutes, out of sight.
async function closeSpareTabs(pages) {
  const { activeRunIds } = await import('./tabManager.js')
  const active = await activeRunIds(db)
  for (const site of SITES) {
    const tabs = []
    for (const p of pages) {
      if (p.isClosed?.() || siteOf(p.url()) !== site || spaceOf(p)) continue   // the main account's space only
      const typed = await Promise.race([p.evaluate(() => [...document.querySelectorAll('input, textarea')].some(e => !['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue)).catch(() => true), new Promise(r => setTimeout(() => r(true), 5000))])
      const id = Number(p.__adalRunId)
      tabs.push({ p, owned: Number.isFinite(id) && active.has(id), borrowed: !!p.__adalBorrowed || !!p.__adalShown || !!p.__adalPerson, typed, signedIn: signedInAt(site, p.url()) })
    }
    const go = spareTabs(tabs)
    for (const t of go) await t.p.close().catch(() => {})
    if (go.length) console.log(`[sessions] ${site.name}: ${go.length} tab(s) no run needs any more closed (one signed-in tab stays)`)
  }
}

// ── Wafid on standby (the owner, 2026-11-24: "keep the wafid stand by to make things faster, cuz wafid doesn't
// need login") ─────────────────────────────────────────────────────────────────────────────────────────────
// One Wafid tab out of sight, its page loaded and ready: a Wafid run takes it (tabManager.findFreeTab) and
// starts at once, no page load (wafidWorkflow.toPage). Checked with the other sites every 4 minutes, nothing
// else: loaded again only when it is 30 minutes old or shows an error; after a run, back to its page. Its
// pictures stay off (Google's reCAPTCHA always comes: tabManager).
export const WAFID_STANDBY = 'https://wafid.com/en/search-slip/'
export const STANDBY_FRESH_MS = 30 * 60e3
const WAFID = /(^|\.)wafid\.com$/i
/** What to do with the Wafid tabs now: 'open' | 'load' (back to its page / fresh again) | 'ok'. Pure. */
export function standbyStep(tab, now = Date.now()) {
  if (!tab) return 'open'
  if (tab.busy || tab.typed) return 'ok'                     // a run or a person in it: never touched
  if (tab.url !== WAFID_STANDBY || tab.broken) return 'load'
  return now - (tab.loadedAt || 0) > STANDBY_FRESH_MS ? 'load' : 'ok'
}
export async function wafidStandby(browser, pages, running = new Set(), now = Date.now()) {
  if (process.env.ADAL_WAFID_STANDBY === '0') return null
  const tabs = pages.filter(p => { try { return !p.isClosed?.() && WAFID.test(hostOf(p.url())) } catch { return false } })
  let p = tabs.find(t => !running.has(Number(t.__adalRunId)) && !t.__adalBorrowed) || tabs[0] || null
  let info = null
  if (p) {
    const st = await Promise.race([p.evaluate(() => ({
      typed: [...document.querySelectorAll('input, textarea')].some(e => !['hidden', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue),
      broken: (document.body?.innerText || '').trim().length < 40 || /\b(50[234]|error|not available|unavailable)\b/i.test(document.title),
    })).catch(() => null), new Promise(r => setTimeout(() => r(null), 8000))])
    info = { url: p.url(), busy: running.has(Number(p.__adalRunId)) || !!p.__adalBorrowed, typed: !!st?.typed, broken: !st || st.broken, loadedAt: p.__adalStandbyAt || 0 }
  }
  const step = standbyStep(info, now)
  if (step === 'ok') return step
  if (step === 'open') {
    p = await newRunTab(browser, null, { quiet: true })
    await (await import('./tabManager.js')).setupTab(p)       // pictures off (reCAPTCHA on), out of sight
  }
  await p.goto(WAFID_STANDBY, { waitUntil: 'domcontentloaded', timeout: 60000 })
  p.__adalStandbyAt = Date.now()
  console.log(`[sessions] Wafid on standby: ${step === 'open' ? 'a tab opened' : 'its page loaded again'} (${WAFID_STANDBY})`)
  return step
}

/** The robot browser holds a site signed in now (memoryGuard leaves such a browser open). */
export const holdsSignIns = (now = Date.now()) => Object.values(kept).some(k => k?.signedIn && now - Date.parse(k.at || 0) < 15 * 60e3)

export function startSessionKeeper(database) {
  db = database
  if (timer) return
  setTimeout(() => keepAlive().catch(() => {}), 60000)
  timer = setInterval(() => {
    keepAlive().catch(e => console.warn('[sessions]', e.message))
    insuranceMorning().catch(e => console.warn('[sessions] insurance morning:', e.message))
  }, EVERY_MS)
  timer.unref?.()
}

/** From this hour the insurance (FetaP) sign-in is done by itself, once a day. */
export const MORNING_HOUR = 7

/** Is the morning insurance sign-in due? (after MORNING_HOUR, not done today, not signed in already) */
export function insuranceMorningDue(now, lastDay, signedIn) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { due: now.getHours() >= MORNING_HOUR && lastDay !== day && !signedIn, day }
}

/**
 * The insurance sign-in in the morning, by itself (asked on 2026-11-19: FetaP
 * needs nobody — no "I am not a robot", no approval): the robots and the
 * certificate fetch then find it signed in. Once a day; a follower PC never.
 */
async function insuranceMorning() {
  if (!db) return
  const { isFollower } = await import('./mainPC.js')
  if (isFollower?.()) return
  const row = await db('settings').where('key', 'insurance_morning_signin').first().catch(() => null)
  const { due, day } = insuranceMorningDue(new Date(), row?.value, !!kept.insurance?.signedIn)
  if (!due) return
  if (!(await db('insurance_accounts').first().catch(() => null))) return
  if (row) await db('settings').where('key', 'insurance_morning_signin').update({ value: day })
  else await db('settings').insert({ key: 'insurance_morning_signin', value: day })
  console.log('[sessions] morning: signing in to the insurance (FetaP) by itself')
  await openSite('insurance', db)
}

/** Each site, for the "Morning sign-in" list. */
export async function sessionsNow() {
  // At once (asked on 2026-11-19): what is known now; the browser's tabs are
  // looked at behind it (the first time at most 1.5 s), the page asks again soon.
  const looking = keepAlive().catch(() => {})
  if (!Object.keys(kept).length) await Promise.race([looking, new Promise(r => setTimeout(r, 1500))])
  const { holderOf } = await import('./tasheerSession.js')
  const holder = db ? await holderOf(db).catch(() => null) : null
  // Insurance is not in the morning sign-in: its robot signs in by itself (FetaP's reCAPTCHA needs nobody).
  // Sites with several accounts: each account signed in or not, apart (each in its own browser space).
  const TABLES = { musaned: 'musaned_accounts', lmis: 'lmis_accounts', mofa: 'visa_accounts' }
  const out = []
  for (const s of SITES.filter(s => s.key !== 'insurance')) {
    const k = kept[s.key] || { tabs: 0, signedIn: false, spaces: {} }
    let accounts
    if (db && TABLES[s.key]) {
      const rows = await db(TABLES[s.key]).orderBy('is_default', 'desc').orderBy('id').select('id', 'name').catch(() => [])
      if (rows.length > 1) accounts = rows.map((a, i) => ({ id: a.id, name: a.name || `Account ${a.id}`, main: i === 0, signedIn: !!(k.spaces || {})[i === 0 ? '' : `${s.key}:${a.id}`] }))
    }
    const { spaces, ...rest } = k
    out.push({ key: s.key, name: s.name, ...rest, ...(accounts ? { accounts, signedIn: accounts.every(a => a.signedIn) } : {}), ...(s.key === 'tasheer' ? { holder, shared: true } : {}) })
  }
  return out
}

// The sign-in tabs shown in the live view ("site-musaned", "site-musaned-7").
const live = new Map()
/** The live view's tab of a Morning sign-in, or null. */
export function siteTab(name) {
  const p = live.get(String(name))
  return p && !p.isClosed?.() ? p : null
}

const spaceIs = (p, space) => { try { return p.browserContext() === space } catch { return false } }

/**
 * The tab this account already has on the site (its own browser space): the
 * signed-in one first, else one nobody works or types in. Never a tab a run
 * works in, nor one borrowed by a check.
 */
export async function siteTabOf(browser, site, space, running = new Set()) {
  const mine = space || browser.defaultBrowserContext?.() || null
  const pages = (await browser.pages().catch(() => [])).filter(p => !p.isClosed?.() && siteOf(p.url())?.key === site.key && (!mine || spaceIs(p, mine)))
  const free = []
  for (const p of pages) {
    if (p.__adalBorrowed || running.has(Number(p.__adalRunId))) continue
    if (await tabSignedIn(site, p)) return { page: p, signedIn: true }
    free.push(p)
  }
  for (const p of free) {
    const typed = await Promise.race([p.evaluate(() => [...document.querySelectorAll('input, textarea')].some(e => !['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue)).catch(() => true), new Promise(r => setTimeout(() => r(true), 5000))])
    if (!typed) return { page: p, signedIn: false }
  }
  return { page: null, signedIn: false }
}

/** Presses a sign-in form's own button (never a "Login" link elsewhere). */
const pressFormButton = (page) => page.evaluate(() => {
  const pw = document.querySelector('input[type="password"]')
  const form = pw?.closest('form') || document
  const b = [...form.querySelectorAll('button, input[type="submit"]')].filter(e => e.offsetParent !== null && !e.disabled)
    .find(e => e.type === 'submit' || /log ?in|sign ?in|submit|ግባ|دخول/i.test(e.innerText || e.value || ''))
  b?.click()
  return !!b
}).catch(() => false)

/** A site with an "I'm not a robot": Sign in is pressed as soon as the person ticks it. */
async function pressOnTick(page, site) {
  const { robotCheck, waitForTick } = await import('./robotCheck.js')
  await new Promise(r => setTimeout(r, 1500))
  if (!(await robotCheck(page)).present) return 'none'
  const w = await waitForTick(page, {
    onForm: () => page.evaluate(() => !!document.querySelector('input[type="password"]')),
    submit: () => pressFormButton(page),
    timeoutMs: 30 * 60000, log: (m) => console.log(`[sessions] ${site.name}:`, m),
  })
  console.log(`[sessions] ${site.name}: robot check ${w}`)
  return w
}

/**
 * Morning sign-in for one site and account (asked on 2026-11-19):
 *  - this account's tab already signed in → used, nothing opens, no new sign-in;
 *  - else its tab on the site (or a new one, out of sight, in the account's own
 *    browser space) is filled from the account vault and shown in the live
 *    view: the person only ticks "I'm not a robot" (Musaned), types a picture's
 *    numbers (Enjaz) or the SMS code (LMIS). Musaned's authenticator code is
 *    typed by Adal Keep. Each account's tab is labelled with its name.
 */
export async function openSite(key, database = null, { accountId = null, browser = null } = {}) {
  if (database) db = database
  // The account the person chose (Morning sign-in asks when there are several), else the default one.
  const accountOf = (table, cols) => {
    const q = db(table)
    return (accountId ? q.where('id', Number(accountId)) : q.orderBy('is_default', 'desc').orderBy('id')).first(...(cols ? [cols] : [])).catch(() => null)
  }
  const site = SITES.find(s => s.key === key)
  if (!site) throw new Error('Unknown site')
  // LMIS already open for this account on a Companion: its tab there is used (one LMIS per account, lmisOne.js).
  if (key === 'lmis' && db && !browser) {
    try {
      const home = await (await import('./lmisOne.js')).lmisHome(db, accountId)
      if (home?.device) browser = await (await import('./remoteBrowsers.js')).browserForDevice(home.device)
    } catch (e) { console.warn('[sessions] where LMIS is open:', e.message) }
  }
  browser = browser || await getBrowser()
  // The chosen account in its own browser space when it is not the site's main
  // one: signing in as it never signs the other account out (asked on 2026-11-15).
  let space = null
  if (db && accountId) {
    try {
      const { spaceForAccount } = await import('./tabManager.js')
      space = await spaceForAccount(db, browser, key, accountId)
    } catch (e) { console.warn('[sessions] no space of its own:', e.message) }
  }
  const { labelTab, accountLabel } = await import('./robotCheck.js')
  const label = db ? await accountLabel(db, key, accountId) : ''
  // (A run working, or one waiting on its page for a person's Save, keeps its tab.)
  const running = db ? await (await import('./tabManager.js')).keepingRunIds(db) : new Set()
  const found = await siteTabOf(browser, site, space, running)
  const liveKey = `site-${key}${accountId ? `-${Number(accountId)}` : ''}`
  if (found.signedIn) {
    // Musaned's main space can hold another account (a person signed in by hand): its menu says who.
    if (key === 'musaned' && label && !space) {
      const w = await import('./musanedWorkflow.js')
      const acct = await accountOf('musaned_accounts')
      const who = await w.signedInUser(found.page).catch(() => '')
      if (who && acct && !w.sameAccount(who, [acct.username, acct.name])) throw new Error(`This Musaned tab is signed in as ${who}, not ${acct.name || acct.username}. Log out there first.`)
      handTabToPerson(found.page)   // Adal Keep's own clicks on its menu are not a person's
    }
    await labelTab(found.page, label)
    live.set(liveKey, found.page)
    console.log(`[sessions] ${site.name}${label ? ` (${label})` : ''}: already signed in — that tab is used, no new sign-in`)
    keepAlive().catch(() => {})
    return { ok: true, already: true }
  }
  const { setupTab } = await import('./tabManager.js')
  const page = found.page || await newRunTab(browser, space)
  page.__adalAllowImages = true          // the robot check's pictures
  await setupTab(page, {}).catch(() => {})
  page.__adalBorrowed = true             // no run takes it while it signs in
  await labelTab(page, label)
  live.set(liveKey, page)
  // Signed in: the tab is free for the runs at once (the person's tick is not "someone working in it").
  const done = () => { page.__adalBorrowed = false; handTabToPerson(page); keepAlive().catch(() => {}) }
  console.log(`[sessions] ${site.name}${label ? ` (${label})` : ''}: signing in in ${found.page ? 'its tab on the site' : 'a new tab'} (live view ${liveKey})`)
  // Musaned: the vault's name and password, the person's tick, Sign in at once, the authenticator code.
  if (key === 'musaned' && db) {
    const acct = await accountOf('musaned_accounts', 'id')
    if (acct) {
      const { musanedSignIn } = await import('./transition.js')
      musanedSignIn(db, page, acct.id, (step) => console.log('[sessions] Musaned:', step), () => {})
        .catch(e => console.warn('[sessions] Musaned sign-in:', e.message)).finally(done)
      return { ok: true, auto: true, live: liveKey }
    }
  }
  // Enjaz (visa): its company sign-in, in English, the saved account filled — the person types the picture's numbers.
  if (key === 'mofa' && db) {
    const acct = await accountOf('visa_accounts')
    if (acct?.username && acct?.password) {
      const v = await import('./mofaVisa.js')
      const { toEnglish } = await import('./tabManager.js')
      ;(async () => {
        await page.goto(v.VISA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
        await new Promise(r => setTimeout(r, 2500))
        await toEnglish(page, {}).catch(() => {})
        for (let i = 0; i < 20; i++) {
          if (await v.fillVisaLogin(page, { visa_username: acct.username, visa_password: acct.password }).catch(() => 'no-form') === 'filled') break
          await new Promise(r => setTimeout(r, 1500))
        }
        console.log('[sessions] Enjaz: the sign-in is filled — the person types the numbers and presses Login')
        await pressOnTick(page, site)
      })().catch(e => console.warn('[sessions] Enjaz sign-in:', e.message)).finally(done)
      return { ok: true, auto: true, live: liveKey }
    }
  }
  // Insurance (FetaP): its own sign-in with the chosen account (already signed in: nothing to do).
  if (key === 'insurance' && db) {
    const acct = await accountOf('insurance_accounts')
    if (acct?.username && acct?.password) {
      const { insuranceSignIn } = await import('./insuranceCertificate.js')
      const ctx = { insurance_username: acct.username, insurance_password: acct.password, insurance_name: acct.name, profileName: 'Morning sign-in', onLog: (l, m) => console.log('[sessions] Insurance:', m), notify: async () => {} }
      insuranceSignIn(page, ctx).catch(e => console.warn('[sessions] Insurance sign-in:', e.message)).finally(done)
      return { ok: true, auto: true, live: liveKey }
    }
  }
  // LMIS: its own sign-in (the saved account, Sign In pressed) — the person types the SMS code (never stored).
  if (key === 'lmis' && db) {
    const acct = await accountOf('lmis_accounts')
    if (acct && (acct.login_value || acct.phone) && acct.password) {
      const { stepLogin } = await import('./lmisWorkflow.js')
      const ctx = {
        login_value: acct.login_value || acct.phone, login_password: acct.password, account_name: acct.name, account_id: acct.id,
        profileName: 'Morning sign-in', onLog: (level, msg) => console.log('[sessions] LMIS:', msg), notify: async () => {},
      }
      // Straight to its sign-in page (its home page is public and only looks signed in).
      await page.goto('https://lmis.gov.et/auth', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
      // (LMIS has no robot check: its SMS code is the person's.)
      stepLogin(page, ctx).catch(e => console.warn('[sessions] LMIS sign-in:', e.message)).finally(done)
      return { ok: true, auto: true, live: liveKey }
    }
  }
  page.__adalBorrowed = false
  await page.goto(site.start, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  return { ok: true, live: liveKey }
}
