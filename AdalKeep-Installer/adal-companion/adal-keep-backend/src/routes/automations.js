import express from 'express'
import { listWorkflows } from '../services/workflows.js'
import { drainQueue } from '../services/worker.js'

const router = express.Router()

// List workflows + latest run per workflow for a profile
router.get('/profiles/:profileId/automations', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const workflows = listWorkflows()
    const runs = await db('automation_queue')
      .where('profile_id', profileId)
      .orderBy('id', 'desc')
    const latest = {}
    for (const r of runs) if (!latest[r.workflow_id]) latest[r.workflow_id] = r
    res.json({ workflows: workflows.map(w => ({ ...w, latest: latest[w.id] || null })) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Enqueue a workflow
router.post('/profiles/:profileId/automations/:workflowId/start', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const workflowId = req.params.workflowId

    // Preflight — depends on the workflow
    // Musaned workflows need no files
    if (workflowId.startsWith('musaned')) {
      // skip file preflight
    } else if (workflowId === 'police_certificate') {
      const required = ['Photo', 'Passport', 'Slip']
      const missing = []
      for (const name of required) {
        const row = await db('files')
          .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
          .where('profile_fields.profile_id', profileId)
          .andWhere('profile_fields.name', name)
          .first()
        if (!row) missing.push(name)
      }
      const prof = await db('profiles').where('id', profileId).first()
      if (!prof?.labor_id || !String(prof.labor_id).trim()) missing.push('Labor ID')
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'Profile is missing: ' + missing.join(', '),
          missing,
        })
      }
    } else if (workflowId === 'contract_import_labour') {
      const prof = await db('profiles').where('id', profileId).first()
      const missing = []
      if (!prof?.labor_id || !String(prof.labor_id).trim()) missing.push('Labor ID')
      if (!prof?.destination_country || !String(prof.destination_country).trim()) missing.push('Destination Country')
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'Profile is missing: ' + missing.join(', '),
          missing,
        })
      }
    }

    // Resume an existing active run instead of duplicating
    const active = await db('automation_queue')
      .where({ profile_id: profileId, workflow_id: workflowId })
      .whereIn('status', ['running', 'paused', 'pending'])
      .orderBy('id', 'desc').first()
    if (active) {
      await db('automation_queue').where('id', active.id).update({
        status: 'pending',
        updated_at: new Date().toISOString(),
      })
      // wake the worker immediately
      drainQueue(db).catch(() => {})
      return res.json({ ok: true, runId: active.id, resumed: true })
    }

    // Load the right credentials table based on the workflow prefix
    let accountContext = {}
    const accountId = req.body?.account_id
    if (workflowId.startsWith('musaned')) {
      let acct = accountId ? await db('musaned_accounts').where('id', accountId).first() : null
      if (!acct) acct = await db('musaned_accounts').orderBy('is_default', 'desc').first()
      if (acct) {
        accountContext.musaned_username = acct.username
        accountContext.musaned_password = acct.password
        accountContext.musaned_name = acct.name
        accountContext.account_id = acct.id
        await db('musaned_accounts').where('id', acct.id).update({ last_used_at: new Date().toISOString() })
        console.log('[AUTO] loaded musaned account:', acct.name, 'username:', acct.username)
      }
    } else {
      // LMIS path (existing logic)
      let lid = accountId
      if (!lid) {
        const fallback = await db('lmis_accounts').orderBy('is_default', 'desc').first()
        if (fallback) lid = fallback.id
      }
      if (lid) {
        const acct = await db('lmis_accounts').where('id', lid).first()
        if (acct) {
          accountContext.login_value = acct.login_value || acct.phone || ''
          accountContext.login_password = acct.password || ''
          accountContext.account_name = acct.name
          accountContext.account_id = acct.id
          await db('lmis_accounts').where('id', acct.id).update({ last_used_at: new Date().toISOString() })
          console.log('[AUTO] loaded lmis account:', acct.name, 'login:', accountContext.login_value)
        }
      }
    }

    const [runId] = await db('automation_queue').insert({
      profile_id: profileId,
      workflow_id: workflowId,
      account_id: accountId || null,
      status: 'pending',
      current_step: 0,
      context: JSON.stringify(accountContext),
      log: '[]',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // wake the worker immediately instead of waiting for the next poll
    drainQueue(db).catch(e => console.error('[AUTO] drain error:', e.message))

    res.json({ ok: true, runId, resumed: false })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Get one run with its log
router.get('/automations/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const row = await db('automation_queue').where('id', req.params.id).first()
    if (!row) return res.status(404).json({ error: 'Not found' })
    let log = []
    try { log = JSON.parse(row.log || '[]') } catch {}
    res.json({ ...row, log })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Resume a paused run
router.post('/automations/:id/resume', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('automation_queue').where('id', req.params.id).update({
      status: 'pending',
      updated_at: new Date().toISOString(),
    })
    drainQueue(db).catch(() => {})
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Pause a running run
router.post('/automations/:id/pause', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('automation_queue').where('id', req.params.id).update({
      status: 'paused',
      pause_reason: req.body?.reason || 'Paused by user',
      updated_at: new Date().toISOString(),
    })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Cancel a run
router.post('/automations/:id/cancel', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('automation_queue').where('id', req.params.id).update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Mark a paused run as fully complete: closes its browser tab, sets status=done.
router.post('/automations/:id/complete', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)

    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })

    // Try to find and close the browser tab tagged with this job id.
    // Note: browser.pages() only returns pages in the default context —
    // worker.js pages live in per-lane contexts, so we walk browser.targets()
    // instead to see every open page across every context.
    let tabClosed = false
    try {
      const { getBrowser } = await import('../services/browser.js')
      const browser = await getBrowser()
      const allPages = []
      for (const target of browser.targets()) {
        if (target.type() !== 'page') continue
        try {
          const p = await target.page()
          if (p) allPages.push(p)
        } catch {}
      }
      for (const p of allPages) {
        try {
          const tag = await p.evaluate(() => {
            try { return localStorage.getItem('adal_job_id') } catch { return null }
          })
          if (String(tag) === String(runId)) {
            await p.close()
            tabClosed = true
            console.log(`[complete] closed tab for job #${runId}`)
            break
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[complete] could not scan browser pages:', e.message)
    }

    await db('automation_queue').where('id', runId).update({
      status: 'done',
      pause_reason: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    res.json({ ok: true, tabClosed })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router