import { Router } from 'express'
import { startAgent, stopAgent, getAgentStatus } from '../services/braveAgent.js'

const router = Router()

router.get('/status', (req, res) => {
  res.json(getAgentStatus())
})

router.post('/start', async (req, res) => {
  try {
    const { profileId, openPextran = true } = req.body || {}
    const result = await startAgent({
      db: req.app.locals.db,
      profileId,
      openPextran
    })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

router.post('/stop', async (req, res) => {
  try {
    const result = await stopAgent()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
