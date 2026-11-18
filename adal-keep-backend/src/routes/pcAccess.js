/**
 * /api/pc-access — another computer asks to open this PC's Adal Keep, and this
 * PC answers (services/networkGate.js).
 *   POST /pc-access/number {number} the main PC's number: in at once (no approval)
 *   GET  /pc-access/status          waiting · approved · denied · removed
 *   GET  /pc-access/pending         (this PC only) who is asking
 *   POST /pc-access/answer {id,yes} (this PC only) Yes / No
 *   GET  /pc-access/list            (this PC only) the computers allowed
 *   DELETE /pc-access/:id           (this PC only) take one off the list
 *   POST /pc-access/online-copy      (a computer let in) its own online account
 *   POST /pc-access/leave {device}   (a computer let in) an Adal Companion signs out of this PC
 */
import express from 'express'
import bcrypt from 'bcryptjs'
import { isLocal, admitSignedIn, statusOf, pending, answer, list, remove, setKeyCookie } from '../services/networkGate.js'

const router = express.Router()
const here = (req, res, next) => isLocal(req) ? next() : res.status(403).json({ error: 'Only on the main PC itself' })

// Asking for a "Yes" is gone: nobody at the main PC approves computers any more.
// The other computer types the main PC's number instead (/pc-access/number).
router.post('/pc-access/request', (req, res) =>
  res.status(410).json({ error: "Type the main PC's number (5 digits, in its Settings) — no approval is needed" }))
// The same account as this PC (owner or employee): in at once, no "Yes" needed.
// At most 5 tries in 10 minutes per address (no guessing passwords).
const tries = new Map()
router.post('/pc-access/signin', async (req, res) => {
  const ip = String(req.socket?.remoteAddress || '')
  const now = Date.now()
  const recent = (tries.get(ip) || []).filter(t => now - t < 10 * 60000)
  if (recent.length >= 5) return res.status(429).json({ error: 'Too many tries — wait 10 minutes' })
  const username = String(req.body?.username || '').trim(), password = String(req.body?.password || '')
  if (!username || !password) return res.status(400).json({ error: 'Type the username and password of this Adal Keep' })
  try {
    const db = req.app.locals.db
    const user = await db('users').whereRaw('LOWER(username) = ?', [username.toLowerCase()]).orWhere('phone_work', username).first()
    if (!user?.password || !(await bcrypt.compare(password, user.password))) {
      tries.set(ip, [...recent, now])
      return res.status(401).json({ error: 'That username or password is not right for the main PC' })
    }
    const r = admitSignedIn(req, req.body?.name, user.username)
    setKeyCookie(res, r.key)
    console.log(`[pc-access] ${String(req.body?.name || 'A computer').slice(0, 60)} came in with ${user.username}'s account`)
    res.json({ ok: true, id: r.id, key: r.key })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// The main PC's number (Settings, 5 digits — the one phones are added with): in at once.
// At most 10 wrong numbers in 10 minutes per address (no guessing).
const numberMisses = new Map()
router.post('/pc-access/number', async (req, res) => {
  const ip = String(req.socket?.remoteAddress || '')
  const now = Date.now()
  const recent = (numberMisses.get(ip) || []).filter(t => now - t < 10 * 60000)
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many wrong numbers — wait 10 minutes' })
  const number = String(req.body?.number || '').replace(/\D/g, '')
  if (!number) return res.status(400).json({ error: 'Type the main PC\'s number' })
  try {
    const { pcNumber, isFollower } = await import('../services/mainPC.js')
    if (isFollower()) return res.status(409).json({ error: 'This PC follows another main PC. Use the main PC\'s address.' })
    // The PC number (6 digits, the licence one shown on the main PC) — or the older 5-digit one.
    let licence = ''
    try { licence = (await import('../services/subscription.js')).pcNumber() } catch {}
    if (number !== licence && number !== pcNumber()) {
      numberMisses.set(ip, [...recent, now])
      return res.status(403).json({ error: 'That is not the main PC\'s number' })
    }
    numberMisses.delete(ip)
    const r = admitSignedIn(req, req.body?.name || 'Adal Companion PC', 'PC number')
    setKeyCookie(res, r.key)
    console.log(`[pc-access] ${String(req.body?.name || 'A Companion PC').slice(0, 60)} came in with the PC number`)
    res.json({ ok: true, id: r.id, key: r.key })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
/**
 * An Adal Companion PC (let in already) takes its own online account once:
 * from then on it opens the agency's online copy (Supabase + the documents in
 * Telegram) by itself whenever this PC is off or out of reach — anywhere.
 */
router.post('/pc-access/online-copy', async (req, res) => {
  if (!req.pcAccess && !isLocal(req)) return res.status(403).json({ error: 'Only a computer that is let in' })
  try {
    const { makeDevice, cloudOn } = await import('../services/cloudSync.js')
    if (!(await cloudOn(req.app.locals.db))) return res.status(409).json({ error: 'The online copy is off on the main PC' })
    const { pcNumber } = await import('../services/mainPC.js')
    const name = `Companion · ${String(req.pcAccess?.name || req.body?.name || 'PC').slice(0, 40)}`
    res.json({ number: pcNumber(), cloud: await makeDevice(req.app.locals.db, name) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
/**
 * An Adal Companion signs out of this main PC ("Log out of this main PC /
 * Connect to another PC"): its key on this PC's list (when it came in with
 * one) and the online account this PC made for it (POST /online-copy) stop
 * working. Only that Companion's own: the account must be one this PC made
 * for a Companion ("Companion · …"), never a phone's.
 */
router.post('/pc-access/leave', async (req, res) => {
  if (!req.pcAccess && !isLocal(req)) return res.status(403).json({ error: 'Only a computer that is let in' })
  const out = { key: false, device: false }
  try {
    if (req.pcAccess?.id && req.pcAccess.id !== 'own-network') { remove(req.pcAccess.id); out.key = true }
    const device = String(req.body?.device || '')
    if (/^[0-9a-f-]{36}$/i.test(device)) {
      const { cloudOn, listDevices, setDeviceRevoked } = await import('../services/cloudSync.js')
      if (await cloudOn(req.app.locals.db)) {
        const d = ((await listDevices(req.app.locals.db)) || []).find(x => x.user_id === device)
        if (d && /^Companion ·/.test(d.name || '')) {
          if (!d.revoked) await setDeviceRevoked(req.app.locals.db, device, true)
          out.device = true
        }
      }
    }
    console.log(`[pc-access] an Adal Companion (${String(req.pcAccess?.name || 'this PC').slice(0, 60)}) signed out${out.key ? ' · key removed' : ''}${out.device ? ' · its online account stopped' : ''}`)
    res.json({ ok: true, ...out })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/pc-access/status', (req, res) => res.json(isLocal(req) ? { state: 'approved', here: true } : statusOf(req)))
router.get('/pc-access/pending', here, (req, res) => res.json(pending()))
router.post('/pc-access/answer', here, (req, res) => { try { answer(String(req.body?.id || ''), !!req.body?.yes); res.json({ ok: true }) } catch (e) { res.status(404).json({ error: e.message }) } })
router.get('/pc-access/list', here, (req, res) => res.json(list()))
router.delete('/pc-access/:id', here, (req, res) => { remove(req.params.id); res.json({ ok: true }) })

export default router
