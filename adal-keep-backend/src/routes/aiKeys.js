/** Settings → Photo refining keys: Google AI Studio keys, kept locked on this PC (services/aiKeys.js). */
import express from 'express'
import { publicKeys, addAiKey, removeAiKey, checkAiKey } from '../services/aiKeys.js'

const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })

router.get('/ai-keys', (req, res) => res.json(publicKeys()))
router.post('/ai-keys', async (req, res) => {
  try {
    const id = await addAiKey(req.app.locals.db, req.body || {})
    // Checked at once: Google says whether it may edit pictures.
    await checkAiKey(req.app.locals.db, id).catch(() => {})
    res.json(publicKeys())
  } catch (e) { fail(res, e) }
})
router.post('/ai-keys/:id/check', async (req, res) => {
  try { await checkAiKey(req.app.locals.db, req.params.id); res.json(publicKeys()) } catch (e) { fail(res, e) }
})
router.delete('/ai-keys/:id', async (req, res) => {
  try { await removeAiKey(req.app.locals.db, req.params.id); res.json(publicKeys()) } catch (e) { fail(res, e) }
})

export default router
