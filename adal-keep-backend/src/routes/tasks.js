import { Router } from 'express'
const router = Router()

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const rows = await db('tasks').orderBy('created_at', 'desc')
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to load tasks' })
  }
})

router.post('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { title, description, status = 'pending', priority = 'medium' } = req.body || {}
    if (!title) return res.status(400).json({ error: 'title required' })
    const [id] = await db('tasks').insert({
      title,
      description: description || null,
      status,
      priority,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    const row = await db('tasks').where({ id }).first()
    res.status(201).json(row)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const allowed = ['title', 'description', 'status', 'priority', 'assigned_to']
    const patch = {}
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k]
    }
    patch.updated_at = new Date().toISOString()
    await db('tasks').where({ id: req.params.id }).update(patch)
    const row = await db('tasks').where({ id: req.params.id }).first()
    res.json(row)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    await req.app.locals.db('tasks').where({ id: req.params.id }).del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
