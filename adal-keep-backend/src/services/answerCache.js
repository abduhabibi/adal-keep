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
  '/api/automations/stages': ['profiles', 'automation_queue', 'profile_automations', 'profile_fields', 'files', 'generated_cvs', 'whatsapp_sends'],
  '/api/brokers': ['brokers', 'profiles'],
  '/api/dashboard': ['profiles', 'brokers', 'tasks'],
}
const MAX_AGE = 60_000            // and never older than a minute, whatever happens
const cache = new Map()           // path → { at, type, text, gz }

onChanged(({ tables }) => {
  for (const [p, from] of Object.entries(KEPT)) if (tables.includes('*') || from.some(t => tables.includes(t))) cache.delete(p)
})

/** Made again on the next ask (a change only this PC's lists need, e.g. a profile opened). */
export function forget(p) { cache.delete(p) }

export function answerCache() {
  return (req, res, next) => {
    if (req.method !== 'GET') return next()
    const p = req.originalUrl
    if (!KEPT[p]) return next()           // with a query (search, filter): always fresh
    const hit = cache.get(p)
    if (hit && Date.now() - hit.at < MAX_AGE) {
      res.set('X-Adal-Cache', 'hit')
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && hit.gz) {
        res.set({ 'Content-Type': hit.type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' })
        return res.end(hit.gz)
      }
      return res.type(hit.type).send(hit.text)
    }
    // Made now: keep what is answered (only a good answer).
    const json = res.json.bind(res)
    res.json = (body) => {
      if (res.statusCode === 200) {
        try {
          const text = JSON.stringify(body)
          cache.set(p, { at: Date.now(), type: 'application/json; charset=utf-8', text, gz: text.length > 16384 ? zlib.gzipSync(text, { level: 5 }) : null })
        } catch {}
      }
      return json(body)
    }
    next()
  }
}
