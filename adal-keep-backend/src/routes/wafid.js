/**
 * /api/wafid — the Wafid medical button, result checks and the agency's
 * Wafid choices.
 *   POST /wafid/book/:profileId   queue "Book Wafid medical" for a profile
 *   POST /wafid/check {profile_id?} look results up now (one profile or all applied)
 *   GET  /wafid/check             the last look-up
 *   GET/POST /wafid/settings      city, passport issue place, position
 */
import express from 'express'
import { queueWafidBooking, checkAll, checker } from '../services/wafidStatus.js'
import { bookingValues, missingForBooking } from '../services/wafidWorkflow.js'

const router = express.Router()
const KEYS = { city: 'wafid_city', issue_place: 'wafid_issue_place', position: 'wafid_position' }
const DEFAULTS = { city: 'Addis Ababa', issue_place: 'ADDIS ABABA', position: 'House Maid' }

async function readSettings(db) {
  const rows = await db('settings').whereIn('key', [...Object.values(KEYS), 'agency_email']).catch(() => [])
  const get = (k) => String(rows.find(r => r.key === k)?.value || '').trim()
  return { city: get(KEYS.city) || DEFAULTS.city, issue_place: get(KEYS.issue_place) || DEFAULTS.issue_place, position: get(KEYS.position) || DEFAULTS.position, email: get('agency_email') }
}

router.post('/wafid/book/:profileId', async (req, res) => {
  try {
    const db = req.app.locals.db
    const p = await db('profiles').where('id', Number(req.params.profileId)).first()
    if (!p) return res.status(404).json({ error: 'Profile not found' })
    const s = await readSettings(db)
    const missing = missingForBooking(bookingValues(p, { email: s.email, city: s.city, issuePlace: s.issue_place, position: s.position }))
    if (missing.length) return res.status(400).json({ error: `Fill these first: ${missing.join(', ')}` })
    res.json(await queueWafidBooking(db, p.id, 'button'))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/wafid/check', async (req, res) => {
  const db = req.app.locals.db
  if (checker.running) return res.json({ busy: true, ...checker })
  const onlyId = req.body?.profile_id ? Number(req.body.profile_id) : null
  if (onlyId) {
    try { return res.json(await checkAll(db, { onlyId })) } catch (e) { return res.status(500).json({ error: e.message }) }
  }
  checkAll(db).catch(e => console.warn('[wafid] check failed:', e.message))
  res.json({ started: true })
})
router.get('/wafid/check', (req, res) => res.json(checker))

router.get('/wafid/settings', async (req, res) => res.json(await readSettings(req.app.locals.db)))
router.post('/wafid/settings', async (req, res) => {
  try {
    const db = req.app.locals.db
    const now = new Date().toISOString()
    for (const [k, key] of Object.entries(KEYS)) {
      if (req.body?.[k] === undefined) continue
      const value = String(req.body[k]).trim().slice(0, 80)
      const row = await db('settings').where('key', key).first()
      if (row) await db('settings').where('key', key).update({ value, updated_at: now })
      else await db('settings').insert({ key, value, created_at: now, updated_at: now })
    }
    res.json(await readSettings(db))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
