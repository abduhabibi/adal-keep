/**
 * liveStream.js — a run's tab as a person sees it: one answer that never ends (GET /automations/:id/live), in pieces,
 * each only when something changed.
 *
 *   [length, 4 bytes big-endian][kind, 1 byte][what]
 *   J  JSON: { state: 'opening' | 'live' | 'gone', text, url, title, codeBox, size }
 *   P  a whole picture: [id, 4 bytes][JPEG]          R  the picture sent before with this id again: [id, 4 bytes]
 *   T  the changed parts: [JSON length, 4 bytes][JSON [{x,y,w,h,n}]][JPEGs one after the other]   (slow lines only)
 *   K  still here (every 5 s; the viewer connects again after 12 s of nothing)
 *
 * Why one plain HTTP answer and not a WebSocket: it passes every hop there is today (Adal Keep → Adal Robots, a
 * Companion's own server, AdalKeep.exe /lan-api and adal-companion.exe) with their keys. docs/live-view.md has the
 * numbers. The tab is not there yet → "opening" and it goes on by itself when it comes; it goes → the same.
 * Off: ADAL_LIVE2=0 (the older picture stream and /screen are used).
 */
import crypto from 'crypto'
import { watchFrames, lastPicture } from './liveFrames.js'
import { tileMaker, tilesOn } from './liveTiles.js'

export const liveOn = () => process.env.ADAL_LIVE2 !== '0'
const PING_MS = 5000
const KEPT = 8                           // pictures a viewer keeps: a blinking cursor costs 9 bytes a blink
const SLOW_KBS = 300                     // a line slower than this gets only the changed parts
const PAD = Buffer.alloc(8192)           // (an older adal-companion.exe holds the last few KB back until more comes)

export function message(kind, ...parts) {
  const body = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
  const head = Buffer.alloc(5)
  head.writeUInt32BE(body.length, 0)
  head.write(kind, 4, 'latin1')
  return Buffer.concat([head, body])
}
const num = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b }

/** One viewer: what it gets, and what it is spared. write(buffer) → false when its line is full. */
export function viewer({ write, full, tiles = null, now = Date.now } = {}) {
  const sent = new Map()                 // hash → id (the newest KEPT)
  let ids = 0, meta = '', pending = null, busy = false, whole = true
  let mode = null                        // null: whole pictures · a tile-maker: only what changed
  const line = { bytes: 0, ms: 0 }
  const put = (b) => write(b)
  const picture = async (jpg) => {
    const hash = crypto.createHash('md5').update(jpg).digest('latin1')
    const id = sent.get(hash)
    if (id !== undefined && !mode) { sent.delete(hash); sent.set(hash, id); return put(message('R', num(id))) }
    if (mode) {
      let parts = null
      try { parts = await mode.next(jpg) } catch { mode = null }
      if (parts && !whole) {
        if (!parts.length) return
        const list = Buffer.from(JSON.stringify(parts.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h, n: p.jpg.length }))))
        return put(message('T', num(list.length), list, ...parts.map(p => p.jpg)))
      }
      whole = false
    }
    const n = ++ids
    sent.set(hash, n)
    if (sent.size > KEPT) sent.delete(sent.keys().next().value)
    put(message('P', num(n), jpg))
  }
  const next = async () => {
    if (busy) return
    busy = true
    try { while (pending && !full()) { const jpg = pending; pending = null; await picture(jpg) } } finally { busy = false }
  }
  return {
    show(jpg) { pending = jpg; return next() },        // (only the newest: a slow line never falls behind)
    drained: () => next(),
    say(m) { const s = JSON.stringify(m); if (s === meta) return false; meta = s; put(message('J', s)); return true },
    ping: () => put(message('K')),
    /** The line took `bytes` in `ms`: slow → only what changed from here on. */
    speed(bytes, ms) {
      line.bytes += bytes; line.ms += ms
      if (mode || !tiles || line.bytes < 200e3 || line.ms < 400) return
      if (line.bytes / line.ms < SLOW_KBS) { mode = tiles(); whole = true }
      line.bytes = line.ms = 0
    },
    get slow() { return !!mode },
    now,
  }
}

