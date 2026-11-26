/**
 * The Paste button's help from this PC (services/clipboardRead.js).
 *   GET /api/app/paste        { on, here }  — here: this window is on this PC (its clipboard can be read)
 *   GET /api/app/clipboard    the copied files / picture, only for a window on this PC itself
 */
import express from 'express'
import { isLocal } from '../services/networkGate.js'
import { readClipboard, pasteOn } from '../services/clipboardRead.js'

export default function clipboardRouter({ read = readClipboard } = {}) {
  const router = express.Router()
  router.get('/app/paste', (req, res) => res.set('Cache-Control', 'no-store').json({ on: pasteOn(), here: isLocal(req) && process.platform === 'win32' }))
  router.get('/app/clipboard', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    if (!pasteOn()) return res.status(404).json({ error: 'The Paste button is turned off on this PC.' })
    // Never another PC's clipboard: only a window on this PC asks for this one's.
    if (!isLocal(req)) return res.status(403).json({ error: 'This PC can only read its own clipboard.', code: 'not-here' })
    try {
      const r = await read()
      if (r.kind !== 'files') return res.json({ kind: r.kind, refused: r.refused || [] })
      res.json({ kind: 'files', refused: r.refused, files: r.files.map(f => ({ name: f.name, type: f.type, data: f.data.toString('base64') })) })
    } catch (e) { res.status(503).json({ error: e.message }) }
  })
  return router
}
