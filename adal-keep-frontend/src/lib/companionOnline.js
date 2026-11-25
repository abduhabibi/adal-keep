/**
 * In an Adal Companion PC's window (AdalKeep.exe opens the main PC's Adal
 * Keep with ?adal_companion=1): the first time, the main PC makes the
 * Companion its own online account (POST /pc-access/online-copy) and the
 * window hops once to the Companion's built-in online pages
 * (127.0.0.1:47801/companion-pair.html), which keep it and send the window
 * straight back. From then on the Companion opens the agency's online copy
 * (Supabase + the documents in Telegram) by itself whenever the main PC is
 * off — anywhere, with no waiting and no "Yes" on the main PC.
 * A browser that is not a Companion never does this.
 */
import api, { forgetJoin } from '../services/api'
import { windowNote, noNote, windowUsed, byItself } from './windowNote'
import { look, leaveStep, watchSaves, busyHere, HOLD_MS } from './steady.js'

const ONLINE = 'http://127.0.0.1:47801'
const IS = 'adal-is-companion'
const DONE = 'adal-companion-online'
const TRIED = 'adal-companion-online-tried'
const get = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k, v) => { try { localStorage.setItem(k, v) } catch {} }

// The main PC stops answering (turned off, the Companion left the office): said in
// a note, with a button to this PC's own copy at the same page. Never by itself: a
// busy main PC missed two answers and the whole window went away (2026-11-25).
// (And only once it is really away, lib/steady.js: a slow answer is no note.)
function watchMainPC() {
  watchSaves()
  const s = {}
  let asking = false, heldAt = 0, said = false
  const t = setInterval(async () => {
    if (asking) return
    asking = true
    const seen = await look(() => fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(8000) }))
    asking = false
    const away = leaveStep(s, seen, Date.now())
    if (seen === 'up') { noNote('main-pc'); said = false }
    if (!away) { heldAt = 0; return }
    const go = () => location.replace(`${ONLINE}${location.pathname}#adal_left`)
    heldAt ||= Date.now()
    if (byItself() && busyHere() && Date.now() - heldAt < HOLD_MS) return
    if (byItself()) { clearInterval(t); go() }
    else if (!said) { said = true; windowNote('main-pc', 'The main PC is not answering.', 'Work on this PC’s copy', go) }
  }, 8000)
}

/** This window is an Adal Companion's: the main PC's page in it, or its own online pages. Never the main PC. */
export function inCompanion() {
  if (typeof window === 'undefined') return false
  if (location.host === '127.0.0.1:47801') return true
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || window.__ADAL_CLOUD) return false
  return get(IS) === '1' || new URLSearchParams(location.search).has('adal_companion')
}

/**
 * "Log out of this main PC / Connect to another PC": this main PC lets go of
 * this Companion (its key, when it came in with one), the window forgets it,
 * and the Companion's own page (127.0.0.1:47801/forget, adal-launcher/leave.go)
 * stops its online account, clears companion.conf and opens the page to choose
 * another main PC. The caller asks "Are you sure?" first.
 */
export async function leaveMainPC() {
  if (location.host === '127.0.0.1:47801') { location.href = '/forget'; return }
  try { await api.post('/pc-access/leave', {}) } catch {}
  for (const k of [IS, DONE, TRIED]) { try { localStorage.removeItem(k) } catch {} }
  forgetJoin()   // its key and number: it does not come back in by itself
  // With this page's address as the referrer (the server sends none by
  // default): that is how the Companion's page knows the main PC's window
  // sent it here, already asked — not another website.
  const a = document.createElement('a')
  a.href = `${ONLINE}/forget?from=${encodeURIComponent(location.origin)}`
  a.referrerPolicy = 'origin'
  document.body.appendChild(a)
  a.click()
}

export async function shareOnlineCopy() {
  if (typeof window === 'undefined' || window.__ADAL_CLOUD) return
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return   // the main PC itself
  const q = new URLSearchParams(location.search)
  if (q.has('adal_companion')) set(IS, '1')
  // Handed over by the Companion's own pages (#adal_number, #adal_device): the
  // gate used the number if it was needed; the online account is tied to this
  // PC's key, so suspending the Companion on the main PC stops both.
  const h = new URLSearchParams(location.hash.slice(1))
  if (h.has('adal_number') || h.has('adal_device')) {
    if (h.get('adal_device')) api.post('/pc-access/link', { device: h.get('adal_device') }).catch(() => {})
    history.replaceState(history.state, '', location.pathname + location.search)
  }
  // Chosen again after a log out ("Connect to another PC"): a fresh pairing.
  if (q.has('adal_repair')) { try { localStorage.removeItem(DONE); localStorage.removeItem(TRIED) } catch {} }
  // Not kept there ("no": the Companion's own online pages are for another
  // Supabase): asked again in 6 hours, not at once — that went round and round,
  // the window reloading every few seconds.
  if (q.has('adal_online')) {
    if (q.get('adal_online') === 'ok') set(DONE, String(Date.now()))
    else set(TRIED, String(Date.now()))
  }
  if (q.has('adal_companion') || q.has('adal_online') || q.has('adal_repair')) {
    q.delete('adal_companion'); q.delete('adal_online'); q.delete('adal_repair')
    history.replaceState(history.state, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash)
  }
  if (get(IS) === '1' && get(DONE)) watchMainPC()
  if (get(IS) !== '1' || get(DONE)) return
  if (Date.now() - Number(get(TRIED) || 0) < 6 * 3600 * 1000) return
  // Somebody is working in this window already: at its next opening (this goes to another page and back).
  if (windowUsed() && !byItself()) return
  try {
    const { data } = await api.post('/pc-access/online-copy', { name: 'Companion PC' })
    if (windowUsed() && !byItself()) return
    const back = location.href
    location.href = `${ONLINE}/companion-pair.html#${encodeURIComponent(JSON.stringify({ pc: data, back }))}`
  } catch (err) {
    console.warn('[companion] no online copy:', err?.response?.data?.error || err.message)
  }
}
