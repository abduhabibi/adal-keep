/**
 * pdfHelperGuard.js — when another PC may draw a CV's PDF, and for how long this PC waits for it.
 *
 * Seen on Main (2026-11-25/26): every CV waited for "the other PC could not draw it — drawn here: The operation was aborted
 * due to timeout" — the helper's address had changed, so each CV waited 20 s (remoteBrowsers.browserForDevice) before Main drew it.
 * Now:
 *   - a helper that failed (or was too slow) is skipped AT ONCE for a while: 2 min, then 5, 15, 30 (it is asked again after that);
 *   - nobody offered / nobody could be asked in the last minute: the question is not asked again for a minute;
 *   - a helper is never waited for longer than drawing here is expected to take (1.5 x what drawing here took lately + 1.5 s,
 *     between 6 and 20 s; 10 s until a first drawing here was timed), and its late answer is never written (abandoned);
 *   - a helper that is slower than drawing here (its time >= 80 % of ours: the PDF travels both ways over the Wi-Fi) is not used,
 *     but looked at again every 8th CV in case this PC has become the slower one.
 * Never throws; ADAL_PDF_HELPER_GUARD=0 turns the guard off (the old behaviour).
 */
const BACKOFF_MIN = [2, 5, 15, 30]
const state = { bad: new Map(), local: 0, remote: new Map(), uses: 0, slowSkips: 0, nobodyUntil: 0 }
export const _reset = () => { state.bad.clear(); state.remote.clear(); state.local = 0; state.uses = 0; state.slowSkips = 0; state.nobodyUntil = 0 }
const on = () => process.env.ADAL_PDF_HELPER_GUARD !== '0'
const ema = (old, v) => (old ? old * 0.6 + v * 0.4 : v)

export const recordLocal = (ms) => { if (ms > 0) state.local = ema(state.local, ms) }
export const budgetMs = () => (state.local ? Math.min(20_000, Math.max(6_000, state.local * 1.5 + 1_500)) : 10_000)

function fail(id, now = Date.now()) {
  const n = Math.min((state.bad.get(id)?.n || 0) + 1, BACKOFF_MIN.length)
  state.bad.set(id, { n, until: now + BACKOFF_MIN[n - 1] * 60_000 })
}
function ok(id, ms) {
  state.bad.delete(id)
  state.remote.set(id, ema(state.remote.get(id), ms))
}
/** '' when this helper may be tried, else why not. */
export function skipReason(id, now = Date.now()) {
  if (!on()) return ''
  const b = state.bad.get(id)
  if (b && now < b.until) return `failed lately (skipped for ${Math.ceil((b.until - now) / 60_000)} more minutes)`
  const r = state.remote.get(id)
  if (r && state.local && r >= state.local * 0.8) return ++state.slowSkips % 8 === 0 ? '' : 'slower than drawing here'
  return ''
}

/**
 * Tries a helper if it is worth it. Returns true when the helper did the job, false when it did not (the caller draws here).
 *   pick()               → the helper's id, or '' / null
 *   attempt(id, ticket)  → does the job; must not write its result if ticket.abandoned
 */
export async function viaHelper({ pick, attempt, log = console.log, now = Date.now }) {
  if (!on()) {
    const id = await pick(); if (!id) return false
    try { await attempt(id, { abandoned: false }); return true } catch (e) { log('[cv] the other PC could not draw it — drawn here:', e.message); return false }
  }
  if (now() < state.nobodyUntil) return false
  let id
  try { id = await pick() } catch { id = '' }
  if (!id) { state.nobodyUntil = now() + 60_000; return false }
  const why = skipReason(id, now())
  if (why) return false
  state.uses++
  const ticket = { abandoned: false }, t0 = now(), limit = budgetMs()
  let timer
  try {
    await Promise.race([
      attempt(id, ticket),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the other PC took over ${Math.round(limit / 1000)} s`)), limit); timer.unref?.() }),
    ])
    ok(id, now() - t0)
    return true
  } catch (e) {
    ticket.abandoned = true
    fail(id, now())
    log(`[cv] the other PC could not draw it — drawn here, and it is skipped for ${BACKOFF_MIN[Math.min(state.bad.get(id).n, BACKOFF_MIN.length) - 1]} min:`, e.message)
    return false
  } finally { clearTimeout(timer) }
}
