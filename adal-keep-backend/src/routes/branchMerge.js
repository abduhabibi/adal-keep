/**
 * /api/branch — merge another branch's Adal Keep into this main PC.
 *   GET  /branch/export                 (branch PC) everything it has
 *   GET  /branch/export/file/:id        (branch PC) one document
 *   GET  /branch/export/photo/:id/:col  (branch PC) one profile photo
 *   POST /branch/preview {source}       (main PC)   what a merge would do
 *   POST /branch/merge   {source}       (main PC)   start it
 *   GET  /branch/merge                  (main PC)   its progress
 * Preview and merge work only from a browser on the main PC itself.
 */
import express from 'express'
import { exportAll, exportFilePath, exportPhotoPath, preview, startMerge, job } from '../services/branchMerge.js'
import { normalizeURL, isFollower } from '../services/mainPC.js'
import { onThisPC } from './trash.js'

const router = express.Router()

router.get('/branch/export', async (req, res) => {
  try { res.json(await exportAll(req.app.locals.db)) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/branch/export/file/:id', async (req, res) => {
  const abs = await exportFilePath(req.app.locals.db, req.params.id).catch(() => null)
  abs ? res.sendFile(abs) : res.status(404).json({ error: 'not found' })
})
router.get('/branch/export/photo/:id/:col', async (req, res) => {
  const abs = await exportPhotoPath(req.app.locals.db, req.params.id, req.params.col).catch(() => null)
  abs ? res.sendFile(abs) : res.status(404).json({ error: 'not found' })
})

function onMain(req, res) {
  if (!onThisPC(req)) { res.status(403).json({ error: 'Merge branches on the main PC itself.' }); return false }
  if (isFollower()) { res.status(403).json({ error: 'This PC follows another main PC. Merge on the main PC.' }); return false }
  return true
}
const sourceOf = (req) => {
  const u = normalizeURL(req.body?.source)
  if (!u) throw new Error('Type the branch PC address.')
  return u
}

router.post('/branch/preview', async (req, res) => {
  if (!onMain(req, res)) return
  try { res.json(await preview(req.app.locals.db, sourceOf(req))) } catch (e) { res.status(400).json({ error: e.message }) }
})
router.post('/branch/merge', (req, res) => {
  if (!onMain(req, res)) return
  try { res.json(startMerge(req.app.locals.db, sourceOf(req))) } catch (e) { res.status(400).json({ error: e.message }) }
})
router.get('/branch/merge', (req, res) => res.json(job))

export default router
