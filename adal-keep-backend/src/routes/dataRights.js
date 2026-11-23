/**
 * /api — candidate data rights and the audit log.
 *   POST /profiles/:id/consent         { consent: true|false }
 *   GET  /profiles/:id/data-export     a .zip with everything about her
 *   POST /profiles/:id/erase           { confirm_name }   erases her for good
 *   GET  /audit?profile_id=&action=&limit=
 * Roles (services/staffRoles.js RULES): export → "export and back up", erase → "delete profiles",
 * the log → "manage staff".
 */
import express from 'express'
import { exportOne, setConsent, eraseOne } from '../services/dataRights.js'
import { record, list } from '../services/audit.js'
import { whoFrom } from '../services/trash.js'

const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })

router.post('/profiles/:id/consent', async (req, res) => {
  try {
    const id = Number(req.params.id), db = req.app.locals.db
    const r = await setConsent(db, id, req.body?.consent, whoFrom(req).deleted_by)
    if (!r) return res.status(404).json({ error: 'Not found' })
    await record(db, req, { action: 'consent', id, detail: r.data_consent ? 'agreed to share her data for recruitment' : 'consent taken back' })
    res.json(r)
  } catch (e) { fail(res, e) }
})

router.get('/profiles/:id/data-export', async (req, res) => {
  try {
    const id = Number(req.params.id), db = req.app.locals.db
    const out = await exportOne(db, id)
    if (!out) return res.status(404).json({ error: 'Not found' })
    await record(db, req, { action: 'exported', id, name: out.name, detail: 'all her data (zip)' })
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="candidate-${id}-data.zip"` }).send(out.zip)
  } catch (e) { fail(res, e) }
})

router.post('/profiles/:id/erase', async (req, res) => {
  try {
    const id = Number(req.params.id), db = req.app.locals.db
    const r = await eraseOne(db, id, req.body?.confirm_name, req)
    if (!r) return res.status(404).json({ error: 'Not found' })
    await record(db, req, { action: 'erased', id, name: null, detail: 'erased on request' })
    res.json(r)
  } catch (e) { fail(res, e) }
})

router.get('/audit', async (req, res) => {
  try { res.json(await list(req.app.locals.db, { profile_id: req.query.profile_id, action: req.query.action, limit: req.query.limit })) } catch (e) { fail(res, e) }
})

export default router
