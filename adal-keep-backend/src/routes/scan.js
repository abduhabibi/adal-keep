/**
 * /api/scan — the scanner on this PC (services/scanner.js). A person's click starts a scan; a
 * Companion's click is passed to the main PC by mainProxy.js (the scanner is there), through the
 * same signed-in route as everything else, so only a PC that was let in can scan.
 *   GET  /scan/status        which scanner, or why there is none
 *   POST /scan/start         { dpi: 150|200|300|600, gray } → { id } (409 'busy' while another scan runs)
 *   GET  /scan/:id           { state: scanning | done | error, error: { code, message } }
 *   GET  /scan/:id/image     the JPEG, once
 *   POST /scan/cancel
 */
import express from 'express'
import { makeScanner, listPrinters } from '../services/scanner.js'

export const scanner = makeScanner({ printers: listPrinters })
const router = express.Router()

router.get('/scan/status', async (req, res) => res.json(await scanner.status()))
router.post('/scan/start', (req, res) => {
  const r = scanner.start({ dpi: req.body?.dpi, gray: !!req.body?.gray })
  if (r.error) return res.status(r.error.code === 'busy' ? 409 : 400).json(r.error)
  res.json(r)
})
router.post('/scan/cancel', (req, res) => res.json({ cancelled: scanner.cancel() }))
router.get('/scan/:id', (req, res) => {
  const s = scanner.scanStatus(req.params.id)
  s ? res.json(s) : res.status(404).json({ code: 'gone', message: 'This scan is no longer here — scan again.' })
})
router.get('/scan/:id/image', (req, res) => {
  const jpeg = scanner.take(req.params.id)
  if (!jpeg) return res.status(404).json({ code: 'gone', message: 'This scan is no longer here — scan again.' })
  res.set('Cache-Control', 'no-store').type('image/jpeg').send(jpeg)
})
export default router
