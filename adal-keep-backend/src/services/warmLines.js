/**
 * warmLines.js — the connection to a site a tab is signed in to stays open (its name found, its line made), so the
 * next page does not begin with a new connection the office line may lose (2026-11-25). Every 75 s one small question
 * (HEAD /favicon.ico) from each such tab, out of sight; never in a tab a run works in, nothing is loaded.
 * ADAL_WARM_LINES=0 turns it off.
 */
import { openBrowserIfAny } from './browser.js'
import { activeRunIds } from './tabManager.js'
import { SITES } from './sessionKeeper.js'
const EVERY_MS = 75000
const within = (p, ms) => { let t; return Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => { t = setTimeout(() => r(null), ms) })]).finally(() => clearTimeout(t)) }

export async function warmOnce(browser, running = new Set()) {
  const seen = new Set()
  let n = 0
  for (const p of await within(browser.pages(), 5000) || []) {
    let u
    try { if (p.isClosed?.()) continue; u = new URL(p.url()) } catch { continue }
    if (!SITES.some(s => s.host.test(u.hostname)) || seen.has(u.origin) || running.has(Number(p.__adalRunId))) continue
    seen.add(u.origin)
    if (await within(p.evaluate(() => fetch('/favicon.ico', { method: 'HEAD', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) }).then(() => true, () => false)), 9000)) n++
  }
  return n
}

let timer = null
export function startWarmLines(db) {
  if (timer || process.env.ADAL_WARM_LINES === '0') return
  let busy = false
  timer = setInterval(async () => {
    if (busy) return
    busy = true
    try { const b = await openBrowserIfAny(); if (b) await warmOnce(b, await activeRunIds(db)) } catch {} finally { busy = false }
  }, EVERY_MS)
  timer.unref?.()
}
