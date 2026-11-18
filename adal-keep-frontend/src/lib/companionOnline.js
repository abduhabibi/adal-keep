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
import api from '../services/api'

const ONLINE = 'http://127.0.0.1:47801'
const IS = 'adal-is-companion'
const DONE = 'adal-companion-online'
const TRIED = 'adal-companion-online-tried'
const get = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k, v) => { try { localStorage.setItem(k, v) } catch {} }

// The main PC stops answering (turned off, the Companion left the office): the
// window goes back to the online copy at once, at the same page; that copy
// comes back here by itself when the main PC answers (lib/companionDirect.js).
function watchMainPC() {
  let misses = 0
  const t = setInterval(async () => {
    let ok = false
    try { ok = (await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) })).status < 500 } catch {}
    misses = ok ? 0 : misses + 1
    if (misses >= 2) { clearInterval(t); location.replace(`${ONLINE}${location.pathname}`) }
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
  try {
    const { data } = await api.post('/pc-access/online-copy', { name: 'Companion PC' })
    const back = location.href
    location.href = `${ONLINE}/companion-pair.html#${encodeURIComponent(JSON.stringify({ pc: data, back }))}`
  } catch (err) {
    console.warn('[companion] no online copy:', err?.response?.data?.error || err.message)
  }
}
