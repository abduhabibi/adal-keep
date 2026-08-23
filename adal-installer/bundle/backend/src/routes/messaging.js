import express from 'express'

const router = express.Router()

// ============================================
// LESSON STORAGE (Shared Knowledge Base)
// ============================================

/**
 * GET /api/messaging/lessons
 * Get all shared lessons/knowledge
 */
router.get('/lessons', async (req, res) => {
  try {
    const db = req.app.locals.db
    const lessons = await db('knowledge_base')
      .where('is_active', true)
      .orderBy('created_at', 'desc')

    res.json(lessons)
  } catch (err) {
    console.error('Lessons fetch error:', err)
    res.status(500).json({ error: 'Failed to fetch lessons' })
  }
})

/**
 * POST /api/messaging/lessons
 * Add a new lesson (from any AI or from you)
 */
router.post('/lessons', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { content, category, source_ai_id, source_client } = req.body

    if (!content?.trim()) {
      return res.status(400).json({ error: 'Content required' })
    }

    const [id] = await db('knowledge_base').insert({
      content: content.trim(),
      category: category || 'general',
      is_active: true,
      created_at: new Date().toISOString()
    })

    // Log which AI/client contributed this lesson
    if (source_ai_id) {
      await db('ai_conversations').insert({
        user_message: `[LESSON ADDED] ${content}`,
        ai_response: `Lesson stored by AI ${source_ai_id} from ${source_client || 'unknown'}`,
        model: 'system',
        created_at: new Date().toISOString()
      })
    }

    res.status(201).json({ id, message: 'Lesson stored' })
  } catch (err) {
    console.error('Lesson add error:', err)
    res.status(500).json({ error: 'Failed to add lesson' })
  }
})

/**
 * DELETE /api/messaging/lessons/:id
 * Remove a lesson
 */
router.delete('/lessons/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('knowledge_base').where('id', req.params.id).update({ is_active: false })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete lesson' })
  }
})

// ============================================
// AI INSTANCE REGISTRY
// ============================================

/**
 * POST /api/messaging/ai/register
 * Client AI registers itself with central server
 */
router.post('/ai/register', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { ai_id, client_name, fingerprint, capabilities } = req.body

    if (!ai_id || !client_name) {
      return res.status(400).json({ error: 'ai_id and client_name required' })
    }

    // Upsert AI instance
    const existing = await db('ai_instances').where('ai_id', ai_id).first()

    if (existing) {
      await db('ai_instances').where('ai_id', ai_id).update({
        client_name,
        fingerprint: fingerprint || existing.fingerprint,
        last_seen: new Date().toISOString(),
        is_online: true,
        updated_at: new Date().toISOString()
      })
    } else {
      await db('ai_instances').insert({
        ai_id,
        client_name,
        fingerprint: fingerprint || '',
        capabilities: JSON.stringify(capabilities || []),
        last_seen: new Date().toISOString(),
        is_online: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }

    res.json({ success: true, ai_id })
  } catch (err) {
    console.error('AI register error:', err)
    res.status(500).json({ error: 'Failed to register AI' })
  }
})

/**
 * POST /api/messaging/ai/heartbeat
 * AI sends heartbeat to stay online
 */
router.post('/ai/heartbeat', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { ai_id } = req.body

    if (!ai_id) return res.status(400).json({ error: 'ai_id required' })

    await db('ai_instances').where('ai_id', ai_id).update({
      last_seen: new Date().toISOString(),
      is_online: true
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Heartbeat failed' })
  }
})

/**
 * GET /api/messaging/ai/list
 * List all registered AI instances (for your portal)
 */
router.get('/ai/list', async (req, res) => {
  try {
    const db = req.app.locals.db
    const instances = await db('ai_instances').orderBy('last_seen', 'desc')

    // Mark as offline if no heartbeat in 5 minutes
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    for (const inst of instances) {
      if (inst.last_seen < cutoff) {
        inst.is_online = false
      }
    }

    res.json(instances)
  } catch (err) {
    res.status(500).json({ error: 'Failed to list AIs' })
  }
})

// ============================================
// MESSAGING (You ↔ AI Instances)
// ============================================

/**
 * POST /api/messaging/send
 * Send message to specific AI or broadcast to group
 */
router.post('/send', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { to_ai_id, from, message, is_group, group_name } = req.body

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' })
    }

    const msgData = {
      to_ai_id: to_ai_id || null,
      from: from || 'admin',
      message: message.trim(),
      is_group: is_group || false,
      group_name: group_name || null,
      is_from_admin: true,
      created_at: new Date().toISOString()
    }

    const [id] = await db('portal_messages').insert(msgData)

    res.status(201).json({ id, ...msgData })
  } catch (err) {
    console.error('Send error:', err)
    res.status(500).json({ error: 'Failed to send' })
  }
})

