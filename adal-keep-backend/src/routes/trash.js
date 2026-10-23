/**
 * /api/trash — only on the main PC itself (a browser on this PC: localhost).
 * Other PCs and phones never see what was deleted.
 */
import express from 'express'
import { restore, purge } from '../services/trash.js'
import { isFollower } from '../services/mainPC.js'

const router = express.Router()

/**
 * A browser on this very PC. A request that came through a proxy (like
 * `tailscale serve` giving phones https) also arrives from 127.0.0.1, so any
 * forwarding header means it came from somewhere else.
 */
export function onThisPC(req) {
  const ip = String(req.socket?.remoteAddress || '')
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  const forwarded = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'tailscale-headers-info']
    .some(h => req.headers?.[h] !== undefined)
  return local && !forwarded
}

router.use('/trash', (req, res, next) => {
  if (!onThisPC(req)) return res.status(403).json({ error: 'The Trash opens only on the main PC itself.' })
  if (isFollower()) return res.status(403).json({ error: 'This PC is not the main PC. The Trash is on the main PC.' })
  next()
})

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
