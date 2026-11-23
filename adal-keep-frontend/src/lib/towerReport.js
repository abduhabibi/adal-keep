/**
 * The page's crashes go to Adal (backend routes/tower.js → Admin → Fleet →
 * Crashes): a part that broke (ErrorBoundary, e.g. React #310) and uncaught
 * errors. Only the message and where; at most 30 per page load, each message
 * once a minute. Never blocks or breaks anything (a phone without the PC: lost).
 */
const sent = new Map()
let count = 0

export function reportCrash(error, where = '') {
  try {
    const message = String(error?.message || error || '').slice(0, 500)
    if (!message || count >= 30) return
    const last = sent.get(message)
    if (last && Date.now() - last < 60000) return
    sent.set(message, Date.now()); count++
    fetch('/api/tower/crash', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'frontend', message, where: String(where || location.pathname).slice(0, 120), stack: String(error?.stack || '').slice(0, 1500) }),
    }).catch(() => {})
  } catch {}
}

let listening = false
export function listenForCrashes() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('error', (e) => { if (e?.error || e?.message) reportCrash(e.error || e.message, `${location.pathname} (uncaught)`) })
  // Failed requests are not crashes: only real errors of the page's own code.
  window.addEventListener('unhandledrejection', (e) => { const r = e?.reason; if (r instanceof Error && !r.isAxiosError && r.name !== 'AbortError') reportCrash(r, `${location.pathname} (promise)`) })
}
