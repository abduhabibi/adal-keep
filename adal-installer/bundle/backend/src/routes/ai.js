import express from 'express'
import aiService from '../services/ai.js'

const router = express.Router()

/**
 * POST /api/ai/chat
 * Send message to AI, get Amharic response
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, context = [] } = req.body

    if (!message?.trim() || message.trim().length > 2000) {
      return res.status(400).json({ error: 'መልእክት ያስፈልጋል (ከ2000 ቁምፊ በታች)' })
    }

    // Get knowledge base from database
    const db = req.app.locals.db
    const knowledge = await db('knowledge_base')
      .where('is_active', true)
      .select('content')
      .limit(50)

    const knowledgeContext = knowledge.map(k => k.content)

    const result = await aiService.chatAmharic(message, knowledgeContext)

    if (!result.success) {
      return res.status(500).json({ error: result.error })
    }

    // Log the conversation
    await db('ai_conversations').insert({
      user_message: message,
      ai_response: result.message,
      model: result.model,
      created_at: new Date().toISOString()
    })

    res.json({
      success: true,
      response: result.message,
      model: result.model
    })
  } catch (error) {
    console.error('Chat error:', error)
    res.status(500).json({ error: 'Failed to process chat' })
  }
})

/**
 * POST /api/ai/analyze-image
 * Analyze uploaded image (passport, ID, etc.)
 */
router.post('/analyze-image', async (req, res) => {
  try {
    const { imageData, type = 'document' } = req.body

    if (!imageData) {
      return res.status(400).json({ error: 'Image data is required' })
    }

    let prompt = 'Describe this image in detail'
    
    if (type === 'passport') {
      prompt = `Extract the following information from this passport photo:
1. Full name (ሙሉ ስም)
2. Passport number (የፓስፖርት ቁጥር)
3. Nationality (ዜግነት)
4. Date of birth (የልደት ቀን)
5. Expiry date (የሚያበቃበት ቀን)
6. Gender (ፆታ)

Return the data in JSON format like:
{
  "full_name": "...",
  "passport_number": "...",
  "nationality": "...",
  "date_of_birth": "...",
  "expiry_date": "...",
  "gender": "..."
}

If you cannot read a field clearly, set it to null.`
    } else if (type === 'id') {
      prompt = `Extract information from this Ethiopian ID card:
1. Full name
2. ID number
3. Date of birth
4. Address
5. Issue date

Return as JSON.`
    }

    const result = await aiService.analyzeImage(imageData, prompt)

    if (!result.success) {
      return res.status(500).json({ error: result.error })
    }

    res.json({
      success: true,
      analysis: result.message,
      model: result.model
    })
  } catch (error) {
    console.error('Image analysis error:', error)
    res.status(500).json({ error: 'Failed to analyze image' })
  }
})

/**
 * POST /api/ai/knowledge
 * Add knowledge to the AI's memory
 */
router.post('/knowledge', async (req, res) => {
  try {
    const { content, category = 'general' } = req.body
    const db = req.app.locals.db

    if (!content?.trim()) {
      return res.status(400).json({ error: 'Content is required' })
    }

    const [id] = await db('knowledge_base').insert({
      content: content.trim(),
      category,
      is_active: true,
      created_at: new Date().toISOString()
    })

    res.status(201).json({ success: true, id, message: 'Knowledge added' })
  } catch (error) {
    console.error('Knowledge error:', error)
    res.status(500).json({ error: 'Failed to add knowledge' })
  }
})

/**
 * GET /api/ai/knowledge
 * Get all knowledge entries
 */
router.get('/knowledge', async (req, res) => {
  try {
    const db = req.app.locals.db
    const knowledge = await db('knowledge_base')
      .where('is_active', true)
      .orderBy('created_at', 'desc')

    res.json(knowledge)
  } catch (error) {
    console.error('Knowledge fetch error:', error)
    res.status(500).json({ error: 'Failed to fetch knowledge' })
  }
})

export default router
import AIActions from '../services/aiActions.js'

/**
 * POST /api/ai/process
 * Process message and detect actionable intents (with confirmation)
 */
router.post('/process', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { message, context } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

    const actions = new AIActions(db)
    const result = await actions.processMessage(message.trim(), context || {})

    res.json(result)
  } catch (err) {
    console.error('AI process error:', err)
    res.status(500).json({ error: 'Processing failed' })
  }
})

/**
 * POST /api/ai/confirm-action
 * Execute a confirmed AI action
 */
router.post('/confirm-action', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { action, confirmed_by } = req.body
    if (!action?.type) return res.status(400).json({ error: 'Action required' })

    const actions = new AIActions(db)
    const result = await actions.executeAction(action, confirmed_by || 'admin')

    res.json(result)
  } catch (err) {
    console.error('AI confirm error:', err)
    res.status(500).json({ error: 'Execution failed' })
  }
})

/**
 * POST /api/ai/analyze-document
 * Upload and analyze a document image with vision AI
 */
router.post('/analyze-document', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { image_url, filename } = req.body
    if (!image_url) return res.status(400).json({ error: 'image_url required' })

    const actions = new AIActions(db)
    const result = await actions.processDocumentImage(image_url, filename || 'document')

    res.json(result)
  } catch (err) {
    console.error('Document analysis error:', err)
    res.status(500).json({ error: 'Analysis failed' })
  }
})
