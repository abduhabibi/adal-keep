import express from 'express'
import axios from 'axios'
import {
  extractProfileData,
  createOrUpdateProfile,
  saveFileToField,
  generateAmharicResponse,
} from '../services/aiIngestion.js'

const router = express.Router()
const BRIDGE_URL = process.env.WHATSAPP_BRIDGE_URL || 'http://localhost:3001'

async function sendReply(to, message) {
  try {
    await axios.post(`${BRIDGE_URL}/send`, { to, message }, { timeout: 10000 })
  } catch (err) {
    console.error(`[WhatsApp] Failed to send reply to ${to}:`, err.message)
  }
}

// Webhook: receives messages from Baileys bridge (no auth required)
router.post('/webhook', async (req, res) => {
  try {
    const { from, body, mediaUrl, mimeType, filename } = req.body
    if (!from) return res.status(400).json({ error: 'Missing sender number' })

    console.log(`[WhatsApp] Message from ${from}: ${body?.substring(0, 50)}...`)

    let imageBase64 = null
    let effectiveMimeType = mimeType || 'image/jpeg'

    if (mediaUrl) {
      try {
        const mediaRes = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000 })
        imageBase64 = Buffer.from(mediaRes.data).toString('base64')
        effectiveMimeType = mimeType || mediaRes.headers['content-type'] || 'image/jpeg'
      } catch (err) {
        console.error('[WhatsApp] Failed to download media:', err.message)
      }
    }

    const extracted = await extractProfileData(imageBase64, effectiveMimeType, body)

    if (!extracted || (!extracted.full_name && !extracted.phone_number)) {
      const reply = extracted?.notes || 'እባኮትን የሙሉ ስም እና ስልክ ቁጥር ይላኩ።'
      await sendReply(from, reply)
      return res.json({ status: 'clarification_needed', reply })
    }

    const db = req.app.locals.db
    const result = await createOrUpdateProfile(db, extracted)

    if (imageBase64 && result.profileId) {
      const buffer = Buffer.from(imageBase64, 'base64')
      const fname = filename || `document_${Date.now()}.jpg`
      await saveFileToField(db, result.profileId, 'document', buffer, fname, effectiveMimeType)
    }

    const reply = generateAmharicResponse(result.action, result.profile)
    await sendReply(from, reply)

    console.log(`[WhatsApp] Profile ${result.action}: ${result.profileId} for ${from}`)
    res.json({ status: 'success', action: result.action, profileId: result.profileId })
  } catch (err) {
    console.error('[WhatsApp] Webhook error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Status check (auth required)
router.get('/status', async (req, res) => {
  try {
    const statusRes = await axios.get(`${BRIDGE_URL}/status`, { timeout: 5000 })
    res.json({ connected: true, ...statusRes.data })
  } catch {
    res.json({ connected: false, bridge_url: BRIDGE_URL })
  }
})

// Manual send (auth required, for testing)
router.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Missing to/message' })
  try {
    await sendReply(to, message)
    res.json({ sent: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
