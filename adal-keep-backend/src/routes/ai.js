import express from 'express'
import { processAIQuery } from '../services/aiQuery.js'
import aiService from '../services/ai.js'
import aiActions from '../services/aiActions.js'

const router = express.Router()

// Used by AIPage.jsx
router.post('/query', async (req, res) => {
  const { query } = req.body
  if (!query?.trim()) return res.status(400).json({ error: 'ጥያቄ ያስፈልጋል' })
  try {
    const db = req.app.locals.db
    const result = await processAIQuery(query, req.auth?.companyId || 1, db)
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'AI ጥያቄን ማስተናገድ አልተቻለም' })
  }
})

// Used by AIChatWidget
router.post('/process', async (req, res) => {
  try {
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'መልእክት ያስፈልጋል' })

    const result = await aiActions.processMessage(message, {
      companyId: req.auth?.companyId || 1,
      userId: req.auth?.userId || 1
    })

    res.json(result)
  } catch (err) {
    console.error('[AI /process]', err)
    res.status(500).json({ 
      suggestion: 'ይቅርታ፣ አሁን ማገልገል አልቻልኩም። እባክዎ እንደገና ይሞክሩ።',
      error: err.message 
    })
  }
})

// Document analysis (vision)
router.post('/analyze-document', async (req, res) => {
  try {
    const { image_url, filename } = req.body
    if (!image_url) return res.status(400).json({ success: false, error: 'image_url required' })

    const result = await aiActions.processDocumentImage(image_url, filename || 'document')
    res.json(result)
  } catch (err) {
    console.error('[AI /analyze-document]', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// Confirm HITL action
router.post('/confirm-action', async (req, res) => {
  try {
    const { action, confirmed_by } = req.body
    if (!action) return res.status(400).json({ error: 'action required' })

    const result = await aiActions.executeAction(action, confirmed_by || 'user')
    res.json(result)
  } catch (err) {
    console.error('[AI /confirm-action]', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
