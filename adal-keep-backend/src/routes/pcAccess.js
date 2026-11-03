/**
 * /api/pc-access — another computer asks to open this PC's Adal Keep, and this
 * PC answers (services/networkGate.js).
 *   POST /pc-access/request {name}  ask (gets its key: a cookie, and in the answer)
 *   GET  /pc-access/status          waiting · approved · denied · removed
 *   GET  /pc-access/pending         (this PC only) who is asking
 *   POST /pc-access/answer {id,yes} (this PC only) Yes / No
 *   GET  /pc-access/list            (this PC only) the computers allowed
 *   DELETE /pc-access/:id           (this PC only) take one off the list
 */
import express from 'express'
import { isLocal, requestAccess, statusOf, pending, answer, list, remove, setKeyCookie } from '../services/networkGate.js'

const router = express.Router()
const asks = new Map() // ip → times: at most 5 asks in 10 minutes
const here = (req, res, next) => isLocal(req) ? next() : res.status(403).json({ error: 'Only on the main PC itself' })

router.post('/pc-access/request', (req, res) => {
  const ip = String(req.socket?.remoteAddress || '')
  const now = Date.now()
  const recent = (asks.get(ip) || []).filter(t => now - t < 10 * 60000)
  if (recent.length >= 5) return res.status(429).json({ error: 'Asked too often — wait 10 minutes' })
  asks.set(ip, [...recent, now])
  const r = requestAccess(req, req.body?.name)
  setKeyCookie(res, r.key)
  res.json({ ok: true, id: r.id, key: r.key })
})
router.get('/pc-access/status', (req, res) => res.json(isLocal(req) ? { state: 'approved', here: true } : statusOf(req)))
router.get('/pc-access/pending', here, (req, res) => res.json(pending()))
router.post('/pc-access/answer', here, (req, res) => { try { answer(String(req.body?.id || ''), !!req.body?.yes); res.json({ ok: true }) } catch (e) { res.status(404).json({ error: e.message }) } })
router.get('/pc-access/list', here, (req, res) => res.json(list()))
router.delete('/pc-access/:id', here, (req, res) => { remove(req.params.id); res.json({ ok: true }) })

export default router
