/**
 * The run claims across the agency's PCs (services/runClaims.js): who is doing which
 * girl and site now. GET /api/run-claims → [{ key, profile_id, workflow_id, run_id, pc_id, pc_name, since, via, here }].
 * Adal Robots (its own process, no sync of its own) asks this server, on this PC only:
 *   POST /api/run-claims/claim   { job }          → claimRun's answer ({ ok, via } | { ok: false, by, why })
 *   POST /api/run-claims/release { job, result }  → { ok: true }
 */
import express from 'express'
import { runClaimsNow, claimsOn, claimRun, releaseRun } from '../services/runClaims.js'
import { isLocal } from '../services/networkGate.js'

const router = express.Router()
const here = (req, res, next) => isLocal(req) && !req.headers['x-adal-cloud'] && !req.headers['x-forwarded-for'] ? next() : res.status(403).json({ error: 'Only on this PC itself' })
const jobOf = (b) => ({ id: b?.job?.id, profile_id: b?.job?.profile_id, workflow_id: b?.job?.workflow_id })
router.get('/run-claims', (req, res) => res.json(claimsOn() ? runClaimsNow() : []))
router.post('/run-claims/claim', here, async (req, res) => {
  const job = jobOf(req.body)
  if (!job.id || job.profile_id == null || !job.workflow_id) return res.status(400).json({ error: 'job { id, profile_id, workflow_id } needed' })
  res.json(await claimRun(req.app.locals.db, job))
})
router.post('/run-claims/release', here, async (req, res) => {
  const job = jobOf(req.body)
  if (!job.id) return res.status(400).json({ error: 'job { id, profile_id, workflow_id } needed' })
  await releaseRun(req.app.locals.db, job, String(req.body?.result || 'done'))
  res.json({ ok: true })
})
export default router
