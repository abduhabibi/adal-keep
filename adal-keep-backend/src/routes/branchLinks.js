/**
 * /api/branch-links — Settings → Branches (services/branchLinks.js).
 * The main PC holds the agency's online account, so it answers; another PC
 * of the agency (a follower) passes the call on to it, like the chat does.
 * Changes need "change settings" (staff roles).
 */
import express from 'express'
import * as B from '../services/branchLinks.js'
import { chatConfigured } from '../services/chatCloud.js'
import { mainURL, mainKey } from '../services/mainPC.js'
import { permsFor } from '../services/staffRoles.js'

const router = express.Router()

router.use('/branch-links', async (req, res, next) => {
  const main = mainURL()
  if (!main) return next()
  try {
    const headers = { 'content-type': 'application/json', 'x-adal-pc': await mainKey() }
    if (req.headers['x-adal-who']) headers['x-adal-who'] = req.headers['x-adal-who']
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {})
    const r = await fetch(`${main}/api${req.originalUrl.replace(/^\/api/, '')}`, { method: req.method, headers, body, signal: AbortSignal.timeout(30000) })
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    res.status(502).json({ error: `Branches are on the main PC (${main}), and it did not answer: ${e.message}` })
  }
})

const wrap = (fn, { change = false } = {}) => async (req, res) => {
  const db = req.app.locals.db
  try {
    if (req.headers['x-adal-cloud']) return res.status(403).json({ error: 'Link branches on a PC of the agency.' })
    if (!chatConfigured()) return res.status(503).json({ error: 'This PC is not connected to the online server yet.' })
    if (change && !(await permsFor(db, req)).perms.change_settings) return res.status(403).json({ error: 'Your role cannot change settings. Ask the admin.', forbidden: 'change_settings' })
    res.json(await fn(req, db))
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message })
  }
}

router.get('/branch-links', wrap((req, db) => B.state(db)))
router.get('/branch-links/search', wrap((req, db) => B.search(db, req.query.q)))
router.get('/branch-links/:agency/profiles', wrap((req, db) => B.profiles(db, req.params.agency, { fresh: req.query.fresh === '1' })))
router.post('/branch-links/city', wrap((req, db) => B.setCity(db, req.body?.city), { change: true }))
router.post('/branch-links/connect', wrap((req, db) => B.ask(db, req.body?.agency_id), { change: true }))
router.post('/branch-links/requests/:id/yes', wrap((req, db) => B.yes(db, req.params.id), { change: true }))
router.post('/branch-links/requests/:id/no', wrap((req, db) => B.no(db, req.params.id), { change: true }))
router.post('/branch-links/requests/:id/verify', wrap((req, db) => B.verify(db, req.params.id, req.body?.code), { change: true }))
router.post('/branch-links/:agency/share', wrap((req, db) => B.share(db, req.params.agency, req.body?.on), { change: true }))
router.post('/branch-links/:agency/unlink', wrap((req, db) => B.unlink(db, req.params.agency), { change: true }))

export default router
