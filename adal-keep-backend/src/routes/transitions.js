/** Settings → Transitions: bring an agency's data over from the system it used before. */
import express from 'express'
import { transitionStates, startTransition, stopTransition, showTransition, checkLink } from '../services/transition.js'
import { needFeature } from '../services/plans.js'

const router = express.Router()

router.get('/transitions', (req, res) => res.json(transitionStates()))

router.post('/transitions/:source/start', async (req, res) => {
  try {
    needFeature('moves')
    const link = req.params.source === 'pextran' ? checkLink(req.body?.link) : null
    const accountId = Number(req.body?.account_id) || null
    const limit = Math.max(0, Math.min(1000, Number(req.body?.limit) || 0)) || undefined
    res.json(startTransition(req.app.locals.db, req.params.source, link, { ...(accountId ? { accountId } : {}), ...(limit ? { limit } : {}) }))
  } catch (e) { res.status(e.status || 400).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
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
