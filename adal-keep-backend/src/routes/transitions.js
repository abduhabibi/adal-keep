/** Settings → Transitions: bring an agency's data over from the system it used before. */
import express from 'express'
import { transitionStates, startTransition, stopTransition, showTransition, checkLink, filesWaiting, prioritize } from '../services/transition.js'
import { needFeature } from '../services/plans.js'

const router = express.Router()

// The Pextran address used last time, kept on this PC: the box shows it again (any device).
const LINK_KEY = 'transition_pextran_link'
router.get('/transitions', async (req, res) => {
  const st = transitionStates()
  try { const row = await req.app.locals.db('settings').where({ key: LINK_KEY }).first(); if (st.pextran && row?.value) st.pextran.link = row.value } catch {}
  res.json(st)
})

router.post('/transitions/:source/start', async (req, res) => {
  try {
    needFeature('moves')
    const link = req.params.source === 'pextran' ? checkLink(req.body?.link) : null
    if (link) {
      const db = req.app.locals.db, typed = String(req.body.link).trim()
      if (await db('settings').where({ key: LINK_KEY }).first()) await db('settings').where({ key: LINK_KEY }).update({ value: typed })
      else await db('settings').insert({ key: LINK_KEY, value: typed })
    }
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

// Profiles a running move saved whose files have not come yet (their Prioritize button).
// Girls whose files have not come: in a running move, or accepted from another agency.
router.get('/transitions/waiting-files', async (req, res) => {
  const share = await import('../services/profileShare.js').then(m => m.shareFilesWaiting()).catch(() => [])
  res.json({ profileIds: [...new Set([...filesWaiting(), ...share])] })
})
// Her record and files next, before everyone else.
router.post('/transitions/prioritize/:profileId', async (req, res) => {
  if (!prioritize(req.params.profileId)) {
    const share = await import('../services/profileShare.js').catch(() => null)
    if (!share?.sharePrioritize(req.params.profileId)) return res.status(404).json({ error: 'Her files are not waiting any more (they may have come already)' })
  }
  res.json({ ok: true })
})
