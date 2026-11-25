/**
 * answerCache.js — the big lists every page asks for (all profiles, where each
 * one stands, the brokers…) are made once and kept, ready gzipped, until one of
 * the tables they come from changes (services/changes.js) — then made again on
 * the next ask. So ten windows and phones opening Adal Keep cost one database
 * read, and the database stays free for the robots.
 */
import zlib from 'zlib'
import { onChanged } from './changes.js'

// Path (exactly, without a query) → the tables it is made from.
const KEPT = {
  '/api/profiles': ['profiles', 'brokers'],
  '/api/profiles/brief': ['profiles', 'brokers'],
  '/api/automations/stages': ['profiles', 'automation_queue', 'profile_automations', 'profile_fields', 'files', 'generated_cvs', 'whatsapp_sends'],
  '/api/brokers': ['brokers', 'profiles'],
  '/api/dashboard': ['profiles', 'brokers', 'tasks'],
}
const MAX_AGE = 60_000            // and never older than a minute, whatever happens
const cache = new Map()           // path → { at, type, text, gz }
const making = new Map()          // path → { done: Promise, stale } being made now

// A list being made when its tables change is not kept (it may hold what was before), nor waited for by a later ask.
function drop(p) { cache.delete(p); const m = making.get(p); if (m) { m.stale = true; making.delete(p) } }
onChanged(({ tables }) => {
  for (const [p, from] of Object.entries(KEPT)) if (tables.includes('*') || from.some(t => tables.includes(t))) drop(p)
})

/** Made again on the next ask (a change only this PC's lists need, e.g. a profile opened). */
export function forget(p) { drop(p) }

const gzip = (text) => new Promise((ok, no) => zlib.gzip(text, { level: 2 }, (e, b) => e ? no(e) : ok(b)))
async function answer(req, res, kept) {
  if (kept.text.length > 16384 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    // Packed once, off the main thread (a megabyte packed there held up every other click).
    const gz = await (kept.gz ||= gzip(kept.text).catch(() => null))
    if (res.headersSent) return
    if (gz) {
      res.set({ 'Content-Type': kept.type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' })
      return res.end(gz)
    }
  }
  return res.type(kept.type).send(kept.text)
}

export function answerCache() {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next()
    const p = req.originalUrl
    if (!KEPT[p]) return next()           // with a query (search, filter): always fresh
    let hit = cache.get(p)
    // Several windows reload the same list when something changes: made once, all of them get it.
    if (!(hit && Date.now() - hit.at < MAX_AGE) && making.has(p)) hit = await making.get(p).done
    if (hit && Date.now() - hit.at < MAX_AGE) {
      res.set('X-Adal-Cache', 'hit')
      return answer(req, res, hit).catch(next)
    }
    let tell
    const mine = { done: new Promise(r => { tell = r }), stale: false }
    making.set(p, mine)
    const over = (kept = null) => { if (making.get(p) === mine) making.delete(p); tell(kept) }
    res.on('close', () => over())         // an error, or the window went away: the others make it themselves
    // Made now: keep what is answered (only a good answer).
    const json = res.json.bind(res)
    res.json = (body) => {
      if (res.statusCode !== 200 || res.headersSent) { over(); return json(body) }
      let kept
      try { kept = { at: Date.now(), type: 'application/json; charset=utf-8', text: JSON.stringify(body), gz: null } }
      catch { over(); return json(body) }
      if (!mine.stale) cache.set(p, kept)
      over(mine.stale ? null : kept)
      answer(req, res, kept).catch(() => res.end())   // as just made: not turned into JSON and packed a second time
      return res
    }
    next()
  }
}
