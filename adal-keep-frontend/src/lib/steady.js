/**
 * steady.js — an Adal Companion's window stays where it is while the main PC is only slow
 * (2026-11-25: "it just stutters"). Two answers later than 5 s moved the page to the online copy
 * and the next good one moved it back. The same rule as adal-companion/steady.go: the page leaves
 * when nothing listens there for 45 s and 4 looks, or nothing is answered for 5 minutes and 8 looks;
 * never while something is being saved or typed.
 */
export const GONE_MS = 45_000, SLOW_MS = 300_000, HOLD_MS = 10 * 60_000

/** One look: 'up' | 'slow' | 'gone' → true when the page should leave. `s` is kept between looks. */
export function leaveStep(s, look, now) {
  if (look === 'up') { s.bad = s.gone = 0; return false }
  if (!s.bad) s.badAt = now
  s.bad = (s.bad || 0) + 1
  if (look === 'gone') { if (!s.gone) s.goneAt = now; s.gone = (s.gone || 0) + 1 } else s.gone = 0
  return (s.gone >= 4 && now - s.goneAt >= GONE_MS) || (s.bad >= 8 && now - s.badAt >= SLOW_MS)
}

/** One look: a dropped answer looks like a closed port in a browser, so it is asked 3 times before 'gone'. */
export async function look(ask, pause = (ms) => new Promise(ok => setTimeout(ok, ms))) {
  for (let i = 0; i < 3; i++) {
    if (i) await pause(700)
    try { return (await ask()).status >= 500 ? 'slow' : 'up' } catch (e) { if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'slow' }
  }
  return 'gone'
}

/** One look from the online pages: found or not → true when the page should go to the main PC.
 *  Just left it: three good looks over 20 s; otherwise at once. */
export function backStep(s, found, now, left) {
  if (!found) { s.ok = 0; return false }
  if (!s.ok) s.okAt = now
  s.ok = (s.ok || 0) + 1
  return !left || (s.ok >= 3 && now - s.okAt >= 20_000)
}

// ── A save going on, or someone typing ──────────────────────────────────────
let saving = 0, typedAt = 0, watching = false
export function watchSaves(w = window) {
  if (watching) return
  watching = true
  const X = w.XMLHttpRequest?.prototype
  if (X) {
    const open = X.open, send = X.send
    X.open = function (m, ...a) { this.__adalWrite = !/^(get|head|options)$/i.test(m); return open.call(this, m, ...a) }
    X.send = function (...a) { if (this.__adalWrite) { saving++; this.addEventListener('loadend', () => { saving = Math.max(0, saving - 1) }, { once: true }) } return send.apply(this, a) }
  }
  w.addEventListener?.('input', () => { typedAt = Date.now() }, true)
}
export const busyHere = (now = Date.now()) => saving > 0 || now - typedAt < 20_000
export const _set = (s, t) => { saving = s; typedAt = t }
