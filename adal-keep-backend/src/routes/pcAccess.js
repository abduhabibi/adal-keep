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
 *   POST /pc-access/link {device}    (a computer let in) the online account its Companion uses
 *   GET  /pc-access/devices          (this PC only) every connected Companion and phone
 *   POST /pc-access/devices/suspend {pc?, device?, suspended} (this PC only) suspend / allow again
 */
import express from 'express'
import bcrypt from 'bcryptjs'
import { isLocal, admitSignedIn, statusOf, pending, answer, list, remove, setKeyCookie, isSuspended, setSuspended, linkDevice, keyOf, companionSuspended } from '../services/networkGate.js'

const router = express.Router()
// The main PC itself — not a call that came through the online link (a phone, a Companion: X-Adal-Cloud).
const here = (req, res, next) => isLocal(req) && !req.headers['x-adal-cloud'] ? next() : res.status(403).json({ error: 'Only on the main PC itself' })

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
/** The main PC's number: the 6-digit licence one or the 5-digit one in Settings. */
async function isOurNumber(number) {
  const { pcNumber } = await import('../services/mainPC.js')
  let licence = ''
  try { licence = (await import('../services/subscription.js')).pcNumber() } catch {}
  return !!number && (number === licence || number === pcNumber())
}
/**
 * Is this the main PC with that number? AdalKeep.exe on a Companion asks the
 * main PCs it finds on the network, to know which one to open (the window
 * then comes in with the same number). Lets nothing in; the same limit on wrong numbers.
 */
