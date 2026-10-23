/**
 * /api/trash — only on the main PC itself (a browser on this PC: localhost).
 * Other PCs and phones never see what was deleted.
 */
import express from 'express'
import { restore, purge } from '../services/trash.js'

const router = express.Router()

export function onThisPC(req) {
  const ip = String(req.socket?.remoteAddress || '')
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

router.use('/trash', (req, res, next) => (onThisPC(req)
  ? next()
  : res.status(403).json({ error: 'The Trash opens only on the main PC itself.' })))

router.get('/trash', async (req, res) => {
  try {
    const rows = await req.app.locals.db('trash')
      .select('id', 'kind', 'item_id', 'title', 'deleted_by', 'deleted_from', 'deleted_at', 'files')
      .orderBy('id', 'desc').limit(1000)
    res.json(rows.map(r => ({ ...r, files: JSON.parse(r.files || '[]').length })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/trash/:id/restore', async (req, res) => {
  try { res.json(await restore(req.app.locals.db, Number(req.params.id))) } catch (e) { res.status(400).json({ error: e.message }) }
})
router.post('/trash/:id/purge', async (req, res) => {
  try { res.json(await purge(req.app.locals.db, Number(req.params.id))) } catch (e) { res.status(400).json({ error: e.message }) }
})
router.post('/trash/empty', async (req, res) => {
  try {
    const db = req.app.locals.db
    const ids = (await db('trash').select('id')).map(r => r.id)
    for (const id of ids) await purge(db, id)
    res.json({ ok: true, removed: ids.length })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
