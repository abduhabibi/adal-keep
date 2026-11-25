/**
 * liveView.js — the robot's browser as a person sees it: ONE stream a run, whatever shows it (the small view, the
 * full one, both): opening the full view shows the same picture at once, nothing is opened again. The last picture
 * stays while the line comes back (it connects again by itself), and for a minute after the last view closed.
 * The pieces: backend services/liveStream.js. A main PC that has none (older, or switched off) → unsupported:
 * the views use what they used before.
 */
import api from '../services/api'
import { pieces } from './livePieces'

const KEEP_MS = 10000          // the stream stays this long after the last view closed
const DEAD_MS = 12000          // nothing at all (not even "still here") this long: connect again
const BACKOFF = [250, 500, 1000, 2000, 3000]
const hubs = new Map()

const u32 = (a, o = 0) => new DataView(a.buffer, a.byteOffset).getUint32(o)

/** Where the stream is asked: the main PC straight, or over the office network from a Companion's online window. */
async function openStream(runId, signal) {
  const path = `/automations/${runId}/live`
  if (typeof window !== 'undefined' && window.__ADAL_CLOUD) {
    const { lanUp } = await import('../cloud/adapter.js')
    if (!(await lanUp())) return null
    return fetch(`/lan-api${path}`, { headers: { 'X-Adal': '1' }, cache: 'no-store', signal })
  }
  return fetch(`${api.defaults.baseURL}${path}`, { credentials: 'include', cache: 'no-store', signal })
}

function makeHub(runId) {
  const canvas = document.createElement('canvas')
  const g = canvas.getContext('2d', { alpha: false })
  const kept = new Map()      // picture id → ImageBitmap (the last 8)
  const h = {
    runId, canvas, views: new Set(), seen: false, frames: 0, at: 0,
    meta: { url: '', title: '', codeBox: false }, state: 'connecting', text: 'Opening the robot\'s browser…',
    ac: null, tries: 0, closeT: null, alive: true, chain: Promise.resolve(),
  }
  const tell = (what) => { for (const fn of h.views) { try { fn(what, h) } catch {} } }
  h.tell = tell
  const set = (state, text) => { if (h.state === state && h.text === text) return; h.state = state; h.text = text; tell('state') }
  const draw = (img, x = 0, y = 0, whole = true) => {
    if (whole && (canvas.width !== img.width || canvas.height !== img.height)) { canvas.width = img.width; canvas.height = img.height }
    g.drawImage(img, x, y)
    h.seen = true; h.frames++; h.at = Date.now()
    if (h.state !== 'live') set('live', '')
    tell('picture')
  }
  const keep = (id, bmp) => { kept.set(id, bmp); while (kept.size > 8) { const k = kept.keys().next().value; kept.get(k)?.close?.(); kept.delete(k) } }
  // In order, one after the other (a picture unpacks in the background).
  const later = (fn) => { h.chain = h.chain.then(fn).catch(() => {}) }
  const on = (kind, body) => {
    h.heard = Date.now()
    if (kind === 'J') {
      const m = JSON.parse(new TextDecoder().decode(body))
      if (m.state === 'live') { h.meta = { ...h.meta, ...m }; tell('meta'); if (h.seen) set('live', '') } else later(() => set(m.state, m.text || ''))
    } else if (kind === 'P') {
      const id = u32(body), jpg = body.slice(4)
      later(async () => { const bmp = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' })); keep(id, bmp); draw(bmp) })
    } else if (kind === 'R') { const id = u32(body); later(() => { const bmp = kept.get(id); if (bmp) { keep(id, bmp); draw(bmp) } }) }
    else if (kind === 'T') {
      const n = u32(body), list = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + n)))
      const bytes = body.slice(4 + n)
      later(async () => { let o = 0; for (const p of list) { const bmp = await createImageBitmap(new Blob([bytes.slice(o, o + p.n)], { type: 'image/jpeg' })); o += p.n; draw(bmp, p.x, p.y, false); bmp.close?.() } })
    }
  }
  const run = async () => {
    while (h.alive) {
      const ac = h.ac = new AbortController()
      h.heard = Date.now()
      const watch = setInterval(() => { if (Date.now() - h.heard > DEAD_MS) ac.abort() }, 1000)
      let why = ''
      try {
        const r = await openStream(runId, ac.signal)
        if (!r) { h.state = 'unsupported'; tell('state'); return }
        if (r.headers.get('x-adal-live') !== '2' && !/octet-stream/.test(r.headers.get('content-type') || '')) {
          const d = await r.json().catch(() => ({}))
          // No such thing on that PC: the older views. Robots off / the PC starting: said, and tried again.
          if (r.status === 404) { h.state = 'unsupported'; tell('state'); return }
          throw Object.assign(new Error(d.error || `the PC answered ${r.status}`), { plain: d.error })
        }
        for (const b of kept.values()) b.close?.()
        kept.clear()
        const feed = pieces(on), rd = r.body.getReader()
        for (;;) {
          const { value, done } = await rd.read()
          if (done) break
          h.heard = Date.now(); h.tries = 0
          feed(value)
        }
      } catch (e) { why = e.plain || '' } finally { clearInterval(watch) }
      if (!h.alive) return
      const n = h.tries++
      set('reconnecting', why || (n < 3 ? 'Connecting to the robot\'s browser again…' : 'The main PC does not answer just now — still trying.'))
      await new Promise(r => setTimeout(r, BACKOFF[Math.min(n, BACKOFF.length - 1)]))
    }
  }
  h.start = () => { h.done = run() }
  h.stop = () => { h.alive = false; h.ac?.abort(); for (const b of kept.values()) b.close?.(); kept.clear() }
  return h
}

/** Watch a run's browser: fn('picture' | 'meta' | 'state', hub). Returns [hub, leave]. */
export function watchLive(runId, fn) {
  const key = String(runId)
  let h = hubs.get(key)
  if (!h || (!h.alive)) { h = makeHub(key); hubs.set(key, h); h.start() }
  clearTimeout(h.closeT)
  h.views.add(fn)
  // What is there already, at once.
  queueMicrotask(() => { if (!h.views.has(fn)) return; fn('state', h); fn('meta', h); if (h.seen) fn('picture', h) })
  return [h, () => {
    h.views.delete(fn)
    if (!h.views.size) h.closeT = setTimeout(() => { if (h.views.size) return; h.stop(); if (hubs.get(key) === h) hubs.delete(key) }, KEEP_MS)
  }]
}
/** What was seen of this run last (null: nothing). */
export const lastSeen = (runId) => { const h = hubs.get(String(runId)); return h?.seen ? h : null }
