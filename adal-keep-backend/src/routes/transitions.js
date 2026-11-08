/** Settings → Transitions: bring an agency's data over from the system it used before. */
import express from 'express'
import { transitionStates, startTransition, stopTransition, showTransition, checkLink } from '../services/transition.js'

const router = express.Router()

router.get('/transitions', (req, res) => res.json(transitionStates()))

router.post('/transitions/:source/start', async (req, res) => {
  try {
    const link = req.params.source === 'pextran' ? checkLink(req.body?.link) : null
    const accountId = Number(req.body?.account_id) || null
    res.json(startTransition(req.app.locals.db, req.params.source, link, accountId ? { accountId } : {}))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/transitions/:source/stop', (req, res) => {
  stopTransition(req.params.source)
  res.json(transitionStates())
})

router.post('/transitions/:source/show', async (req, res) => {
  await showTransition(req.params.source).catch(() => {})
  res.json({ ok: true })
})

export default router
