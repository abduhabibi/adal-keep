/**
 * /api/mobile — the phone app (adal-phone).
 *   POST /mobile/pair {number}  the phone found this PC on the Wi-Fi and asks
 *                               "are you PC <number>?" → this PC's addresses
 *                               (Wi-Fi and Tailscale) when the number is right
 *   GET  /mobile/ping           "is the PC there?" (the app's start-up check)
 *   GET  /mobile/app(.apk)      the newest phone app (the app updates itself from it)
 *   GET  /mobile/cloud          the online copy for phones: state + paired phones
 * Only the main PC pairs; wrong numbers are counted per phone and slowed down.
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pcNumber, isFollower, tailscaleInfo } from '../services/mainPC.js'
import { getLanAddresses } from '../services/discovery.js'
import { cloudOn, cloudStatus, makeDevice, listDevices, setDeviceRevoked, syncNow } from '../services/cloudSync.js'
import { onThisPC } from './trash.js'

const router = express.Router()
const misses = new Map()   // ip → [times of wrong numbers]

// The newest phone app this PC hands out (src/phone-app, updated with the PC).
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'phone-app')
router.get('/mobile/app', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'version.json'), 'utf8'))) }
  catch { res.status(404).json({ error: 'No phone app on this PC' }) }
})
router.get('/mobile/app.apk', (req, res) => {
  const f = path.join(APP_DIR, 'AdalKeep.apk')
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No phone app on this PC' })
  res.download(f, 'Adal Keep.apk', { headers: { 'Content-Type': 'application/vnd.android.package-archive' } })
})

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
  // The phone's own online account: it works from the online copy when this PC is off.
  let cloud = null
  // (A phone that already has one sends no device name: no second account.)
  if (req.body?.device && await cloudOn(req.app.locals.db).catch(() => false)) {
    try { cloud = await makeDevice(req.app.locals.db, String(req.body.device).slice(0, 60)) }
    catch (e) { console.warn('[mobile] online account for the phone:', e.message) }
  }
  res.json({
    ok: true,
    cloud,
    name: company || 'Adal Keep',
    lan: getLanAddresses().filter(a => !a.startsWith('100.')).map(a => `http://${a}:${port}`),
    tailscale: ts?.ip ? `http://${ts.ip}:${port}` : null,
  })
})

// Settings → phones: the online copy's state, the paired phones, remove a phone.
router.get('/mobile/cloud', async (req, res) => {
  const db = req.app.locals.db
  let devices = []
  let error = cloudStatus.error
  try { if (await cloudOn(db)) devices = await listDevices(db) } catch (e) { error = error || e.message }
  res.json({ ...cloudStatus, on: await cloudOn(db).catch(() => false), devices, error })
})
router.post('/mobile/cloud/sync', async (req, res) => {
  syncNow(req.app.locals.db).catch(() => {})
  res.json({ ok: true })
})
router.post('/mobile/devices/:id/revoke', async (req, res) => {
  if (!onThisPC(req)) return res.status(403).json({ error: 'Remove phones on the main PC itself.' })
  try { await setDeviceRevoked(req.app.locals.db, req.params.id, req.body?.revoked !== false); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
