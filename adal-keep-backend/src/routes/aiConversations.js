import { Router } from 'express'
const router = Router()

function db(req) {
  return req.app.locals.db
}

/** List threads for sidebar */
router.get('/', async (req, res) => {
  try {
    const companyId = req.auth?.companyId || 1
    const cols = await db(req)('ai_conversations').columnInfo()
    let q = db(req)('ai_conversations')
    if (cols.company_id) {
      q = q.where(function () {
        this.where({ company_id: companyId }).orWhereNull('company_id')
      })
    }
    if (cols.title) {
      const withTitle = await q.clone().whereNotNull('title').orderBy('updated_at', 'desc').limit(50)
      if (withTitle.length) return res.json(withTitle)
    }
    const rows = await q.orderBy('updated_at', 'desc').limit(50)
    res.json(rows)
  } catch (err) {
    console.error('[ai_conversations list]', err.message)
    res.json([])
  }
})

/** Create chat – always fill NOT NULL legacy columns */
router.post('/', async (req, res) => {
  try {
    const companyId = req.auth?.companyId || 1
    const userId = req.auth?.userId || req.auth?.uid || null
    const title = String(req.body?.title || 'New Chat').trim().slice(0, 100) || 'New Chat'
    const now = new Date().toISOString()
    const cols = await db(req)('ai_conversations').columnInfo()

    const row = {
      company_id: companyId,
      user_id: userId,
      title,
      user_message: title,      // NOT NULL in old schema
      ai_response: '',          // NOT NULL in old schema
      model: null,
      created_at: now,
      updated_at: now
    }

    const insert = {}
    for (const [k, v] of Object.entries(row)) {
      if (cols[k] !== undefined) insert[k] = v
    }

    const [id] = await db(req)('ai_conversations').insert(insert)
    const conv = await db(req)('ai_conversations').where({ id }).first()
    res.status(201).json(conv)
  } catch (err) {
    console.error('[ai_conversations create]', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.get('/:id/messages', async (req, res) => {
  try {
    const hasMsg = await db(req).schema.hasTable('ai_messages')
    if (hasMsg) {
      const messages = await db(req)('ai_messages')
        .where({ conversation_id: req.params.id })
        .orderBy('id', 'asc')
      return res.json(messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at
      })))
    }
    const conv = await db(req)('ai_conversations').where({ id: req.params.id }).first()
    if (!conv) return res.json([])
    const out = []
    if (conv.user_message) out.push({ role: 'user', content: conv.user_message })
    if (conv.ai_response) out.push({ role: 'assistant', content: conv.ai_response })
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:id/messages', async (req, res) => {
  try {
    const { role, content } = req.body || {}
    if (!role || content == null || content === '') {
      return res.status(400).json({ error: 'role and content required' })
    }
    const now = new Date().toISOString()
    const hasMsg = await db(req).schema.hasTable('ai_messages')
    if (hasMsg) {
      await db(req)('ai_messages').insert({
        conversation_id: Number(req.params.id),
        role,
        content: String(content),
        created_at: now
      })
    } else {
      const patch = { updated_at: now }
      if (role === 'user') patch.user_message = String(content)
      if (role === 'assistant') patch.ai_response = String(content)
      await db(req)('ai_conversations').where({ id: req.params.id }).update(patch)
    }
    await db(req)('ai_conversations').where({ id: req.params.id }).update({ updated_at: now })
    res.json({ success: true })
  } catch (err) {
    console.error('[ai_messages]', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    if (await db(req).schema.hasTable('ai_messages')) {
      await db(req)('ai_messages').where({ conversation_id: req.params.id }).del()
    }
    await db(req)('ai_conversations').where({ id: req.params.id }).del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
