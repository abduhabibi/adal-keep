/**
 * crashedTab.js — a robot tab whose page process crashed ("Page crashed!", 2026-11-26: measured about 1 in 10 when a
 * waiting sign-in page was set to rest behind another tab) counts as closed: puppeteer can use it no more (its frame
 * is detached, even a reload fails), so the run goes back in line (nothing was sent) and opens a fresh tab, as for a
 * lost tab. Before, the run waited 10 minutes on a dead page. Off: ADAL_CRASHED_TAB=0.
 */
export const crashedOn = (env = process.env) => env.ADAL_CRASHED_TAB !== '0'
/** Marks the page when its process goes (once per page). */
export function watchCrash(page, log = console.warn) {
  try {
    if (!crashedOn() || page.__adalCrashWatch) return
    page.__adalCrashWatch = true
    page.on('error', (e) => {
      if (!/crash/i.test(String(e?.message))) return
      page.__adalCrashed = Date.now()
      page.__adalClosedBy = page.__adalClosedBy || 'the crash watch (its page crashed)'
      setTimeout(() => { page.close().catch(() => {}) }, 1500).unref?.()   // (nobody can use it: gone from the strip too)
      log(`[tabManager] run #${page.__adalRunId ?? '-'}: its page crashed (${String(page.url()).slice(0, 60)}) — it counts as closed, a fresh tab opens`)
    })
  } catch {}
}
export const crashed = (page) => !!(page && page.__adalCrashed && crashedOn())
