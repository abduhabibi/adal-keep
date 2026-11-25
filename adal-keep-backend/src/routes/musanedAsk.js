/**
 * "Make Musaned": may it be asked, and its start guarded (services/musanedAsk.js).
 * Mounted before the robots' routes; the start itself stays theirs.
 */
import express from 'express'
import { askOn, askState, already, claim, claimHere } from '../services/musanedAsk.js'

const router = express.Router()

router.get('/profiles/:id/musaned-state', async (req, res) => {
  if (!askOn()) return res.status(404).json({ error: 'off' })
  try {
    const s = await askState(req.app.locals.db, req.params.id)
    if (!s) return res.status(404).json({ error: 'Profile not found' })
    res.json(s)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Another PC of the agency is about to start it: the first one gets it.
router.post('/profiles/:id/musaned-claim', async (req, res) => {
  if (!askOn()) return res.status(404).json({ error: 'off' })
  try { res.json(await claimHere(req.app.locals.db, req.params.id, { release: req.body?.release === true })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/profiles/:id/automations/musaned_add_candidate/start', async (req, res, next) => {
  const b = req.body || {}
  if (!askOn() || b.check || b.anyStep || b.force) return next()
  let reply = null
  try {
    const db = req.app.locals.db, id = Number(req.params.id)
    const s = await askState(db, id)
    if (s && !s.ask) {
      // The pop-up never starts or wakes it. A person's own button (AI Actions) keeps resuming a run that is here.
      const here = await db('automation_queue').where({ profile_id: id, workflow_id: 'musaned_add_candidate' }).whereIn('status', ['running', 'paused', 'pending']).first('id')
      if (b.popup || (!here && ['queued', 'working', 'waiting'].includes(s.state))) reply = already(s)
    } else if (s) {
      const c = await claim(db, id)
      if (c && !c.ask) reply = already(c)
      // Refused after all (something missing): the next try is not told "already started".
      else if (c) res.on('finish', () => { if (res.statusCode >= 400) claim(db, id, { release: true }).catch(() => {}) })
    }
  } catch (e) { console.warn('[musaned-ask]', e.message) }
  if (reply) return res.json(reply)
  next()
})

export default router
