/** GET /api/system/hardware — this PC's cores, RAM, 32/64-bit, network link and whether it is below 4 cores / 8 GB (services/hardware.js). */
import express from 'express'
import { hardwareNow, robotsBlocked, MIN_CORES, MIN_RAM_GB } from '../services/hardware.js'

const router = express.Router()
router.get('/hardware', (req, res) => {
  const hw = hardwareNow()
  res.json({ ...hw, min_cores: MIN_CORES, min_ram_gb: MIN_RAM_GB, robots_blocked: robotsBlocked(hw) })
})
export default router
