/**
 * runLimit.js — no robot run lasts more than 10 minutes (owner's rule, 2026-11-22:
 * "any task shouldn't last above 10 mins"). A run that stuck (a blank page, a site
 * that never answers) kept a browser tab spinning, the PC at 100%, and held back
 * the update. The 10 minutes count the time the robot itself works: while it waits
 * for a person (a code, Save, Submit — attention.isWaiting) the clock stands still.
 * Past the limit the run is stopped ("stopped after 10 minutes"), its tab released,
 * and the queue goes on: it never blocks anything again.
 */
export const RUN_LIMIT_MS = Number(process.env.ADAL_RUN_LIMIT_MS) || 10 * 60 * 1000
export const LIMIT_NOTE = 'stopped after 10 minutes'
const TICK_MS = Number(process.env.ADAL_RUN_LIMIT_TICK_MS) || 5000

/**
 * Starts the clock of one run. `waiting()` says whether a person is being waited for.
 * Returns { hit: Promise (resolves once, when the limit is reached), stop() }.
 */
export function startRunClock({ waiting = () => false, limitMs = RUN_LIMIT_MS, tickMs = TICK_MS, now = Date.now } = {}) {
  let active = 0, last = now(), timer = null, done = false
  let resolveHit = () => {}
  const hit = new Promise(r => { resolveHit = r })
  const tick = () => {
    const t = now()
    if (!waiting()) active += t - last
    last = t
    if (!done && active >= limitMs) { done = true; clearInterval(timer); resolveHit(active) }
  }
  timer = setInterval(tick, tickMs)
  timer.unref?.()
  return { hit, stop() { done = true; clearInterval(timer) }, activeMs: () => active }
}

/** A promise that gives up after ms with `fallback` (a busy database must not hold the update back). */
export const withTimeout = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise(r => { const t = setTimeout(() => r(fallback), ms); t.unref?.() })])