/**
 * GET /api/messaging/messages
 * Get messages (filter by AI, group, or all)
 */
router.get('/messages', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { ai_id, group, limit = 100, since } = req.query

    let query = db('portal_messages').orderBy('created_at', 'desc').limit(Number(limit))

    if (ai_id) {
      query = query.where(function () {
        this.where('to_ai_id', ai_id).orWhere('from', ai_id)
      })
    }

    if (group) {
      query = query.where('group_name', group).andWhere('is_group', true)
    }

    if (since) {
      query = query.where('created_at', '>', since)
    }

    const messages = await query
    res.json(messages.reverse()) // Chronological order
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' })
  }
})

/**
 * POST /api/messaging/groups
 * Create a group
 */
router.post('/groups', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { name, ai_ids } = req.body

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Group name required' })
    }

    const [id] = await db('portal_groups').insert({
      name: name.trim(),
      ai_ids: JSON.stringify(ai_ids || []),
      created_at: new Date().toISOString()
    })

    res.status(201).json({ id, name, ai_ids: ai_ids || [] })
  } catch (err) {
    res.status(500).json({ error: 'Failed to create group' })
  }
})

/**
 * GET /api/messaging/groups
 * List all groups
 */
router.get('/groups', async (req, res) => {
  try {
    const db = req.app.locals.db
    const groups = await db('portal_groups').orderBy('created_at', 'desc')
    res.json(groups.map(g => ({ ...g, ai_ids: JSON.parse(g.ai_ids || '[]') })))
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch groups' })
  }
})

export default router
// ============================================
// AGENT EVENT INGESTION
// ============================================

/**
 * POST /api/messaging/ai/event
 * Background agent sends file/browser/window events
 */
router.post('/ai/event', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { client_id, type, data, timestamp } = req.body

    if (!client_id || !type) {
      return res.status(400).json({ error: 'client_id and type required' })
    }

    // Store event in activity log for AI reverse-engineering
    await db('activity_log').insert({
      client_id,
      event_type: type,
      event_data: JSON.stringify(data || {}),
      created_at: timestamp || new Date().toISOString()
    })

    // Update AI instance heartbeat if this is a heartbeat event
    if (type === 'heartbeat') {
      const existing = await db('ai_instances').where('ai_id', client_id).first()
      if (existing) {
        await db('ai_instances').where('ai_id', client_id).update({
          last_seen: new Date().toISOString(),
          is_online: true
        })
      } else {
        await db('ai_instances').insert({
          ai_id: client_id,
          client_name: client_id,
          last_seen: new Date().toISOString(),
          is_online: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Agent event error:', err.message)
    res.status(500).json({ error: 'Failed to ingest event' })
  }
})

// ============================================
// AI CLIENT REGISTRATION (called on first install)
// ============================================

router.post('/ai/register-client', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { ai_id, username, telegram_id, client_name, fingerprint } = req.body

    if (!ai_id || !username) {
      return res.status(400).json({ error: 'ai_id and username required' })
    }

    const existing = await db('ai_instances').where('ai_id', ai_id).first()

    if (existing) {
      await db('ai_instances').where('ai_id', ai_id).update({
        client_name: client_name || existing.client_name,
        username: username,
        telegram_id: telegram_id || existing.telegram_id,
        fingerprint: fingerprint || existing.fingerprint,
        last_seen: new Date().toISOString(),
        is_online: true,
        updated_at: new Date().toISOString()
      })
      return res.json({ success: true, ai_id, message: 'Client updated' })
    }

    await db('ai_instances').insert({
      ai_id,
      client_name: client_name || username,
      username,
      telegram_id: telegram_id || null,
      fingerprint: fingerprint || '',
      capabilities: JSON.stringify(['chat', 'suggestions', 'file_watch']),
      last_seen: new Date().toISOString(),
      is_online: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })

    // Auto-add welcome lesson
    await db('knowledge_base').insert({
      content: `New client registered: ${client_name || username} (${ai_id}). Telegram: ${telegram_id || 'N/A'}`,
      category: 'system_event',
      is_active: true,
      created_at: new Date().toISOString()
    })

    res.status(201).json({ success: true, ai_id, message: 'Client registered successfully' })
  } catch (err) {
    console.error('Registration error:', err)
    res.status(500).json({ error: 'Registration failed' })
  }
})

// ============================================
// EDIT / DELETE AI INSTANCES
// ============================================

