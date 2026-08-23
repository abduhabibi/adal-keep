import express from 'express'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { status } = req.query
    let query = db('tasks').orderBy('created_at', 'desc')
    
    if (status && status !== 'all') {
      query = query.where('status', status)
    }

    const tasks = await query
    res.json(tasks)
  } catch (error) {
    console.error('Tasks error:', error)
    res.status(500).json({ error: 'Failed to fetch tasks' })
  }
})

router.post('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { title, description, status, priority, due_date } = req.body

    if (!title?.trim()) {
      return res.status(400).json({ error: 'Title is required' })
    }

    const [id] = await db('tasks').insert({
      title: title.trim(),
      description,
      status: status || 'todo',
      priority: priority || 'medium',
      due_date,
      created_at: new Date().toISOString()
    })

    const task = await db('tasks').where('id', id).first()
    res.status(201).json(task)
  } catch (error) {
    console.error('Task create error:', error)
    res.status(500).json({ error: 'Failed to create task' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { id } = req.params
    const updates = req.body

    await db('tasks').where('id', id).update({
      ...updates,
      updated_at: new Date().toISOString()
    })

    const task = await db('tasks').where('id', id).first()
    res.json(task)
  } catch (error) {
    console.error('Task update error:', error)
    res.status(500).json({ error: 'Failed to update task' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('tasks').where('id', req.params.id).del()
    res.json({ success: true })
  } catch (error) {
    console.error('Task delete error:', error)
    res.status(500).json({ error: 'Failed to delete task' })
  }
})

export default router
