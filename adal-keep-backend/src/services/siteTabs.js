/**
 * siteTabs.js — five standing tabs (the owner, 2026-11-27): when Adal Robots starts, its browser opens one tab each
 * for Musaned, Wafid, Enjaz, Tasheer and LMIS, when none is open there, out of sight ("Watch robots" shows them).
 * A person signs in once a site; the robot never types a password or a code and never ticks a captcha. The tab then
 * stands by, kept signed in by the session keeper (sessionKeeper.js), and a task for that site takes it at once
 * (tabManager.findFreeTab: the site's free tab, never a second one). A site that signed out stays as it is,
 * "sign in needed" on the Robots page: nothing is tried again by itself (no reload, no sign-in). Insurance: on demand,
 * as before. Looked at once at the start and every 2 minutes (only a missing tab is opened, never one loaded again).
 * Off: ADAL_SITE_TABS=0. Never throws.
 */
import { SITES, WAFID_STANDBY } from './sessionKeeper.js'

export const siteTabsOn = (env = process.env) => env.ADAL_SITE_TABS !== '0'
const EVERY_MS = 2 * 60e3

const site = (key) => SITES.find(s => s.key === key)
/** The five, in the Robots page's order. signedIn(url): true / false; Wafid has no sign-in. */
export const STANDING = [
  { key: 'musaned', name: 'Musaned', start: site('musaned').start, host: /(^|\.)(musaned\.com\.sa|wahid\.sa)$/i, out: site('musaned').out },
  { key: 'wafid', name: 'Wafid', start: WAFID_STANDBY, host: /(^|\.)wafid\.com$/i, out: null },
  { key: 'mofa', name: 'Enjaz', start: site('mofa').start, host: site('mofa').host, out: site('mofa').out },
  { key: 'tasheer', name: 'Tasheer', start: site('tasheer').start, host: site('tasheer').host, out: site('tasheer').out },
  { key: 'lmis', name: 'LMIS', start: site('lmis').start, host: site('lmis').host, out: site('lmis').out },
]
const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }
const onSite = (s, url) => s.host.test(hostOf(url))
export function signedInOn(s, url) {
  if (!onSite(s, url)) return false
  if (!s.out) return true
  try { const u = new URL(url); return !s.out.test(u.pathname + ' ' + u.hostname) } catch { return false }
}

/** What a site's tab is now. Pure. tab: { url, working } | null → 'no-tab' | 'working' | 'standby' | 'sign-in-needed'. */
export function tabState(s, tab) {
  if (!tab) return 'no-tab'
  if (tab.working) return 'working'
  return signedInOn(s, tab.url) ? 'standby' : 'sign-in-needed'
}

const pagesNow = async (browser) => {
  try {
    const { pagesOf } = await import('./tabManager.js')
    const { spaceOf } = await import('./browser.js')
    return (await pagesOf(browser, 1500)).filter(p => !p.isClosed?.() && !spaceOf(p))   // the main account's space
  } catch { return [] }
}

/** Opens the tab of each site that has none. → the keys opened. */
export async function ensureSiteTabs(browser, { log = (m) => console.log('[site-tabs] ' + m), sites = STANDING } = {}) {
  if (!siteTabsOn() || !browser) return []
  const opened = []
  try {
    const { newRunTab } = await import('./browser.js')
    const { setupTab } = await import('./tabManager.js')
    for (const s of sites) {
      const pages = await pagesNow(browser)
      if (pages.some(p => { try { return onSite(s, p.url()) } catch { return false } })) continue
      const p = await newRunTab(browser, null, { quiet: true })
      await setupTab(p).catch(() => {})
      p.__adalStanding = s.key
      if (s.key === 'wafid') p.__adalStandbyAt = Date.now()
      await p.goto(s.start, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log(`${s.name}: its page did not load (${e.message}) — the tab stays, a person can sign in there`))
      opened.push(s.key)
      log(`${s.name}: a standing tab opened (out of sight)`)
    }
  } catch (e) { log(`not opened: ${e.message}`) }
  return opened
}

