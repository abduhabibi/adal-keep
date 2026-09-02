import { Router } from 'express'

const router = Router()

// List conversations
router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const companyId = req.auth?.companyId || 1
    const rows = await db('ai_conversations')
      .where({ company_id: companyId })
      .orderBy('updated_at', 'desc')
      .limit(50)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load conversations' })
  }
})

// Create new conversation
router.post('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const companyId = req.auth?.companyId || 1
    const userId = req.auth?.userId || req.auth?.uid || null
    const title = (req.body.title || 'New Chat').trim().slice(0, 100)

    const [id] = await db('ai_conversations').insert({
      company_id: companyId,
      user_id: userId,
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    const conv = await db('ai_conversations').where({ id }).first()
    res.status(201).json(conv)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create conversation' })
  }
})

// Get messages of one conversation
router.get('/:id/messages', async (req, res) => {
  try {
    const db = req.app.locals.db
    const messages = await db('ai_messages')
      .where({ conversation_id: req.params.id })
      .orderBy('id', 'asc')
    res.json(messages)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load messages' })
  }
})

// Append a message (used by the chat UI)
router.post('/:id/messages', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { role, content } = req.body
    if (!role || !content) return res.status(400).json({ error: 'role and content required' })

    await db('ai_messages').insert({
      conversation_id: req.params.id,
      role,
      content,
      created_at: new Date().toISOString()
    })

    await db('ai_conversations')
      .where({ id: req.params.id })
      .update({ updated_at: new Date().toISOString() })

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to save message' })
  }
})

// Delete conversation + its messages
router.delete('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('ai_messages').where({ conversation_id: req.params.id }).del()
    await db('ai_conversations').where({ id: req.params.id }).del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' })
  }
})

export default router
