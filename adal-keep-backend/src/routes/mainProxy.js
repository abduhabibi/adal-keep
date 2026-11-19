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

router.use(async (req, res, next) => {
  if (!isCompanion() || !MAIN_ONLY.some(re => re.test(req.path))) return next()
  const main = mainURL()
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
    if (!res.headersSent) res.status(503).json({ error: `The robots run on the main PC (${main}), which did not answer: ${e.message}`, on_main: true })
  }
})

export default router
