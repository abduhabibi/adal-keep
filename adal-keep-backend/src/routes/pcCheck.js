/** GET /api/system/pc-check — Settings → This PC: what is OK, what is weak and the fix (services/pcCheck.js). ?fresh=1 measures again. */
import express from 'express'
import { pcCheck } from '../services/pcCheck.js'

const router = express.Router()
router.get('/pc-check', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await pcCheck({ fresh: req.query.fresh === '1' })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
export default router
