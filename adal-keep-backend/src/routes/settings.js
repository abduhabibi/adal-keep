import express from 'express'
import { authenticate } from '../middleware/auth.js'

const router = express.Router()

// Wallpaper endpoint - returns 204 if not found instead of 404
router.get('/wallpaper', async (req, res) => {
  try {
    const wallpaper = await req.app.locals.db('settings').where({ key: 'wallpaper' }).first()
    if (!wallpaper || !wallpaper.value) {
      return res.status(204).send()
    }
    res.type('image/jpeg')
    res.send(Buffer.from(wallpaper.value, 'base64'))
  } catch (err) {
    res.status(204).send()
  }
})

// Get settings
router.get('/', authenticate, async (req, res) => {
  try {
    const settings = await req.app.locals.db('settings').select('key', 'value')
    const formatted = {}
    settings.forEach((row) => {
      formatted[row.key] = row.value
    })
    res.json(formatted)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' })
  }
})

// Update settings
router.put('/', authenticate, async (req, res) => {
  try {
    const { agency_email } = req.body

    if (agency_email !== undefined) {
      const existing = await req.app.locals.db('settings')
        .where({ key: 'agency_email' })
        .first()

      if (existing) {
        await req.app.locals.db('settings')
          .where({ key: 'agency_email' })
          .update({ value: agency_email })
      } else {
        await req.app.locals.db('settings')
          .insert({ key: 'agency_email', value: agency_email })
      }
    }

    res.json({ success: true })
  } catch (err) {
    console.error('Settings update error:', err)
    res.status(500).json({ error: err.message || 'Failed to update settings' })
  }
})

export default router