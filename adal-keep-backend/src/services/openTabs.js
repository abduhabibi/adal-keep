/**
 * openTabs.js — the robot browser's own tabs for the live view's tab strip: a site's tab no run works in (kept signed
 * in, Wafid ready, a sign-in). Only tabs on the robots' sites, out of sight. Key: "tab-<target id>".
 */
import { openBrowserIfAny, outOfSight } from './browser.js'
import { tabRank } from './bestTab.js'
import { runsWithTabs, tabOfRun, pagesOf } from './tabManager.js'

const NAMES = [[/(^|\.)(musaned\.com\.sa|wahid\.sa)$/i, 'Musaned'], [/(^|\.)wafid\.com$/i, 'Wafid'], [/(^|\.)tasheer\.com$/i, 'Tasheer'], [/(^|\.)visa\.mofa\.gov\.sa$/i, 'Enjaz'], [/(^|\.)niscofetap\.com$/i, 'Insurance'], [/(^|\.)lmis\.gov\.et$/i, 'LMIS']]
export const siteOfUrl = (url) => { try { const h = new URL(url).hostname; return NAMES.find(([re]) => re.test(h))?.[1] || '' } catch { return '' } }
const idOf = (p) => { try { return p.target()._targetId } catch { return '' } }

/** The run whose name the tab carries, or 0 (asked 0.6 s at most; a busy one is listed). */
const runName = (p) => { let t; return Promise.race([p.evaluate(() => window.name).then(n => Number(/^adal-run-(\d+)$/.exec(n)?.[1]) || 0, () => 0), new Promise(r => { t = setTimeout(() => r(0), 600) })]).finally(() => clearTimeout(t)) }

export async function openTabs(browser = null, runs = []) {
  const b = browser || await openBrowserIfAny().catch(() => null)
  if (!b) return []
  const owned = new Set(runsWithTabs().map(id => tabOfRun(id)))
  const out = []
  const spaceOf = (p) => { try { return p.browserContext() } catch { return null } }
  const at = new Map()          // site → space → what the strip has of it: one tab a site and account
  const have = (site, p) => { if (!at.has(site)) at.set(site, new Map()); return at.get(site).get(spaceOf(p)) }
  const put = (site, p, what) => { have(site, p); at.get(site).set(spaceOf(p), what) }
  for (const p of owned) if (p && !p.isClosed?.()) put(siteOfUrl(p.url()), p, 'run')
  for (const p of await pagesOf(b, 1500)) {
    const site = siteOfUrl(p.url())
    if (site && !owned.has(p) && runs.length && runs.includes(await runName(p))) { put(site, p, 'run'); continue }     // a run's (listed as the run)
    if (!site || owned.has(p) || p.isClosed?.() || !idOf(p)) continue
    const row = { key: `tab-${idOf(p)}`, run_id: null, site, girl: '', account: p.__adalLabel || '', status: p.__adalBorrowed ? 'Working' : 'Open', needs_you: false, idle: true, rank: tabRank(p.url()) }
    const there = have(site, p)
    if (there === 'run') continue
    if (there) { if (row.rank > there.rank) Object.assign(there, row); continue }
    put(site, p, row); out.push(row)
  }
  // (A run's tab found after an idle one of the same site: the run's counts.)
  return out.filter(r => ![...at.get(r.site)?.values() || []].includes('run') || [...at.get(r.site).values()].includes(r)).map(({ rank, ...r }) => r)
}

const found = new Map()              // tab key → its page (a busy PC takes seconds to find it again)
const missed = new Map()             // tab key → since when it is not there
const targetOf = (b, id) => b?.targets().find(t => { try { return t.type() === 'page' && t._targetId === id } catch { return false } }) || null

/** The page of "tab-<id>", only while it is one of those (a slow one: null now, asked again). */
export async function pageOfTab(key, browser = null) {
  const id = String(key).replace(/^tab-/, '')
  if (!/^[0-9A-F]{8,64}$/i.test(id)) return null
  const b = browser || await openBrowserIfAny().catch(() => null)
  let p = found.get(id)
  if (!p || p.isClosed?.() || p.browser?.()?.connected === false || (b && p.browser?.() !== b && p.browser)) {
    found.delete(id)
    const t = targetOf(b, id)
    if (!t) return null
    p = await Promise.race([t.page().catch(() => null), new Promise(r => setTimeout(() => r(null), 5000))])
    if (!p) return null
    found.set(id, p)
    if (found.size > 20) found.delete(found.keys().next().value)
  }
  if (p.isClosed?.() || !siteOfUrl(p.url())) return null
  return (await outOfSight(p).catch(() => false)) ? p : null
}

/** Is that tab really gone? Not for a slow answer: the browser is there and the tab is not (4 s), or no browser (20 s). */
export async function tabGone(key, browser = null, now = Date.now()) {
  const id = String(key).replace(/^tab-/, '')
  const b = browser || await Promise.race([openBrowserIfAny().catch(() => null), new Promise(r => setTimeout(() => r(undefined), 3000))])
  const t = targetOf(b, id)
  if (t && siteOfUrl(t.url())) { missed.delete(id); return false }
  if (!missed.has(id)) missed.set(id, now)
  if (missed.size > 50) missed.delete(missed.keys().next().value)
  return now - missed.get(id) >= (b ? 4000 : 20000)
}
