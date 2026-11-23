// The agency's config record and first-run sign-up (services/agencyConfig.js). Behind flags.
import { Router } from 'express'
import * as C from '../services/agencyConfig.js'
import * as cloud from '../services/chatCloud.js'

const router = Router()
const askBody = (db) => (method, p, optsOrBody) => (method === 'POST' ? cloud.cloudCall(db, method, p, optsOrBody) : cloud.cloudCall(db, method, p, undefined, optsOrBody))

router.get('/agency-config', (req, res) => res.json(C.configStatus()))
router.post('/agency-config/refresh', async (req, res) => {
  const db = req.app.locals.db
  if (!C.localFlag('agency_config')) return res.status(404).json({ error: 'Not switched on' })
  const id = await cloud.cloudAgencyId(db).catch(() => null)
  res.json(id ? await C.pullAgencyConfig(db, askBody(db), id) : { error: 'Not signed in online yet' })
})

router.get('/signup/state', async (req, res) => {
  if (!C.localFlag('agency_signup')) return res.json({ enabled: false })
  const db = req.app.locals.db
  const id = await cloud.cloudAgencyId(db).catch(() => null)
  res.json({ enabled: true, ...(await C.signupState(db, askBody(db), id)) })
})
router.post('/signup', async (req, res) => {
  if (!C.localFlag('agency_signup')) return res.status(404).json({ error: 'Not switched on' })
  try {
    const db = req.app.locals.db
    const { pcNumber } = await import('../services/mainPC.js')
    const r = await C.sendSignup(db, askBody(db), req.body, pcNumber())
    res.status(r.error ? 400 : 200).json(r)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
export default router
