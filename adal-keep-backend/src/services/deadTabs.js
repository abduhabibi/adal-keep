/**
 * deadTabs.js — a robot tab that answers nothing any more is found within 20 s and opened fresh by itself.
 *
 * 2026-11-25, an agency's main PC: the Musaned sign-in tab stopped answering at 13:26 and never did again: no click,
 * no picture; its process alive, 0 % processor, only its address and its closing still worked. The same, call by
 * call, comes from a page that waits for a synchronous request whose answer never arrives (measured; the office
 * line loses connections in bursts): its scripts, screenshots, the debugger — nothing gets through, only the browser's
 * own part answers. Nothing but closing the tab ends it.
 *
 * Every 8 s each robot tab is asked one thing ("1"), 5 s at most, once more before it counts as dead; the browser
 * itself must have answered meanwhile, and a page working hard (a process of the browser using the processor) or a PC
 * that is full gets more time. A tab with a person's form (waiting for Save, or typed in) is never closed: it is
 * said. A sign-in page is nobody's form. Closed → its run goes back in line at its step (a sign-in that waits) or ends.
 * ADAL_DEAD_TABS=0 turns it off; any error: nothing is done.
 */
import os from 'os'
import { openBrowserIfAny } from './browser.js'
import { tabOfRun, runsWithTabs, closeTarget } from './tabManager.js'

export const LOOK_MS = 8000, ASK_MS = 5000
const SIGN_IN = /(^|\.)wahid\.sa\/|\/(login|auth|signin|sign-in|account\/login)\b|openid-connect/i
export const isSignInPage = (url) => { try { const u = new URL(url); return SIGN_IN.test(u.hostname + u.pathname) } catch { return false } }
export const counts = { looks: 0, dead: 0, closed: 0, kept: 0 }
const within = (p, ms, v = null) => { let t; return Promise.race([Promise.resolve(p).catch(() => v), new Promise(r => { t = setTimeout(() => r(v), ms) })]).finally(() => clearTimeout(t)) }
const pcTimes = () => os.cpus().reduce((a, c) => { const v = Object.values(c.times); a.all += v.reduce((x, y) => x + y, 0); a.idle += c.times.idle; return a }, { all: 0, idle: 0 })

const session = (page) => { try { return page.__adalCdp || page._client?.() || page.mainFrame().client } catch { return null } }
/** Asked past puppeteer's own waiting (it waits for a page that is loading): the page as it is now. */
async function answers(page, ms) {
  const s = session(page)
  if (!s) return true                                  // it cannot be asked: not ours to judge
  let gone = false
  const ok = await within(s.send('Runtime.evaluate', { expression: '1', returnByValue: true }).then(() => true, () => { gone = true; return true }), ms, false)
  return ok || gone
}

/**
 * What to do with a tab that answered nothing for long. Pure.
 * Never closed (2026-11-26, Main at 89 %: the Musaned sign-in closed while the owner ticked "I'm not a robot" and they
 * had to tick again): a page a person may be on — watched in the live view in the last 2 minutes, a person's step a
 * run waits for (the tick, a code), a run's sign-in page, a check's page, a form waiting for Save or typed in.
 * Such a page is only said ("does not answer"). A sign-in page nobody waits on is closed.
 */
export function decide({ row, url, touched, looked = 0, personWait = false, borrowed = false, now = Date.now() }) {
  if (row?.status === 'paused' && /^awaiting-.*save/.test(row.pause_reason || '')) return 'keep'
  if (personWait || borrowed || now - (looked || 0) < 2 * 60e3) return 'keep'
  if (isSignInPage(url)) return 'close'   // (nobody waits on it now, nobody looked: a hung one is opened fresh)
  return now - (touched || 0) < 30 * 60e3 ? 'keep' : 'close'
}

/** How long a tab must have answered nothing before it counts as dead: longer on a busy PC (load 0..1). */
export const silentFor = (load) => process.env.ADAL_DEAD_MS != null ? Number(process.env.ADAL_DEAD_MS) || 0 : (load > 0.8 ? 120e3 : load > 0.5 ? 60e3 : 30e3)
let pcBefore = pcTimes(), pcLoad = 0
const pcLoadNow = () => { const n = pcTimes(); if (n.all > pcBefore.all) pcLoad = 1 - (n.idle - pcBefore.idle) / (n.all - pcBefore.all); pcBefore = n; return pcLoad }

