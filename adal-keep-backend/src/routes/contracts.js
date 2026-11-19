/**
 * /api/contracts — the Musaned contract check (who was chosen by an employer).
 *   POST /contracts/check {profile_id?}  look now (one profile, or all on Musaned)
 *   POST /contracts/scan                 the whole Musaned list: who is newly chosen
 *                                        (Check now: on this main PC, 10-minute limit)
 *   POST /contracts/cancel               stop the check that is on
 *   GET  /contracts/check                the last look (+ who checks, when next)
 *
 * /api/selection-check — the hourly check's turn between this agency's PCs
 * (services/selectionCheck.js): a Companion says it is here, and reads
 * Musaned step by step while it holds the lease.
 */
import express from 'express'
import { checkContracts, contractCheck } from '../services/musanedContracts.js'
import { checkNow, cancelNow, checkInfo, hello, nextStep, answerStep } from '../services/selectionCheck.js'
import { isFollower } from '../services/mainPC.js'

const router = express.Router()

router.post('/contracts/check', async (req, res) => {
  const db = req.app.locals.db
  if (contractCheck.running) return res.json({ busy: true, ...contractCheck })
  const onlyId = req.body?.profile_id ? Number(req.body.profile_id) : null
  if (onlyId) {
    try { return res.json(await checkContracts(db, { onlyId })) } catch (e) { return res.status(500).json({ error: e.message }) }
  }
  checkContracts(db).catch(e => console.warn('[contracts] failed:', e.message))
  res.json({ started: true })
})
router.post('/contracts/scan', async (req, res) => {
  try {
    const r = await checkNow(req.app.locals.db)
    res.json(r.busy ? { ...contractCheck, ...r } : r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/contracts/cancel', async (req, res) => res.json(await cancelNow()))
router.get('/contracts/check', (req, res) => res.json({ ...contractCheck, ...checkInfo() }))

// Only the main PC hands out the turn.
router.use('/selection-check', (req, res, next) => isFollower() ? res.status(409).json({ error: 'This PC is not the main PC' }) : next())
router.post('/selection-check/hello', (req, res) => res.json(hello(req.body || {})))
router.post('/selection-check/remote/next', async (req, res) => res.json(await nextStep(String(req.body?.token || ''))))
router.post('/selection-check/remote/answer', (req, res) => res.json(answerStep(String(req.body?.token || ''), req.body || {})))

export default router