/** Each site's tab now, for the Robots page. → [{ key, name, state, path }] */
export async function siteTabsNow({ browser = null, running = new Set() } = {}) {
  if (!browser) { try { browser = await (await import('./browser.js')).openBrowserIfAny() } catch { browser = null } }
  const pages = browser ? await pagesNow(browser) : []
  let isRunTab = () => false
  try { isRunTab = (await import('./tabManager.js')).isRunTab } catch {}
  return STANDING.map(s => {
    const mine = pages.filter(p => { try { return onSite(s, p.url()) } catch { return false } })
    const working = mine.find(p => isRunTab(p) || p.__adalBorrowed || running.has(Number(p.__adalRunId)))
    const p = working || mine.find(x => signedInOn(s, x.url())) || mine[0] || null
    let path = ''
    try { if (p) { const u = new URL(p.url()); path = u.hostname + u.pathname } } catch {}
    return { key: s.key, name: s.name, state: tabState(s, p ? { url: p.url(), working: !!working } : null), path, tabs: mine.length }
  })
}

let timer = null
/** At the start (20 s, the browser up) and every 2 minutes; never while a run has the internet (runFocus.js). */
export function startSiteTabs() {
  if (!siteTabsOn() || timer) return
  const round = async () => {
    try { if ((await import('./runFocus.js')).held('the standing site tabs')) return } catch {}
    try { await ensureSiteTabs(await (await import('./browser.js')).getBrowser()) } catch (e) { console.warn('[site-tabs]', e.message) }
  }
  setTimeout(round, 20000).unref?.()
  timer = setInterval(round, EVERY_MS)
  timer.unref?.()
  console.log('[site-tabs] Musaned, Wafid, Enjaz, Tasheer and LMIS: one standing tab each (off: ADAL_SITE_TABS=0)')
}

// ── Short of memory (2026-11-27, Main: 427 MB free of 7.3 GB) ───────────────────────────────────────────────────
// The browser that holds the standing tabs is never quit for memory: blank and error tabs and a site's second tab that
// is not signed in close (never a run's, a borrowed one, one on the screen, or one a person touched in 10 minutes),
// and every tab drops its caches and its unused JavaScript memory. Off: ADAL_MEMORY_SHRINK=0 (quit as before).
export const shrinkOn = (env = process.env) => siteTabsOn(env) && env.ADAL_MEMORY_SHRINK !== '0'
export const CRITICAL_FREE_MB = () => Number(process.env.ADAL_CRITICAL_FREE_MB) || 250
const PERSON_MS = 10 * 60e3

/** Which tabs may close. Pure. tabs: [{ url, run, borrowed, shown, touched }] → indexes. */
export function spareForMemory(tabs, now = Date.now()) {
  const go = [], keptSite = new Set()
  const free = (t) => !t.run && !t.borrowed && !t.shown && now - (t.touched || 0) >= PERSON_MS
  // First the signed-in one of each site is kept, then the first other one.
  const order = tabs.map((t, i) => ({ t, i, s: STANDING.find(s => onSite(s, t.url)) })).sort((a, b) => (b.s && signedInOn(b.s, b.t.url)) - (a.s && signedInOn(a.s, a.t.url)))
  for (const { t, i, s } of order) {
    if (!free(t)) { if (s) keptSite.add(s.key); continue }
    if (/^(about:blank|chrome-error:|chrome:\/\/newtab)/i.test(t.url || 'about:blank')) { go.push(i); continue }
    if (!s) continue
    if (keptSite.has(s.key) && !signedInOn(s, t.url)) { go.push(i); continue }
    keptSite.add(s.key)
  }
  return go.sort((a, b) => a - b)
}

export async function shrinkBrowser(browser) {
  let closed = 0, pages = 0
  try {
    const { pagesOf, isRunTab } = await import('./tabManager.js')
    const all = (await pagesOf(browser, 1500)).filter(p => !p.isClosed?.())
    const look = await Promise.all(all.map(async p => ({
      url: p.url(), run: isRunTab(p) || p.__adalRunId !== undefined, borrowed: !!p.__adalBorrowed || !!p.__adalPerson, shown: !!p.__adalShown,
      touched: Number(await Promise.race([p.evaluate(() => sessionStorage.getItem('adal-touched')).catch(() => 0), new Promise(r => setTimeout(() => r(Date.now()), 2000))])) || 0,
    })))
    const go = new Set(spareForMemory(look))
    // (The browser keeps one tab at least.)
    for (const i of go) { if (all.length - closed <= 1) break; all[i].__adalClosedBy = 'the memory guard (a spare tab)'; await all[i].close().catch(() => {}); closed++ }
    for (const [i, p] of all.entries()) {
      if (go.has(i)) continue
      try {
        const c = await p.target().createCDPSession()
        await c.send('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {})
        await c.send('HeapProfiler.collectGarbage').catch(() => {})
        await c.detach().catch(() => {})
        pages++
      } catch {}
    }
  } catch {}
  return { closed, pages }
}
