/**
 * spareBlanks.js — no empty tab stays open beside a working one in the robot browser (each is a process of its own,
 * 20–40 MB): "New Tab" and about:blank nobody uses for a minute are closed, out of sight only. Never the last tab,
 * never the runs' own anchor tab (browser.js), a run's, a person's or one in a window on the screen.
 * Looked at with robotGuard's look. ADAL_SPARE_BLANKS=0 turns it off.
 */
export const BLANK = /^(about:blank|chrome:\/\/new-?tab(-page)?\/?.*|chrome:\/\/newtab\/?)$/i
const within = (p, ms, v = null) => { let t; return Promise.race([Promise.resolve(p).catch(() => v), new Promise(r => { t = setTimeout(() => r(v), ms) })]).finally(() => clearTimeout(t)) }
const first = new WeakMap()

/** Which of these tabs go: [{ blank, used, anchor, ms }] → the same objects. Pure. */
export function spares(tabs, afterMs = 60000) {
  if (!tabs.some(t => !t.blank)) return []            // only empty tabs: the idle look quits the browser (sessionKeeper)
  return tabs.filter(t => t.blank && !t.used && !t.anchor && t.ms >= afterMs)
}

export async function closeSpareBlanks(browser, { now = Date.now(), afterMs = 60000, hidden = null } = {}) {
  if (process.env.ADAL_SPARE_BLANKS === '0') return 0
  const { outOfSight } = await import('./browser.js')
  const { tabOfRun, runsWithTabs } = await import('./tabManager.js')
  const owned = new Set(runsWithTabs().map(id => tabOfRun(id)))
  const tabs = []
  for (const page of await within(browser.pages(), 5000, [])) {
    let url = ''
    try { if (page.isClosed?.()) continue; url = page.url() } catch { continue }
    const blank = BLANK.test(url)
    if (blank && !first.has(page)) first.set(page, now)
    if (!blank) first.delete(page)
    tabs.push({ page, blank, ms: blank ? now - first.get(page) : 0,
      used: owned.has(page) || !!(page.__adalBorrowed || page.__adalPerson || page.__adalShown || page.__adalRunId !== undefined || page.__adalSetup) })
  }
  let n = 0
  for (const t of spares(tabs, afterMs)) {
    const name = await within(t.page.evaluate(() => window.name), 2000, null)
    if (name === null || name) continue                // the anchor, a run's, or it cannot be asked
    if (!(await within((hidden || outOfSight)(t.page), 3000, false))) continue
    if (await within(t.page.close().then(() => true), 4000, false)) n++
  }
  if (n) console.log(`[guard] ${n} empty tab${n === 1 ? '' : 's'} nobody used closed`)
  return n
}
