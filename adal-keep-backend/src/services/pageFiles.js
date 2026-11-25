/**
 * pageFiles.js — the window's own files (/assets/…, a new name with each build).
 *
 *   - A file that is not there answers 404, never the app's page: a window asking for
 *     an old file got a page instead of code and reloaded itself.
 *   - The files of the builds before are kept (data/pages-kept, 30 days): a window open
 *     during an update goes on with the version it has. ADAL_PAGES_KEPT=0 = off.
 *   - Packed off the main thread, once (the first window after a start held up the rest).
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'util'
import { fileURLToPath } from 'url'

const gzip = promisify(zlib.gzip)
const KEPT = process.env.ADAL_PAGES_KEPT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/pages-kept')
const on = () => process.env.ADAL_PAGES_KEPT !== '0'
const DAYS = 30
const TYPE = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
const FOREVER = 'public, max-age=31536000, immutable'

/** Express: /assets of this build, else of a build before, else 404. */
export function pageFiles(dir, { kept = KEPT } = {}) {
  const gz = new Map()
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    let name
    try { name = path.basename(decodeURIComponent(req.path)) } catch { return res.status(400).end() }
    if (!name || name.startsWith('.')) return res.status(404).end()
    const places = [path.join(dir, 'assets', name), ...(on() ? [path.join(kept, name)] : [])]
    let file = null
    for (const p of places) if (await fs.promises.access(p).then(() => true, () => false)) { file = p; break }
    if (!file) return res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('This file is not here (an older version of Adal Keep).')
    const type = TYPE[path.extname(name)]
    if (type && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      try {
        if (!gz.has(file)) { const p = fs.promises.readFile(file).then(b => gzip(b, { level: 6 })); gz.set(file, p); p.catch(() => gz.delete(file)) }
        const body = await gz.get(file)
        res.set({ 'Content-Encoding': 'gzip', 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': FOREVER, Vary: 'Accept-Encoding' })
        return res.end(body)
      } catch { /* sent as it is */ }
    }
    res.set('Cache-Control', FOREVER)
    res.sendFile(file, { cacheControl: false }, (e) => { if (e && !res.headersSent) next(e) })
  }
}

/** This build's files put aside for the windows that will still be open after the next update; the oldest go. */
export async function keepPageFiles(dir, { kept = KEPT, now = Date.now() } = {}) {
  if (!on()) return { kept: 0, gone: 0 }
  let n = 0, gone = 0
  try {
    await fs.promises.mkdir(kept, { recursive: true })
    for (const name of await fs.promises.readdir(path.join(dir, 'assets'))) {
      const to = path.join(kept, name)
      const t = new Date(now)
      if (await fs.promises.utimes(to, t, t).then(() => true, () => false)) continue   // there already: still in use
      await fs.promises.copyFile(path.join(dir, 'assets', name), `${to}.tmp`)
      await fs.promises.rename(`${to}.tmp`, to)
      await fs.promises.utimes(to, t, t)
      n++
    }
    for (const name of await fs.promises.readdir(kept)) {
      const p = path.join(kept, name)
      const s = await fs.promises.stat(p).catch(() => null)
      if (s && now - s.mtimeMs > DAYS * 86400000) { await fs.promises.rm(p, { force: true }); gone++ }
    }
  } catch (e) { console.warn('[pages] kept files:', e.message) }
  return { kept: n, gone }
}