const told = new WeakSet()
let cdp = null, cdpOf = null
/** One look at the robot browser's tabs. → [{ act, url, run }] */
export async function lookDead(browser, db, { askMs = ASK_MS, onClosed = null } = {}) {
  const done = []
  counts.looks++
  if (cdpOf !== browser) { cdpOf = browser; cdp = await within(browser.target().createCDPSession(), 3000) }
  if (!cdp) { cdpOf = null; return done }
  const owner = new Map(runsWithTabs().map(id => [tabOfRun(id), Number(id)]))
  const pages = []
  for (const t of browser.targets().filter(t => t.type() === 'page')) { const p = await within(t.page(), 1500); if (p && !p.isClosed?.() && (owner.has(p) || p.__adalCdp) && p.__adalClosing !== true) pages.push(p) }
  const asked = await Promise.all(pages.map(async p => [p, await answers(p, askMs)]))
  for (const [p, ok] of asked) if (ok) p.__adalSilentSince = 0
  const load = pcLoadNow()
  // Silent for long enough (one miss of 10 s is no reason: a busy PC, a page loading Google's box).
  const silent = asked.filter(x => !x[1]).map(x => x[0]).filter(p => { p.__adalSilentSince = p.__adalSilentSince || Date.now(); return Date.now() - p.__adalSilentSince >= silentFor(load) })
  for (const p of silent) {
    const busy = async () => new Map(((await within(cdp.send('SystemInfo.getProcessInfo'), 2000))?.processInfo || []).filter(x => x.type === 'renderer').map(x => [x.id, x.cpuTime]))
    let dead = true
    // Asked again; a page at work (45 s) or a PC that is full (15 s) is asked longer before it counts.
    for (const from = Date.now(); ;) {
      const a = await busy(), pc = pcTimes(), t0 = Date.now()
      if (!a.size) { dead = false; break }             // the browser itself does not answer: not the tab
      if (await answers(p, askMs)) { dead = false; break }
      const b = await busy(), pc2 = pcTimes(), s = (Date.now() - t0) / 1000
      // (Chrome does not say which process is this tab's: a page process at work counts for all.)
      const hot = [...b].some(([id, c]) => (c - (a.get(id) ?? c)) / s > 0.3)
      const full = pc2.all > pc.all && 1 - (pc2.idle - pc.idle) / (pc2.all - pc.all) > 0.8
      if (!(hot && Date.now() - from < 45000) && !(full && Date.now() - from < 15000)) break
    }
    if (!dead || p.isClosed?.()) continue
    counts.dead++
    const run = owner.get(p) ?? null, url = p.url()
    const row = run && db ? await db('automation_queue').where('id', run).first('id', 'status', 'pause_reason').catch(() => null) : null
    const how = decide({ row, url, touched: p.__adalInputAt, looked: p.__adalLookedAt, personWait: !!p.__adalPersonWait, borrowed: !!(p.__adalBorrowed || p.__adalPerson || p.__adalGiveWay) })
    if (how === 'keep') {
      if (told.has(p)) continue
      told.add(p); counts.kept++
      p.__adalDead = 'This page does not answer just now. A person may be on it, so it is left as it is.'
      console.warn(`[dead] "${url.slice(0, 80)}"${run ? ` (run #${run})` : ''} answers nothing; a person may be on it (sign-in, tick, code, a form, the live view, a check) — left as it is`)
      done.push({ act: 'keep', url, run })
      continue
    }
    p.__adalDead = 'The page did not answer any more — a fresh one is opening…'
    p.__adalClosing = true
    const ok = await closeTarget(p)
    if (!ok) p.__adalClosing = false
    else counts.closed++
    console.warn(`[dead] "${url.slice(0, 80)}"${run ? ` (run #${run})` : ''} answered nothing for ${Math.round((Date.now() - p.__adalSilentSince) / 1000)} s (PC ${Math.round(load * 100)} % busy) — ${ok ? 'closed, a fresh one opens' : 'it could not be closed'}`)
    if (ok) { done.push({ act: 'close', url, run }); try { await onClosed?.({ url, run, row }) } catch (e) { console.warn('[dead]', e.message) } }
  }
  return done
}

let timer = null
export function startDeadTabs(db, { afterClose = null } = {}) {
  if (timer || process.env.ADAL_DEAD_TABS === '0' || process.env.NODE_TEST_CONTEXT) return
  let busy = false
  timer = setInterval(async () => {
    if (busy) return
    busy = true
    try { const b = await openBrowserIfAny(); if (b) await lookDead(b, db, { onClosed: afterClose }) } catch (e) { console.warn('[dead]', e.message) } finally { busy = false }
  }, LOOK_MS)
  timer.unref?.()
}
