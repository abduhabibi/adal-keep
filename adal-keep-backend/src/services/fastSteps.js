/**
 * fastSteps.js — robot steps wait for what they need, not for a fixed time (owner, 2026-11-27: "make the robot runs about 2x faster").
 *
 *   settle(ms, ready)     the old fixed sleep(ms): ends AS SOON AS ready() is true, and after the full `ms` when it never is
 *                         (so a step that did not get what it needs behaves exactly as before; the step's own check still decides)
 *   pollUntil(cond, ms, poll) a polling loop with a short poll (default 200 ms): { ok, value } — the old loops polled every 500–1000 ms
 *   pollFor(oldMs)        the poll the old loops used, made shorter (about 1/3, 150–400 ms)
 * Nothing here clicks, saves or submits; every step still verifies what it did. ADAL_FAST_STEPS=0 brings the old waits back.
 */
export const fast = () => process.env.ADAL_FAST_STEPS !== '0'
const nap = (ms) => new Promise(r => setTimeout(r, ms))

export const pollFor = (oldMs) => (fast() ? Math.min(oldMs, Math.max(150, Math.min(400, Math.round(oldMs / 3)))) : oldMs)

/** Waits up to `ms`, less when ready() answers true. Resolves true when ready, false after the full time. */
export async function settle(ms, ready, { poll = 150 } = {}) {
  if (!fast() || typeof ready !== 'function') { await nap(ms); return false }
  const end = Date.now() + ms
  while (Date.now() < end) {
    let ok = false
    try { ok = !!(await ready()) } catch { ok = false }
    if (ok) return true
    await nap(Math.min(poll, Math.max(0, end - Date.now())))
  }
  return false
}

/** Polls cond() every `poll` ms (the old loop's `oldPoll` when the switch is off) for at most `ms`: { ok, value }. */
export async function pollUntil(cond, ms, oldPoll = 1000) {
  const poll = pollFor(oldPoll), end = Date.now() + ms
  let value
  for (;;) {
    try { value = await cond() } catch { value = undefined }
    if (value) return { ok: true, value }
    const left = end - Date.now()
    if (left <= 0) return { ok: false, value }
    await nap(Math.min(poll, left))   // the last look is at the old loop's end: never a shorter longest wait
  }
}
