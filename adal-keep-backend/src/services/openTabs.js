/**
 * openTabs.js — the robot browser's own tabs for the live view's tab strip: a site's tab no run works in (kept signed
 * in, Wafid ready, a sign-in). Only tabs on the robots' sites, out of sight. Key: "tab-<target id>".
 */
import { openBrowserIfAny, outOfSight } from './browser.js'
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
  for (const p of await pagesOf(b, 1500)) {
    const site = siteOfUrl(p.url())
    if (site && !owned.has(p) && runs.length && runs.includes(await runName(p))) continue     // a run's (listed as the run)
    if (!site || owned.has(p) || p.isClosed?.() || !idOf(p)) continue
    out.push({ key: `tab-${idOf(p)}`, run_id: null, site, girl: '', account: p.__adalLabel || '', status: p.__adalBorrowed ? 'Working' : 'Open', needs_you: false, idle: true })
  }
  return out
}

/** The page of "tab-<id>", only while it is one of those. */
export async function pageOfTab(key, browser = null) {
  const id = String(key).replace(/^tab-/, '')
  const b = browser || await openBrowserIfAny().catch(() => null)
  if (!b || !/^[0-9A-F]{8,64}$/i.test(id)) return null
  const p = (await pagesOf(b, 1500)).find(x => idOf(x) === id)
  if (!p || p.isClosed?.() || !siteOfUrl(p.url())) return null
  return (await outOfSight(p).catch(() => false)) ? p : null
}
