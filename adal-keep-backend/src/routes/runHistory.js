/**
 * /api/run-history — what the robots did in the last 30 days.
 *   GET /run-history?site=&outcome=&employee=&pc=&profile_id=&from=&to=&q=&limit=&offset=
 *   GET /run-history/choices        the sites, people and PCs to filter by
 *   GET /run-history/:id/shot       the picture of the tab taken at the stop (JPEG)
 */
import express from 'express'
import { list, choices, shotOf } from '../services/runHistory.js'

const router = express.Router()

router.get('/run-history', async (req, res) => {
  const db = req.app.locals.db
  try { res.json(await list(db, req.query)) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/run-history/choices', async (req, res) => {
  const db = req.app.locals.db
  try { res.json(await choices(db)) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/run-history/:id/shot', async (req, res) => {
  const db = req.app.locals.db
  try {
    const jpg = await shotOf(db, req.params.id)
    if (!jpg) return res.status(404).json({ error: 'No picture' })
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=86400').send(jpg)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
