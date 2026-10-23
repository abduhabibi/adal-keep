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

// Documents Adal Keep noticed in the last day: waiting, being read (and on
// which step), added to a profile, or not added and why. The Tasks page shows them.
router.get('/documents', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const rows = await req.app.locals.db('ingest_queue')
      .where('created_at', '>=', since)
      .where(q => q.whereNull('last_error').orWhereNot('last_error', 'was already in the folder'))
      .orderBy('id', 'desc').limit(40)
      .select('id', 'filename', 'status', 'stage', 'result', 'last_error', 'attempts', 'created_at', 'started_at', 'updated_at')
    res.json({ now: new Date().toISOString(), rows: rows.map(r => {
      let result = null
      try { result = r.result ? JSON.parse(r.result) : null } catch {}
      return { ...r, result }
    }) })
  } catch (e) { res.status(500).json({ error: e.message }) }
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
    const { moveToTrash } = await import('../services/trash.js')
    await moveToTrash(req.app.locals.db, 'task', req.params.id, req)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
