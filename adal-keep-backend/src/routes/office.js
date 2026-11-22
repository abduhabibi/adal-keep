/**
 * /api/office — how the office's PCs are doing (services/officeHealth.js).
 *   GET  /office/health   one row per PC + the morning backup line
 *   GET  /office/day      the end-of-day summary (shown from 17:00)
 *   POST /office/presence {name}  "this person is signed in on this PC" (the page says it every minute)
 * A PC that follows a main PC asks the main PC: it is the one that knows the others.
 */
import express from 'express'
import { isFollower, mainURL, mainKey } from '../services/mainPC.js'
import { collect, daySummary, notePresence } from '../services/officeHealth.js'

const router = express.Router()

async function onMain(method, p, body) {
  const r = await fetch(`${mainURL()}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-adal-pc': await mainKey() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `the main PC answered ${r.status}`)
  return j
}
const route = (method, p, mine) => router[method](p, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.json(isFollower() ? await onMain(method.toUpperCase(), p, method === 'post' ? req.body : null) : await mine(req))
  } catch (e) { res.status(isFollower() ? 503 : 500).json({ error: e.message }) }
})

route('get', '/office/health', (req) => collect({ db: req.app.locals.db }))
route('get', '/office/day', (req) => daySummary(req.app.locals.db))
route('post', '/office/presence', (req) => {
  // A Companion's window carries that PC's key; the main PC's own window has none.
  notePresence(req.pcAccess?.id || '', req.body?.name)
  return { ok: true }
})

export default router
