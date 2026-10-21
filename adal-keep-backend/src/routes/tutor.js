import { Router } from 'express'
import { todayFor, track, markGoal, markSeen, ask, adoption, setLang } from '../services/tutor.js'

// The daily tutor (services/tutor.js). `who` = the employee id signed in on
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

router.get('/tutor/today', wrap((db, who) => todayFor(db, who)))
router.post('/tutor/event', wrap(async (db, who, req) => ({ ok: await track(db, who, String(req.body?.feature || '')) })))
router.post('/tutor/seen', wrap(async (db, who, req) => { await markSeen(db, who, String(req.body?.lesson || '')); return todayFor(db, who) }))
router.post('/tutor/goal', wrap(async (db, who, req) => { await markGoal(db, who, String(req.body?.goal || '')); return todayFor(db, who) }))
router.post('/tutor/lang', wrap(async (db, who, req) => { await setLang(db, who, req.body?.lang); return todayFor(db, who) }))
router.post('/tutor/ask', wrap((db, who, req) => ask(db, who, String(req.body?.question || ''), req.body?.lang)))
router.get('/tutor/adoption', wrap((db) => adoption(db)))

export default router
