import express from 'express'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const updates = await db('updates')
      .orderBy('created_at', 'desc')
      .limit(50)

    res.json(updates)
  } catch (error) {
    console.error('Updates error:', error)
    res.status(500).json({ error: 'Failed to fetch updates' })
  }
})

router.post('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { type, title, body, icon, is_ai_generated } = req.body

    if (!title?.trim()) {
      return res.status(400).json({ error: 'Title is required' })
    }

    const [id] = await db('updates').insert({
      type: type || 'info',
      title: title.trim(),
      body,
      icon: icon || 'info',
      is_ai_generated: is_ai_generated || false,
      created_at: new Date().toISOString()
    })

    const update = await db('updates').where('id', id).first()
    res.status(201).json(update)
  } catch (error) {
    console.error('Update create error:', error)
    res.status(500).json({ error: 'Failed to create update' })
  }
})

export default router