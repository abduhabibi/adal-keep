import { Router } from 'express'
import { applyCode, statusPayload, readSide, maybeNotify } from '../services/subscription.js'

const router = Router()

/**
 * POST /api/subscription/unlock
 * Body: { code: "ADAL-MONTH-30" }
 * Extends the paid period by 30 days (or whatever the code says)
 */
router.post('/unlock', async (req, res) => {
  try {
    const { code } = req.body
    if (!code) {
      return res.status(400).json({ error: 'Access code required' })
    }

    const ok = applyCode(code)
    if (!ok) {
      return res.status(400).json({ error: 'Invalid or expired access code' })
    }

    const s = readSide()
    const status = statusPayload(s)

    // Optional: create a success notification
    try {
      const db = req.app.locals.db
      if (db) {
        await db('notifications').insert({
          type: 'subscription_unlocked',
          title: 'Subscription renewed',
          body: `Access extended. New period active.`,
          created_day: new Date().toISOString().slice(0, 10),
          created_at: new Date().toISOString()
        })
      }
    } catch {}

    res.json({
      success: true,
      message: 'Access granted',
      subscription: status
    })
  } catch (err) {
    console.error('Unlock error:', err)
    res.status(500).json({ error: 'Failed to unlock' })
  }
})

/**
 * GET /api/subscription/status-sidecar
 * Returns the current sidecar-based status (trial / read_only / active / destroyed)
 */
router.get('/status-sidecar', (req, res) => {
  const s = readSide()
  res.json(statusPayload(s) || { mode: 'fresh' })
})

export default router
