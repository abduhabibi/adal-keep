/**
 * /api/run-queue — the runs waiting to start, and moving them in the line.
 *   GET  /run-queue                 waiting runs (pending in start order, then paused)
 *   POST /run-queue/:id/up|down|next
 * Pause and cancel of a waiting run: POST /automations/:id/pause | /cancel (automations.js).
 */
import express from 'express'
import { waiting, move } from '../services/runPriority.js'

const router = express.Router()

router.get('/run-queue', async (req, res) => {
  try { res.json(await waiting(req.app.locals.db)) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/run-queue/:id/:how(up|down|next)', async (req, res) => {
  const db = req.app.locals.db
  try {
    await move(db, req.params.id, req.params.how)
    res.json({ ok: true, line: await waiting(db) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
