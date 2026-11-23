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
export function appStream() {
  if (!localWindow()) return null
  if (!es) es = new EventSource('/api/app/alive?all=1')
  return es
}
