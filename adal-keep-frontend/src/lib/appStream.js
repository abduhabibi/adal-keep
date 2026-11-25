/**
 * One stream per window on the main PC itself (asked on 2026-11-23): "a window is open"
 * (/api/app/alive), what changed (/api/changes) and the double-C pictures (/api/app/clips)
 * come on one line — a browser opens only 6 lines to one PC, and three streams per
 * window left too few for the pages and the live robot view. Elsewhere (another PC,
 * the phone): null, and each part opens its own as before.
 */
let es = null
export const localWindow = () => import.meta.env.VITE_DEMO !== '1' && import.meta.env.VITE_PHONE !== '1' && import.meta.env.VITE_ADMIN !== '1'
  && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && typeof EventSource !== 'undefined'
/** Another PC's window: its /api/changes line, which also carries what that PC's double C crops ("clips"). */
let far = null
export function changesStream() {
  if (far) return far
  far = new EventSource('/api/changes')
  // That PC's watcher runs: said at once, maybe before lib/clipWatch.js listens.
  far.addEventListener('clips', (e) => { try { const m = JSON.parse(e.data); if ('hook' in m) window.__adalClipHook = !!m.hook } catch {} })
  return far
}
const HERE = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
export const farWindow = () => !HERE() && !window.__ADAL_CLOUD && import.meta.env.VITE_DEMO !== '1' && import.meta.env.VITE_PHONE !== '1' && typeof EventSource !== 'undefined'
export function appStream() {
  if (!localWindow()) return null
  if (!es) es = new EventSource('/api/app/alive?all=1')
  return es
}
