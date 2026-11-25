/** "Send on WhatsApp" (the CV preview) and the WhatsApp page (services/waSend.js, waRecords.js). Mounted before routes/whatsapp.js. */
import express from 'express'
import os from 'os'
import { prepareSend, startSend, retrySend, jobs, mayNot } from '../services/waSend.js'
import { listSends, lastSent } from '../services/waRecords.js'
import { ownOn } from '../services/waOwn.js'
import * as own from '../services/waOwnHere.js'
import { agencyTransport, keyOf, stateOf } from '../services/whatsapp.js'

const router = express.Router()
export const waSendOn = () => process.env.ADAL_WA_SEND !== '0'
const by = (req) => { try { return decodeURIComponent(req.get('x-adal-who') || '').slice(0, 80) } catch { return '' } }
const from = (req) => String(req.pcAccess?.name || (req.headers['x-adal-cloud'] ? 'phone' : os.hostname())).slice(0, 80)
const bad = (res, e) => res.status(400).json({ error: String(e?.message || e), ...(e?.before ? { before: e.before } : {}), ...(e?.signIn ? { sign_in: e.signIn } : {}) })
router.use('/whatsapp/cv', (req, res, next) => (waSendOn() ? next() : res.status(404).json({ error: 'off' })))
// WhatsApp is in the Standard plan (plans.js): sending needs it; looking does not.
router.use('/whatsapp/cv', async (req, res, next) => {
  if (req.method !== 'POST') return next()
  const { requireFeature } = await import('../services/plans.js')
  requireFeature('whatsapp')(req, res, next)
})

/** Which WhatsApp this request sends through: this PC's own (switched on), else the agency's one. */
async function transportFor(req) {
  const db = req.app.locals.db
  if (await ownOn(db)) return own.transportFor(req, db)
  return agencyTransport(keyOf())
}
async function stateFor(req) {
  const db = req.app.locals.db
  if (await ownOn(db)) { const o = await own.stateFor(req, db).catch(e => ({ status: 'off', error: e.message })); return { status: o.status, me: o.me || null, own: true } }
  const s = stateOf(keyOf())
  return { status: s.status, me: s.me || null, own: false }
}

// Before the picker shows: may she go now, when each agent had her, which WhatsApp it is.
router.get('/whatsapp/cv/:profileId', async (req, res) => {
  try {
    const db = req.app.locals.db
    const p = await db('profiles').where('id', Number(req.params.profileId)).first()
    res.json({ blocked: await mayNot(db, p), had: await lastSent(db, req.params.profileId), whatsapp: await stateFor(req) })
  } catch (e) { bad(res, e) }
})
router.get('/whatsapp/cv/jobs/:id', (req, res) => { const j = jobs.get(Number(req.params.id)); j ? res.json(j) : res.status(404).json({ error: 'gone' }) })
// A person pressed Send: to the people they picked.
router.post('/whatsapp/cv/:profileId', async (req, res) => {
  try {
    const db = req.app.locals.db, b = req.body || {}
    const transport = await transportFor(req)
    const ready = await prepareSend(db, { profileId: req.params.profileId, cvId: b.cv_id, templateId: b.template_id, agentIds: b.agent_ids, again: b.again })
    res.json(startSend(db, ready, transport, { by: by(req), from: from(req) }))
  } catch (e) { bad(res, e) }
})

// The WhatsApp page.
router.get('/whatsapp/cv-log', async (req, res) => {
  try { res.json(await listSends(req.app.locals.db, req.query)) } catch (e) { bad(res, e) }
})
router.post('/whatsapp/cv/retry/:id', async (req, res) => {
  try { res.json(await retrySend(req.app.locals.db, req.params.id, () => transportFor(req), { by: by(req), from: from(req) })) } catch (e) { bad(res, e) }
})

export default router
