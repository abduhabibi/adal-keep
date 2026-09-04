import { approvePextranNext } from '../services/pextranAgent.js'
import { Router } from 'express'
import { attachFileToProfile } from '../services/profileFiles.js'
import { findExistingProfile } from '../services/fileMatcher.js'

const router = Router()

router.post('/:id/approve', async (req, res) => {
  try {
    const db = req.app.locals.db
    const task = await db('tasks').where({ id: req.params.id }).first()
    if (!task) return res.status(404).json({ error: 'Task not found' })
    if (task.status === 'completed' || task.status === 'done') {
      return res.json({ success: true, message: 'Already done' })
    }

    let payload = {}
    try {
      payload = task.payload ? JSON.parse(task.payload) : {}
    } catch {}

    // Pextran HITL — click Next / fill known fields
    if (task.type === 'ai_pextran') {
      try {
        const result = await approvePextranNext(task)
        return res.json({ success: true, ...result })
      } catch (e) {
        return res.status(500).json({ error: e.message })
      }
    }

    if (task.type === 'ai_create_profile' || task.type === 'ai_pextran_approval') {
      const ex = payload.extracted || {}
      const isApproval = task.type === 'ai_pextran_approval'

      const existing = await findExistingProfile(ex)
      if (existing) {
        if (payload.storedPath) {
          try {
            const attachAs2 = payload.field && payload.field !== 'Other' ? payload.field : 'Passport'
            await attachFileToProfile(
              existing.id,
              attachAs2,
              payload.storedPath,
              payload.originalFilename
            )
          } catch {}
        }
        const taskCols = await db('tasks').columnInfo()
        const taskUpdate = { status: 'completed', updated_at: new Date().toISOString() }
        if (taskCols.profile_id) taskUpdate.profile_id = existing.id
        await db('tasks').where({ id: task.id }).update(taskUpdate)

        const msg = isApproval 
          ? `Pextran automation approved for ${existing.full_name}. Opening Brave...`
          : `ካለ ፕሮፋይል ጋር ተገናኝቷል፡ ${existing.full_name} (#${existing.id})`

        // Trigger Pextran flow (pennywise - reuse existing agent)
        if (isApproval) {
          try {
            const { startNewRecruit } = await import('./pextranAgent.js')
            await startNewRecruit(existing.full_name)
          } catch (e) {
            console.warn('Auto Pextran start failed:', e.message)
          }
        }

        return res.json({
          success: true,
          profileId: existing.id,
          message: msg
        })
      }

      const cols = await db('profiles').columnInfo()
      const candidate = {
        full_name: ex.full_name || 'Unknown',
        passport_number: ex.passport_number || null,
        national_id: ex.national_id || null,
        date_of_birth: ex.date_of_birth || null,
        date_of_birth_ec: ex.date_of_birth_ec || null,
        passport_issue_date: ex.issued_date || ex.passport_issue_date || null,
        passport_expiry_date: ex.expiry_date || ex.passport_expiry_date || null,
        nationality: ex.nationality || null,
        gender: ex.gender || null,
        phone_number: ex.phone_number || null,
        status: 'in_progress',
        created_by: (req.auth?.uid ? (await req.app.locals.db('users').where({ id: req.auth.uid }).first().then(u => u?.name || 'AI-Approved').catch(() => 'AI-Approved')) : 'AI-Approved'),
        notes: `From ${payload.originalFilename || ''} (task #${task.id})`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
      const row = {}
      for (const [k, v] of Object.entries(candidate)) {
        if (cols[k]) row[k] = v
      }
      if (!row.full_name && cols.full_name) row.full_name = 'Unknown'

      const [profileId] = await db('profiles').insert(row)

      const taskCols = await db('tasks').columnInfo()
      const taskUpdate = { status: 'completed', updated_at: new Date().toISOString() }
      if (taskCols.profile_id) taskUpdate.profile_id = profileId
      await db('tasks').where({ id: task.id }).update(taskUpdate)

      // Removed automatic "Complete files of: X" checklist task as requested.
      // New flow will create Pextran approval task when all required documents (including Self Video + Photo) are ready.

      if (payload.storedPath) {
        try {
          const attachAs =
            payload.field && payload.field !== 'Other' ? payload.field : 'Passport'
          await attachFileToProfile(
            profileId,
            attachAs,
            payload.storedPath,
            payload.originalFilename
          )
        } catch (e) {
          console.warn('passport attach', e.message)
        }
      }

      return res.json({
        success: true,
        profileId,
        message: `ፕሮፋይል ተፈጥሯል፡ ${ex.full_name} (#${profileId})`
      })
    }

    // Default: mark completed
    await db('tasks').where({ id: task.id }).update({
      status: 'completed',
      updated_at: new Date().toISOString()
    })
    res.json({ success: true })
  } catch (err) {
    console.error('[ai-tasks/approve]', err)
    res.status(500).json({ error: err.message })
  }
})

router.post('/:id/reject', async (req, res) => {
  try {
    await req.app.locals.db('tasks').where({ id: req.params.id }).update({
      status: 'rejected',
      updated_at: new Date().toISOString()
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
