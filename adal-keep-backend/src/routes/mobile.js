/**
 * /api/mobile — the phone app (adal-phone).
 *   POST /mobile/pair {number}  the phone found this PC on the Wi-Fi and asks
 *                               "are you PC <number>?" → this PC's addresses
 *                               (Wi-Fi and Tailscale) when the number is right
 *   GET  /mobile/ping           "is the PC there?" (the app's start-up check)
 * Only the main PC pairs; wrong numbers are counted per phone and slowed down.
 */
import express from 'express'
import { pcNumber, isFollower, tailscaleInfo } from '../services/mainPC.js'
import { getLanAddresses } from '../services/discovery.js'

const router = express.Router()
const misses = new Map()   // ip → [times of wrong numbers]

router.get('/mobile/ping', (req, res) => res.json({ ok: true, app: 'adal-keep', main: !isFollower() }))

router.post('/mobile/pair', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '?'
  const now = Date.now()
  const recent = (misses.get(ip) || []).filter(t => now - t < 10 * 60 * 1000)
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many wrong numbers. Wait 10 minutes.' })
  if (isFollower()) return res.status(409).json({ error: 'This PC follows another main PC. Pair with the main PC.' })
  const number = String(req.body?.number || '').replace(/\D/g, '')
  if (number !== pcNumber()) {
    misses.set(ip, [...recent, now])
    return res.status(403).json({ error: 'That is not this PC\'s number.' })
  }
  misses.delete(ip)
  const port = Number(process.env.PORT) || 4000
  const ts = await tailscaleInfo().catch(() => ({}))
  let company = null
  try { company = (await req.app.locals.db('companies').first('name'))?.name || null } catch {}
  res.json({
    ok: true,
    name: company || 'Adal Keep',
    lan: getLanAddresses().filter(a => !a.startsWith('100.')).map(a => `http://${a}:${port}`),
    tailscale: ts?.ip ? `http://${ts.ip}:${port}` : null,
  })
})

export default router
