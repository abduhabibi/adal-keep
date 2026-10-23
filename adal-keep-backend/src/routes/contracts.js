/**
 * /api/contracts — the Musaned contract check (who was chosen by an employer).
 *   POST /contracts/check {profile_id?}  look now (one profile, or all on Musaned)
 *   GET  /contracts/check                the last look
 */
import express from 'express'
import { checkContracts, contractCheck } from '../services/musanedContracts.js'

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
router.get('/contracts/check', (req, res) => res.json(contractCheck))

export default router
