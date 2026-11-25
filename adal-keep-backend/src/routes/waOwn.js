/** Own WhatsApp on each PC (services/waOwn.js, behind a switch) and a Companion's line to the main PC (pcLink.js). */
import express from 'express'
import { isLocal } from '../services/networkGate.js'
import { notMainPC } from '../services/mainPC.js'
import { ownOn, setOwn, neverHere, helperReady } from '../services/waOwn.js'
import { stateFor, connectFor, logoutFor } from '../services/waOwnHere.js'
import { open, answer, takeFile } from '../services/pcLink.js'

const router = express.Router()
const bad = (res, e) => res.status(e?.status || 400).json({ error: String(e?.message || e) })
// The switch is the owner's, on the main PC itself (never from a phone or another PC).
const mayChange = (req) => isLocal(req) && !req.headers['x-adal-cloud'] && !notMainPC()

router.get('/whatsapp/own', async (req, res) => {
  try {
    const on = await ownOn(req.app.locals.db)
    res.json({ on, never: neverHere(), may_change: mayChange(req), ...(on ? await stateFor(req, req.app.locals.db).catch(e => ({ status: 'off', own: true, error: e.message })) : { status: 'off', installed: helperReady() }) })
  } catch (e) { bad(res, e) }
})
router.post('/whatsapp/own/switch', async (req, res) => {
  if (!mayChange(req)) return res.status(403).json({ error: 'Only on the main PC itself' })
  try {
    if (req.body?.on) (await import('../services/plans.js')).needFeature('whatsapp')
    res.json({ on: await setOwn(req.app.locals.db, !!req.body?.on) })
  } catch (e) { bad(res, e) }
})
// Not from the phone's relay: signing in is done at the PC, with its own screen.
router.post('/whatsapp/own/:what(connect|logout)', async (req, res) => {
  if (req.headers['x-adal-cloud']) return res.status(403).json({ error: 'Sign in on the computer itself' })
  try { res.json(await (req.params.what === 'connect' ? connectFor(req, req.app.locals.db) : logoutFor(req))) } catch (e) { bad(res, e) }
})

router.get('/pc-link/stream', (req, res) => (isLocal(req) || neverHere() ? res.status(403).end() : open(req, res)))
router.post('/pc-link/answer', (req, res) => answer(req, res))
router.get('/pc-link/file/:token', (req, res) => takeFile(req, res))

export default router
