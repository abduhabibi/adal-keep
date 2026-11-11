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
const get = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k, v) => { try { localStorage.setItem(k, v) } catch {} }

export async function shareOnlineCopy() {
  if (typeof window === 'undefined' || window.__ADAL_CLOUD) return
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return   // the main PC itself
  const q = new URLSearchParams(location.search)
  if (q.has('adal_companion')) set(IS, '1')
  if (q.has('adal_online')) set(DONE, q.get('adal_online') === 'ok' ? String(Date.now()) : '')
  if (q.has('adal_companion') || q.has('adal_online')) {
    q.delete('adal_companion'); q.delete('adal_online')
    history.replaceState(history.state, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash)
  }
  if (get(IS) !== '1' || get(DONE)) return
  try {
    const { data } = await api.post('/pc-access/online-copy', { name: 'Companion PC' })
    const back = location.href
    location.href = `${ONLINE}/companion-pair.html#${encodeURIComponent(JSON.stringify({ pc: data, back }))}`
  } catch (err) {
    console.warn('[companion] no online copy:', err?.response?.data?.error || err.message)
  }
}
