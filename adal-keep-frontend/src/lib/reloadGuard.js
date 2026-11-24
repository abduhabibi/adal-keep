/**
 * Adal Keep reloads its own page by itself only rarely (asked on 2026-11-24: "the CV
 * preview page keeps reloading and getting blank"). A page file that does not load
 * (the window's pages from another release than the PC's server, an update half in),
 * the server's version changing, the PC letting this window in: each used to reload
 * every time it happened — and when the cause stayed, that was a reload every few
 * seconds, blank in between, forever.
 *
 * reloadOnce(): reloads only when no automatic reload happened in the last `everyMs`
 * (one minute), in any window of this browser; else it answers false and the caller
 * shows what is wrong instead (an error with a Reload button, a banner).
 */
const KEY = 'adal-auto-reload-at'

export function lastAutoReload() {
  try { return Number(localStorage.getItem(KEY)) || Number(sessionStorage.getItem(KEY)) || 0 } catch { return 0 }
}

export function mayReload(everyMs = 60_000, now = Date.now()) {
  const last = lastAutoReload()
  return !last || now - last >= everyMs || now < last
}

export function reloadOnce(why = '', { everyMs = 60_000 } = {}) {
  if (!mayReload(everyMs)) {
    console.warn(`[reload] not again within ${Math.round(everyMs / 1000)} s${why ? ` (${why})` : ''}`)
    return false
  }
  const now = String(Date.now())
  try { localStorage.setItem(KEY, now) } catch {}
  try { sessionStorage.setItem(KEY, now) } catch {}
  if (why) console.warn(`[reload] ${why}`)
  window.location.reload()
  return true
}

/** A lazy part of a page whose file does not load: one reload, else nothing (never a blank page). */
export const lazyOrNothing = (load, why) => () => load().catch(() => {
  if (reloadOnce(why)) return new Promise(() => {})
  return { default: () => null }
})
