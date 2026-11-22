/**
 * On a Companion with its own copy: what only the main PC has, asked there.
 *
 * The data is on every PC, but the robots run on the main PC only (its
 * browser, its tabs, its sign-ins). A person on a Companion still sees a run
 * live, answers its "I'm not a robot" box or a code, pauses or stops it: those
 * calls go to the main PC (with this PC's key), as the chat's do. Starting a
 * run stays here: it is a row in the queue, copied to the main PC, whose
 * worker runs it (worker.js dispatchRun).
 */
import express from 'express'
import { Readable } from 'stream'
import { isCompanion, mainURL, mainKey } from '../services/mainPC.js'

const router = express.Router()
const MAIN_ONLY = [
  /^\/automations\/attention$/,
  /^\/automations\/active$/,
  /^\/automations\/\d+\/(captcha|attention\/done|login|screen|stream|tab|mirror|input|resume|pause|cancel|complete)$/,
  /^\/sessions(\/|$)/,
  /^\/tasheer\/session$/,
  /^\/browser\/open$/,
]

// The main PC answering (checked at most every 20 s): when it does not — off, or
// away from the office — these calls are answered here, on this PC's own copy
// (the Morning sign-in opens in this PC's Adal Browser, the runs' lists are this
// PC's), instead of waiting for it.
let up = { url: '', ok: false, at: 0 }
async function mainAnswers(main) {
  if (up.url === main && Date.now() - up.at < 20000) return up.ok
  let ok = false
  try { ok = (await fetch(`${main}/api/health`, { signal: AbortSignal.timeout(3000) })).status < 500 } catch {}
  up = { url: main, ok, at: Date.now() }
  return ok
}
export const _resetMainCheck = () => { up = { url: '', ok: false, at: 0 } }

router.use(async (req, res, next) => {
  if (!isCompanion() || !MAIN_ONLY.some(re => re.test(req.path))) return next()
  const main = mainURL()
  if (!(await mainAnswers(main))) return next()
  try {
    const headers = { 'x-adal-pc': await mainKey() }
    for (const h of ['content-type', 'x-adal-who', 'accept']) if (req.headers[h]) headers[h] = req.headers[h]
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined
      : /json/i.test(req.headers['content-type'] || '') ? JSON.stringify(req.body ?? {}) : undefined
    const live = /\/stream$/.test(req.path)
    const ac = new AbortController()
    if (live) req.on('close', () => ac.abort())
    const r = await fetch(`${main}/api${req.originalUrl.replace(/^\/api/, '')}`, { method: req.method, headers, body, signal: live ? ac.signal : AbortSignal.timeout(60000) })
    res.status(r.status)
    for (const h of ['content-type', 'cache-control', 'content-disposition']) { const v = r.headers.get(h); if (v) res.setHeader(h, v) }
    if (!r.body) return res.end()
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res)
  } catch (e) {
    up = { url: main, ok: false, at: Date.now() }
    if (!res.headersSent && !/\/stream$/.test(req.path)) return next()   // (gone meanwhile: answered here)
    if (!res.headersSent) res.status(503).json({ error: `The robots run on the main PC (${main}), which did not answer: ${e.message}`, on_main: true })
  }
})

export default router
