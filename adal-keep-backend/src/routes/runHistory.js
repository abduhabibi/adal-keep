/**
 * /api/run-history — what the robots did in the last 30 days.
 *   GET /run-history?site=&outcome=&employee=&pc=&profile_id=&from=&to=&q=&limit=&offset=
 *   GET /run-history/choices        the sites, people and PCs to filter by
 *   GET /run-history/:id/shot       the picture of the tab taken at the stop (JPEG)
 *   POST /run-history/delete {ids, running_ok}   rows go; a running one only with running_ok (409 says which)
 *   DELETE /run-history/:id?running_ok=1         one row
 */
import express from 'express'
import { list, choices, shotOf, remove } from '../services/runHistory.js'

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

async function del(req, res, ids, runningOk) {
  try {
    const r = await remove(req.app.locals.db, ids, { running_ok: runningOk })
    if (r.running.length) return res.status(409).json({ error: 'A robot is still working on this one', running: r.running })
    res.json({ ok: true, deleted: r.deleted })
  } catch (e) { res.status(500).json({ error: e.message }) }
}
router.post('/run-history/delete', (req, res) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Which rows?' })
  del(req, res, ids, req.body?.running_ok === true)
})
router.delete('/run-history/:id', (req, res) => del(req, res, [req.params.id], req.query.running_ok === '1'))

export default router