router.put('/ai/:ai_id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { client_name, username, telegram_id } = req.body

    const existing = await db('ai_instances').where('ai_id', req.params.ai_id).first()
    if (!existing) return res.status(404).json({ error: 'AI instance not found' })

    await db('ai_instances').where('ai_id', req.params.ai_id).update({
      client_name: client_name || existing.client_name,
      username: username || existing.username,
      telegram_id: telegram_id !== undefined ? telegram_id : existing.telegram_id,
      updated_at: new Date().toISOString()
    })

    const updated = await db('ai_instances').where('ai_id', req.params.ai_id).first()
    res.json({ success: true, instance: updated })
  } catch (err) {
    res.status(500).json({ error: 'Update failed' })
  }
})

router.delete('/ai/:ai_id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const deleted = await db('ai_instances').where('ai_id', req.params.ai_id).del()
    if (!deleted) return res.status(404).json({ error: 'AI instance not found' })

    // Also delete associated messages
    await db('portal_messages').where('to_ai_id', req.params.ai_id).del()
    await db('portal_messages').where('from', req.params.ai_id).del()

    res.json({ success: true, message: 'AI instance and messages deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' })
  }
})

// ============================================
// REAL-TIME AI SUGGESTIONS
// ============================================

router.post('/ai/suggest', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { action, context, client_id } = req.body

    if (!action) return res.status(400).json({ error: 'action required' })

    // Get learned workflows for context
    const workflows = await db('knowledge_base')
      .where('category', 'learned_workflow')
      .where('is_active', true)
      .limit(5)

    // Get recent lessons
    const lessons = await db('knowledge_base')
      .where('is_active', true)
      .whereNot('category', 'learned_workflow')
      .orderBy('created_at', 'desc')
      .limit(10)

    const workflowSummary = workflows.map(w => w.content).join('\n')
    const lessonSummary = lessons.map(l => l.content).join('\n')

    const prompt = `An employee just performed this action: ${action}
Current context: ${JSON.stringify(context || {})}

Learned workflows:
${workflowSummary || 'No workflows learned yet.'}

Recent lessons:
${lessonSummary || 'No lessons yet.'}

Based on this, what should they do NEXT? Respond in Amharic ONLY. One short, actionable sentence. If no suggestion, respond with exactly: "ምንም አስተያየት የለም"`

    const { default: aiService } = await import('../services/ai.js')
    const result = await aiService.chat([
      { role: 'system', content: 'You are a workflow assistant for an Ethiopian document agency. Respond ONLY in Amharic. Be concise. One sentence max.' },
      { role: 'user', content: prompt }
    ])

    const suggestion = result.success ? result.message : null
    const hasSuggestion = suggestion && suggestion !== 'ምንም አስተያየት የለም'

    // Log the suggestion event
    await db('activity_log').insert({
      client_id: client_id || 'unknown',
      event_type: 'ai_suggestion',
      event_data: JSON.stringify({ action, suggestion: hasSuggestion ? suggestion : null }),
      created_at: new Date().toISOString()
    })

    res.json({
      suggestion: hasSuggestion ? suggestion : null,
      model: result.model || 'unknown'
    })
  } catch (err) {
    console.error('Suggestion error:', err)
    res.json({ suggestion: null })
  }
})

// ============================================
// LESSON CRUD (Full edit/delete support)
// ============================================

router.put('/lessons/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { content, category } = req.body

    const existing = await db('knowledge_base').where('id', req.params.id).first()
    if (!existing) return res.status(404).json({ error: 'Lesson not found' })

    await db('knowledge_base').where('id', req.params.id).update({
      content: content !== undefined ? content.trim() : existing.content,
      category: category !== undefined ? category : existing.category,
      updated_at: new Date().toISOString()
    })

    const updated = await db('knowledge_base').where('id', req.params.id).first()
    res.json({ success: true, lesson: updated })
  } catch (err) {
    res.status(500).json({ error: 'Update failed' })
  }
})

// ============================================
// WORKFLOW LEARNING
// ============================================

router.post('/workflows/analyze', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { default: WorkflowLearner } = await import('../services/workflowLearner.js')
    const learner = new WorkflowLearner(db)
    const result = await learner.analyzeRecentActivity(req.body.hours || 24)
    res.json(result)
  } catch (err) {
    console.error('Workflow analysis error:', err)
    res.status(500).json({ error: 'Analysis failed' })
  }
})

router.get('/workflows', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { default: WorkflowLearner } = await import('../services/workflowLearner.js')
    const learner = new WorkflowLearner(db)
    const workflows = await learner.getLearnedWorkflows()
    res.json(workflows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch workflows' })
  }
})

router.post('/workflows/suggest', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { default: WorkflowLearner } = await import('../services/workflowLearner.js')
    const learner = new WorkflowLearner(db)
    const suggestion = await learner.suggestNextStep(req.body.client_id, req.body.context || {})
    res.json({ suggestion })
  } catch (err) {
    res.status(500).json({ error: 'Suggestion failed' })
  }
})