/** The page's address, title and code box, asked only when the picture changed (at most once a second). */
async function metaOf(page, codeBox) {
  const within = (p, ms, d) => { let t; return Promise.race([Promise.resolve(p).catch(() => d), new Promise(r => { t = setTimeout(() => r(d), ms) })]).finally(() => clearTimeout(t)) }
  const size = await within(page.evaluate(() => [innerWidth, innerHeight]), 2000, null)
  const [title, code] = await Promise.all([within(page.title(), 2000, ''), within(codeBox(page), 2000, false)])
  return { url: page.url(), title, codeBox: !!code, ...(size ? { size } : {}) }
}

/**
 * Serves one viewer until it leaves. tabOf(): the run's tab now, or null (asked again while there is none);
 * ended(): true when the run is over (its tab will not come). onOpen(page): a person looks at it now.
 */
export async function serveLive(req, res, { tabOf, ended = async () => false, onOpen = null, codeBox = async () => false, lookMs = 400 }) {
  let closed = false, stop = null, page = null, metaAt = 0, metaBusy = false
  req.on('close', () => { closed = true; try { stop?.() } catch {} })
  const pad = !!(req.headers['x-adal-pc'] && !req.headers['x-adal-flush'])
  res.socket?.setNoDelay?.(true)
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Adal-Live': '2' })
  let filledAt = 0, filled = 0
  const write = (b) => {
    if (closed || res.writableEnded) return false
    const free = !res.writableNeedDrain
    const ok = res.write(pad ? Buffer.concat([b, message('K', PAD)]) : b)
    if (free && !ok) { filledAt = Date.now(); filled = b.length } else if (!ok) filled += b.length
    return ok
  }
  const v = viewer({ write, full: () => res.writableNeedDrain || closed, tiles: tilesOn() ? () => tileMaker() : null })
  res.on('drain', () => { if (filledAt) { v.speed(filled, Math.max(1, Date.now() - filledAt)); filledAt = 0 } v.drained() })
  const ping = setInterval(() => { if (closed) return; v.ping(); if (page) page.__adalLookedAt = Date.now() }, PING_MS)
  const meta = async (p) => {
    if (metaBusy || Date.now() - metaAt < 1000) return
    metaBusy = true; metaAt = Date.now()
    try { const m = await metaOf(p, codeBox); if (p === page && !closed) v.say({ state: 'live', ...m }) } catch {} finally { metaBusy = false }
  }
  try {
    for (let n = 0; !closed; n++) {
      page = await tabOf().catch(() => null)
      if (closed) break
      if (!page) {
        if (await ended().catch(() => false)) { v.say({ state: 'gone', text: 'No robot browser is running for this now.' }); await wait(2000, () => closed); continue }
        v.say({ state: 'opening', text: n < 25 ? 'The robot is opening its browser…' : 'The robot browser is slow to open on this PC — still trying.' })
        await wait(lookMs, () => closed)
        continue
      }
      n = 0
      v.say({ state: 'live', url: page.url() })
      // What it looked like last, at once; the fresh picture follows.
      const kept = lastPicture(page)
      if (kept) v.show(kept)
      Promise.resolve().then(() => onOpen?.(page)).catch(() => {})
      const mine = page
      let over = null
      const gone = new Promise(r => { over = r })
      try {
        stop = await watchFrames(mine, (jpg) => { v.show(jpg); meta(mine) }, over)
        if (closed) { stop(); break }
        await Promise.race([gone, new Promise(r => req.on('close', r))])
      } catch { await wait(700, () => closed) }        // this tab cannot be shown just now: looked for again
      try { stop?.() } catch {}
      stop = null; page = null
      if (!closed) v.say({ state: 'opening', text: 'The robot\'s tab closed — waiting for it to open again…' })
    }
  } finally { clearInterval(ping); try { stop?.() } catch {}; if (!res.writableEnded) res.end() }
}
const wait = (ms, off) => new Promise(r => { const t0 = Date.now(); const t = setInterval(() => { if (off() || Date.now() - t0 >= ms) { clearInterval(t); r() } }, 50) })
