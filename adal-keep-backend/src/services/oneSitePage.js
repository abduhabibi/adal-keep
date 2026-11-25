/**
 * oneSitePage.js — one page for Musaned (the owner, 2026-11-25). The check for newly chosen girls had the open Musaned
 * page, so a run opened a second one with the sign-in copied into it, and Musaned signed out. Now a run asks the check
 * to stop (it goes on at its next time) and takes that page. A sign-out the site asks for by itself leaves the page as
 * it is (answered "nothing to show"), not Chrome's error page. Off: ADAL_ONE_PAGE=0. Never throws.
 */
export const onePageOn = (env = process.env) => env.ADAL_ONE_PAGE !== '0'
const wait = (ms) => new Promise(r => setTimeout(r, ms))

/** Before a Musaned run takes its tab. → the ms it waited for the check to let go (0: no check had the page). */
export async function pageForRun(workflowId, { check = null, cancel = null, limitMs = 20000, log = () => {} } = {}) {
  try {
    if (!onePageOn() || !/^musaned/i.test(String(workflowId))) return 0
    if (!check) { const m = await import('./musanedContracts.js'); check = m.contractCheck; cancel = m.cancelCheck }
    if (!check.running) return 0
    const t0 = Date.now()
    log('The check for newly chosen girls had the Musaned page: it stops and this run takes the page')
    cancel('A robot run needs the Musaned page — the check goes on at its next time')
    while (check.running && Date.now() - t0 < limitMs) await wait(200)
    if (check.running) log('The check did not let go of the Musaned page in time', 'warn')
    return Date.now() - t0
  } catch { return 0 }
}

/** A sign-out stopped: the page stays as it is. */
export async function stopSignOut(req) {
  try {
    if (onePageOn()) await req.respond({ status: 204, body: '' })
    else await req.abort()
  } catch {}
}
