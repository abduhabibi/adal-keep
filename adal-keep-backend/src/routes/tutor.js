import { Router } from 'express'
import { tourFor, markTourShown, track, markSeen, ask, adoption, setLang } from '../services/tutor.js'

// The Adal tour (services/tutor.js). `who` = the employee id signed in on
// this PC, or 'owner'.
const router = Router()
const whoOf = (req) => {
  const w = String(req.query.who || req.body?.who || 'owner').trim()
  return /^[A-Za-z0-9_-]{1,40}$/.test(w) ? w : 'owner'
}
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req.app.locals.db, whoOf(req), req)) }
  catch (e) { console.error('[tutor]', e.message); res.status(500).json({ error: e.message }) }
}

router.get('/tutor/tour', wrap((db, who, req) => tourFor(db, who, String(req.query.page || ''))))
router.post('/tutor/tour/shown', wrap(async (db, who) => { await markTourShown(db, who); return { ok: true } }))
router.post('/tutor/event', wrap(async (db, who, req) => ({ ok: await track(db, who, String(req.body?.feature || '')) })))
router.post('/tutor/seen', wrap(async (db, who, req) => ({ ok: await markSeen(db, who, String(req.body?.lesson || '')) })))
router.post('/tutor/lang', wrap(async (db, who, req) => ({ lang: await setLang(db, who, req.body?.lang) })))
router.post('/tutor/ask', wrap((db, who, req) => ask(db, who, String(req.body?.question || ''), req.body?.lang)))
router.get('/tutor/adoption', wrap((db) => adoption(db)))

export default router
