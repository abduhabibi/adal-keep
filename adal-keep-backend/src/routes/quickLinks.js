import express from 'express'
const router = express.Router()

// GET /api/quick-links - List all links
router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const links = await db('quick_links').orderBy('sort_order', 'asc').orderBy('created_at', 'desc')
    res.json(links)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quick links' })
  }
})

// POST /api/quick-links - Add new link with auto thumbnail
router.post('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { name, url } = req.body
    if (!name?.trim() || !url?.trim()) {
      return res.status(400).json({ error: 'Name and URL required' })
    }

    // Auto-fetch favicon/thumbnail
    let thumbnailUrl = null
    try {
      const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
      thumbnailUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    } catch {}

    const maxOrder = await db('quick_links').max('sort_order as max').first()
    const sortOrder = (maxOrder?.max || 0) + 1

    const [id] = await db('quick_links').insert({
      name: name.trim(),
      url: url.trim(),
      thumbnail_url: thumbnailUrl,
      sort_order: sortOrder,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    const link = await db('quick_links').where('id', id).first()
    res.status(201).json(link)
  } catch (err) {
    console.error('Quick link create error:', err)
    res.status(500).json({ error: 'Failed to create link' })
  }
})

// PUT /api/quick-links/:id - Edit link
router.put('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { name, url } = req.body
    const existing = await db('quick_links').where('id', req.params.id).first()
    if (!existing) return res.status(404).json({ error: 'Link not found' })

    let thumbnailUrl = existing.thumbnail_url
    if (url && url !== existing.url) {
      try {
        const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
        thumbnailUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
      } catch {}
    }

    await db('quick_links').where('id', req.params.id).update({
      name: name?.trim() || existing.name,
      url: url?.trim() || existing.url,
      thumbnail_url: thumbnailUrl,
      updated_at: new Date().toISOString()
    })

    const updated = await db('quick_links').where('id', req.params.id).first()
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: 'Failed to update link' })
  }
})

// DELETE /api/quick-links/:id - Delete link
router.delete('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const deleted = await db('quick_links').where('id', req.params.id).del()
    if (!deleted) return res.status(404).json({ error: 'Link not found' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete link' })
  }
})

export default router
