/**
 * /api/replica — a Companion keeps a locked copy of the agency's data
 * (services/replica.js), and /api/safety — what every screen warns about.
 *
 *   GET  /replica/manifest           (a Companion let in) a fresh snapshot's list
 *   GET  /replica/db/:snap/:i        (a Companion let in) one locked database chunk
 *   GET  /replica/doc/:part?name=    (a Companion let in) one locked document piece
 *   GET  /replica/keys               (a Companion let in) the backup key and channel
 *   POST /replica/report             (a Companion let in) its copy, or a backup it made
 *   GET  /replica/list               (this PC) the Companions holding a copy
 *   POST /backup/restore-companion   (this PC) restore from a Companion's copy
 *   GET  /safety                     the newest good backup and the licence's end
 */
import express from 'express'
import zlib from 'zlib'
import { manifest, manifestFor, dbChunkAsync, docPiece, replicaKeys, recordReport, replicas } from '../services/replica.js'
import { deltaOn } from '../services/replicaDelta.js'
import { withSlot } from '../services/replicaThrottle.js'
import { backupHealth, recordCompanionBackup, restoreFromCompanion } from '../services/telegramBackup.js'
import { onThisPC } from './trash.js'
import { ipOf } from '../services/networkGate.js'

const router = express.Router()

// A Companion let in with the main PC's number, straight on the network (never the online link).
const companionOnly = (req, res, next) => (req.pcAccess?.id && !req.headers['x-adal-cloud']
  ? next()
  : res.status(403).json({ error: 'Only a Companion PC let in with the main PC\'s number' }))
const here = (req, res, next) => (onThisPC(req) ? next() : res.status(403).json({ error: 'Only on the main PC itself' }))
const fail = (res, e) => { if (e.retryAfter) res.set('Retry-After', String(e.retryAfter)); res.status(e.status || 400).json({ error: e.message }) }
const bin = (res, buf) => { res.set('Content-Type', 'application/octet-stream'); res.set('Cache-Control', 'no-store'); res.end(buf) }

router.get('/replica/manifest', companionOnly, async (req, res) => {
  try {
    const db = req.app.locals.db
    const body = JSON.stringify(req.query.v === '2' && deltaOn() ? await manifestFor({ have: String(req.query.have || ''), docsAt: String(req.query.docs || ''), db }) : await manifest({ db }))
    res.type('json')
    if (body.length < 1024 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return res.send(body)
    zlib.gzip(body, (e, b) => e ? res.send(body) : res.set('Content-Encoding', 'gzip').send(b))
  } catch (e) { fail(res, e) }
})
// The copy is the least urgent work on the main PC: one piece at a time, paced by how busy this PC is (replicaThrottle.js).
router.get('/replica/db/:snap/:i', companionOnly, async (req, res) => {
  try { bin(res, await withSlot(() => dbChunkAsync(req.params.snap, req.params.i, { framed: req.query.v === '2', base: /^[0-9a-f]{20}$/.test(req.query.base || '') ? req.query.base : '' }))) } catch (e) { fail(res, e) }
})
router.get('/replica/doc/:part', companionOnly, async (req, res) => {
  try { bin(res, await withSlot(async () => docPiece(req.query.name, req.params.part))) } catch (e) { fail(res, e) }
})
router.get('/replica/keys', companionOnly, (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(replicaKeys()) } catch (e) { fail(res, e) }
})
router.post('/replica/report', companionOnly, (req, res) => {
  try {
    const b = req.body || {}
    const r = recordReport(req.pcAccess, ipOf(req), b)
    // It backed the agency up from its copy while this PC was off.
    if (b.backup_at) recordCompanionBackup({ at: b.backup_at, index_file_id: b.index_file_id, by: r.name })
    res.json({ ok: true, backup: backupHealth() })
  } catch (e) { fail(res, e) }
})
router.get('/replica/list', here, (req, res) => res.json(replicas()))
router.post('/backup/restore-companion', here, async (req, res) => {
  try {
    let number = req.body?.number
    if (!number) { try { number = (await import('../services/mainPC.js')).pcNumber() } catch {} }
    const r = await restoreFromCompanion(req.body?.address, { number, password: req.body?.password })
    res.json({ ...r, restart: true })
    if (r.database && process.platform === 'win32') setTimeout(() => process.exit(0), 1000) // the launcher starts it again
  } catch (e) { fail(res, e) }
})

/**
 * What every screen warns about (components/SafetyAlerts.jsx): the newest good
 * backup (older than 48 h → a warning) and when the licence ends (7 days,
 * 3 days, 1 day, 12 hours → a warning each). Times, not ages: a phone reading
 * the online copy with the PC off works the age out itself.
 */
export async function safetyPayload() {
  const { statusPayload } = await import('../services/subscription.js')
  const st = statusPayload()
  const expires = st.mode === 'trial' ? st.trialEndsAt
    : st.mode === 'active' ? (st.forGood && !st.paidUntil ? null : st.paidUntil)
    : null
  // (No "now" in it: it goes online only when something in it changes.)
  return {
    backup: backupHealth(),
    licence: {
      mode: st.mode,
      expires_at: expires ? new Date(expires).toISOString() : null,
      for_good: !!st.forGood,
      suspended: !!st.suspended,
      pc_number: st.pcNumber,
      seller_phone: st.sellerPhone,
      price_etb: await (async () => { try { const b = await import('../services/billing.js'); return b.billingOn() ? b.currentPrice6() : st.priceEtb } catch { return st.priceEtb } })(),
    },
  }
}
router.get('/safety', async (req, res) => {
  try {
    const { notMainPC: isFollower, mainURL, mainKey } = await import('../services/mainPC.js')
    // A PC that follows a main PC: the main PC's backup and licence are the ones that count.
    if (isFollower()) {
      const r = await fetch(`${mainURL()}/api/safety`, { headers: { 'x-adal-pc': await mainKey() }, signal: AbortSignal.timeout(8000) })
      if (r.ok) return res.json({ ...(await r.json()), on_main: true })
    }
    res.json(await safetyPayload())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
