import express from 'express'
import AIActions from '../services/aiActions.js'

const router = express.Router()

router.post('/process', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {}
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'መልእክት ያስፈልጋል' })
    }

    const ai = new AIActions(req.app.locals.db)
    const result = await ai.processMessage(String(message).trim(), {
      companyId: req.auth?.companyId || 1,
      history: Array.isArray(history) ? history : []
    })
    res.json(result)
  } catch (err) {
    console.error('[AI /process]', err)
    res.status(500).json({
      suggestion: 'ይቅርታ፣ አሁን ማገልገል አልቻልኩም። (' + (err.message || '') + ')'
    })
  }
})

router.post('/confirm-action', async (req, res) => {
  try {
    const { action } = req.body || {}
    if (!action) return res.status(400).json({ error: 'action required' })
    const ai = new AIActions(req.app.locals.db)
    const result = await ai.executeAction(action, { userId: req.session?.userId || req.auth?.userId || null })
    res.json(result)
  } catch (err) {
    console.error('[AI /confirm-action]', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
