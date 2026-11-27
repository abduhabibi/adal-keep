/**
 * The run claims across the agency's PCs (services/runClaims.js): who is doing which
 * girl and site now. GET /api/run-claims → [{ key, profile_id, workflow_id, run_id, pc_id, pc_name, since, via, here }].
 * (Adal Robots claims and releases through Yusuf's services/claimBridge.js: this PC only, its token.)
 */
import express from 'express'
import { runClaimsNow, claimsOn } from '../services/runClaims.js'

const router = express.Router()
router.get('/run-claims', (req, res) => res.json(claimsOn() ? runClaimsNow() : []))
export default router