router.post('/pc-access/check-number', async (req, res) => {
  const ip = String(req.socket?.remoteAddress || '')
  const now = Date.now()
  const recent = (numberMisses.get(ip) || []).filter(t => now - t < 10 * 60000)
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many wrong numbers — wait 10 minutes' })
  try {
    const { notMainPC: isFollower } = await import('../services/mainPC.js')
    const ok = !isFollower() && await isOurNumber(String(req.body?.number || '').replace(/\D/g, ''))
    if (!ok) numberMisses.set(ip, [...recent, now])
    res.json({ ok })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/pc-access/number', async (req, res) => {
  const ip = String(req.socket?.remoteAddress || '')
  const now = Date.now()
  const recent = (numberMisses.get(ip) || []).filter(t => now - t < 10 * 60000)
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many wrong numbers — wait 10 minutes' })
  // A suspended computer cannot come back in by typing the number again.
  if (isSuspended(req)) return res.status(403).json({ error: 'This computer was suspended by the main PC', suspended: true })
  const number = String(req.body?.number || '').replace(/\D/g, '')
  if (!number) return res.status(400).json({ error: 'Type the main PC\'s number' })
  try {
    const { pcNumber, notMainPC: isFollower } = await import('../services/mainPC.js')
    if (isFollower()) return res.status(409).json({ error: 'This PC follows another main PC. Use the main PC\'s address.' })
    // The PC number (6 digits, the licence one shown on the main PC) — or the older 5-digit one.
    let licence = ''
    try { licence = (await import('../services/subscription.js')).pcNumber() } catch {}
    if (number !== licence && number !== pcNumber()) {
      numberMisses.set(ip, [...recent, now])
      return res.status(403).json({ error: 'That is not the main PC\'s number' })
    }
    numberMisses.delete(ip)
    // The same Companion again (its own id from AdalKeep.exe, or its online account): its place on the list.
    const who = { cid: String(req.body?.cid || '').slice(0, 128), device: String(req.body?.device || '') }
    if (companionSuspended(who)) return res.status(403).json({ error: 'This computer was suspended by the main PC', suspended: true })
    const r = admitSignedIn(req, req.body?.name || 'Adal Companion PC', 'PC number', who)
    if (r.suspended) return res.status(403).json({ error: 'This computer was suspended by the main PC', suspended: true })
    if (req.body?.device) await linkCompanionDevice(req.app.locals.db, r.id, req.body.device).catch(() => {})
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
    const cloud = await makeDevice(req.app.locals.db, name)
    if (req.pcAccess?.id) linkDevice(req.pcAccess.id, cloud.device)
    res.json({ number: pcNumber(), cloud })
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
    if (req.pcAccess?.id) { remove(req.pcAccess.id); await cutOnEveryPC(req.pcAccess.id, 'remove'); out.key = true }
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
/** An online account (keep_devices) this PC made or let in for a Companion ("Companion · …"), never a phone's. */
async function linkCompanionDevice(db, pcId, device) {
  if (!/^[0-9a-f-]{36}$/i.test(String(device || ''))) return false
  const { cloudOn, listDevices } = await import('../services/cloudSync.js')
  if (!(await cloudOn(db))) return false
  const d = ((await listDevices(db)) || []).find(x => x.user_id === device)
  if (!d || !/^Companion ·/.test(d.name || '')) return false
  linkDevice(pcId, device)
  return true
}
router.post('/pc-access/link', async (req, res) => {
  if (!req.pcAccess?.id) return res.status(403).json({ error: 'Only a computer that is let in' })
  try { res.json({ ok: await linkCompanionDevice(req.app.locals.db, req.pcAccess.id, req.body?.device) }) } catch (e) { res.status(500).json({ error: e.message }) }
})

/**
 * Settings → Connected devices (main PC only): the Companions (their key on
 * this PC and the online account they use when this PC is off) and the phones
 * (their online account). A Companion's two parts are shown, and suspended, as one.
 */
export async function connectedDevices(db) {
  const pcs = list()
  let cloud = [], cloudError = null
  try {
    const { cloudOn, listDevices } = await import('../services/cloudSync.js')
    if (await cloudOn(db)) cloud = (await listDevices(db)) || []
  } catch (e) { cloudError = e.message }
  const linked = new Set(pcs.map(p => p.device).filter(Boolean))
  const out = pcs.map(p => {
    const d = cloud.find(x => x.user_id === p.device)
    return { kind: 'companion', pc: p.id, device: p.device || null, name: p.name, ip: p.last_ip || p.ip, since: p.approved_at, last_seen: p.last_seen,
      suspended: !!p.suspended, online_suspended: d ? !!d.revoked : null }
  })
  for (const d of cloud) {
    if (linked.has(d.user_id)) continue
    out.push({ kind: /^Companion ·/.test(d.name || '') ? 'companion' : 'phone', pc: null, device: d.user_id, name: d.name || 'Phone',
      since: d.created_at, last_seen: d.last_seen, suspended: !!d.revoked })
  }
  return { devices: out, cloud_error: cloudError }
}
router.get('/pc-access/devices', here, async (req, res) => {
  try { res.json(await connectedDevices(req.app.locals.db)) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/pc-access/devices/suspend', here, async (req, res) => {
  const on = req.body?.suspended !== false
  try {
    let device = String(req.body?.device || '')
    if (req.body?.pc) device = setSuspended(String(req.body.pc), on) || device
    // Every PC of the agency refuses it too (its key on the agency's list, services/sync).
    if (req.body?.pc) await cutOnEveryPC(String(req.body.pc), on ? 'suspend' : 'allow')
    if (/^[0-9a-f-]{36}$/i.test(device)) {
      const { cloudOn, setDeviceRevoked } = await import('../services/cloudSync.js')
      if (await cloudOn(req.app.locals.db)) await setDeviceRevoked(req.app.locals.db, device, on)
      else if (!req.body?.pc) return res.status(409).json({ error: 'The online copy is off on this PC' })
    }
    console.log(`[pc-access] a device was ${on ? 'suspended' : 'allowed again'} (${req.body?.pc ? 'computer ' + req.body.pc : 'online ' + device})`)
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
/**
 * A computer let in that still has its key (kept in the window, sent as a
 * header) but lost the cookie (a cleared browser): the cookie again, so its
 * documents and pictures open too. Never a new key.
 */
router.post('/pc-access/resume', (req, res) => {
  if (!req.pcAccess) return res.status(isLocal(req) ? 200 : 401).json(isLocal(req) ? { ok: true, here: true } : { error: 'Not let in', pc_access: true })
  setKeyCookie(res, keyOf(req))
  res.json({ ok: true })
})
router.get('/pc-access/status', (req, res) => res.json(isLocal(req) ? { state: 'approved', here: true } : statusOf(req)))
router.get('/pc-access/pending', here, (req, res) => res.json(pending()))
router.post('/pc-access/answer', here, (req, res) => { try { answer(String(req.body?.id || ''), !!req.body?.yes); res.json({ ok: true }) } catch (e) { res.status(404).json({ error: e.message }) } })
router.get('/pc-access/list', here, (req, res) => res.json(list()))
router.delete('/pc-access/:id', here, async (req, res) => { remove(req.params.id); await cutOnEveryPC(req.params.id, 'remove'); res.json({ ok: true }) })

/** A Companion with its own copy: suspended, allowed or removed on every PC (sync_pcs). */
async function cutOnEveryPC(accessId, what) {
  try {
    const { syncNode } = await import('../services/sync/index.js')
    await syncNode()?.setCut(accessId, what)
  } catch (e) { console.warn('[pc-access] the other PCs:', e.message) }
}

export default router
