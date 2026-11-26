/**
 * spareTabs.js — one Musaned tab, also when an earlier start of the robots left more (2026-11-25, Main: three HR Pool
 * tabs and a sign-in page: after a restart the passport a robot typed in the list's search box read as "a person's").
 * Every 2 min, only when there are two or more of one account and no run works: the others close, and only while one
 * that stays is certainly signed in. Never: a run's (waiting, in line), a borrowed one, one in sight, one a person
 * clicked in or looked at in the last 10 min, a form (anything typed, but the HR Pool list's search box), a tab that is
 * not the robots'. ADAL_SPARE_TABS=0 turns it off; any error: nothing is closed.
 */
import { openBrowserIfAny, outOfSight } from './browser.js'
import { activeRunIds, pagesOf, isRunTab, keepBrowserOpen } from './tabManager.js'
import { lookNow, sure } from './instantScreen.js'
const within = (p, ms, v = null) => { let t; return Promise.race([Promise.resolve(p).catch(() => v), new Promise(r => { t = setTimeout(() => r(v), ms) })]).finally(() => clearTimeout(t)) }
const ON = /(^|\.)(musaned\.com\.sa|wahid\.sa)$/i
const PERSON_MS = 10 * 60e3
const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }

const LOOK = () => ({
  name: window.name, touched: Number(sessionStorage.getItem('adal-touched')) || 0,
  typed: [...document.querySelectorAll('input, textarea')].filter(e => !['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue).length,
  ticked: [...document.querySelectorAll('textarea[name="g-recaptcha-response"]')].some(t => (t.value || '').length > 20),
  signIn: !!document.querySelector('input[type="password"]'),
})
/** May this tab close? Pure. */
export function spare({ url, look, live = new Set(), now = Date.now(), seenAt = 0, ours = false }) {
  if (!look) return false
  const run = /^adal-run-(\d+)$/.exec(look.name || '')?.[1]
  if (run && live.has(Number(run))) return false
  if (!ours && !run) return false
  if (now - Math.max(look.touched, seenAt) < PERSON_MS || look.ticked) return false
  if (look.signIn) return true                                    // a sign-in page is nobody's form
  let path = ''
  try { path = new URL(url).pathname } catch { return false }
  return look.typed === 0 || (look.typed === 1 && /^\/hr-pool\/?$/.test(path))
}

export async function closeSpare(browser, { live, seenOf = (p) => Math.max(p.__adalLookedAt || 0, p.__adalInputAt || 0) } = {}) {
  const groups = new Map()
  for (const p of await pagesOf(browser, 1500)) {
    if (p.isClosed?.() || !ON.test(hostOf(p.url()))) continue
    let c = null
    try { c = p.browserContext() } catch {}
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c).push(p)
  }
  let closed = 0
  for (const tabs of groups.values()) {
    if (tabs.length < 2) continue
    const got = await Promise.all(tabs.map(async p => ({ p, look: await within(p.evaluate(LOOK), 2500), screen: sure(await lookNow(p)) })))
    const may = []
    for (const g of got) if (!g.p.__adalBorrowed && !g.p.__adalPerson && !isRunTab(g.p) && spare({ url: g.p.url(), look: g.look, live, seenAt: seenOf(g.p), ours: !!g.p.__adalCdp }) && await within(outOfSight(g.p), 2000, false)) may.push(g)
    // The one that stays must be signed in: one that may not close anyway, else the first that may.
    const stays = got.find(g => g.screen === 'dashboard' && !may.includes(g)) || got.find(g => g.screen === 'dashboard')
    if (!stays) continue
    for (const g of may) {
      if (g === stays || g.p.isClosed?.()) continue
      await keepBrowserOpen(g.p)
      g.p.__adalClosedBy = g.p.__adalClosedBy || 'spare tabs (a second Musaned tab)'
      if (await within(g.p.close().then(() => true), 4000, false)) closed++
    }
  }
  if (closed) console.log(`[tabs] ${closed} spare Musaned tab(s) closed — one stays, signed in`)
  return closed
}

let timer = null
export function startSpareTabs(db) {
  if (timer || process.env.ADAL_SPARE_TABS === '0') return
  let busy = false
  timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const b = await openBrowserIfAny()
      // (Addresses only: nothing is asked of a page unless there are two.)
      if (b && b.targets().filter(t => t.type() === 'page' && ON.test(hostOf(t.url()))).length > 1
        && !(await db('automation_queue').where('status', 'running').first('id'))) await closeSpare(b, { live: await activeRunIds(db) })
    } catch (e) { console.warn('[tabs]', e.message) } finally { busy = false }
  }, 120000)
  timer.unref?.()
}
