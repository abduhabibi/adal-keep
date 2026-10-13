// src/routes/automations.js
/**
 * automations.js — HTTP surface for the lane-based automation queue.
 *
 * v3 — Preflight trimmed to the workflows that still run.
 *
 *   Kept:
 *     - police_certificate   → Photo / Passport / Slip files + Labor ID
 *     - musaned_add_candidate→ Passport Number, Full Name, DOB, Passport file
 *     - lmis                 → Labor ID
 *
 *   Removed:
 *     - contract_import_labour
 *     - delete_labour
 *
 *   Account loading below preflight keys off `workflowId.startsWith('musaned')`,
 *   which covers both musaned_login (legacy queued jobs) and
 *   musaned_add_candidate. Matches worker.js's image policy predicate and
 *   lmisWorkflow.js's dispatcher, so all three agree on what "is Musaned".
 *
 * The router is a factory: pass it the knex instance.
 *   app.use('/api', automationsRouter(db))
 */

import { Router } from 'express'
import { getWorkflow, listWorkflows } from '../services/workflows.js'

// Keep in sync with worker.js
const POLL_HINT_MS = 5000

export default function automationsRouter(db) {
  const router = Router()

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------
  async function loadProfile(profileId) {
    return db('profiles').where('id', profileId).first()
  }

  async function hasFile(profileId, fieldName) {
    const row = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.name', fieldName)
      .first()
    return !!row
  }

  /**
   * Load the credentials the runner expects in ctx, based on workflow ID.
   * Returns an object that gets merged into the job context JSON.
   *
   * NOTE: this is the one piece I could not see in the snippet you provided.
   * Point the two branches at your real credential source. The key names
   * (login_value/login_password, musaned_username/musaned_password/
   * musaned_name) are dictated by worker.js's ctx construction, so those
   * must not change.
   */
  async function loadCredentials(workflowId, profile) {
    const creds = {
      login_value: '',
      login_password: '',
      musaned_username: '',
      musaned_password: '',
      musaned_name: '',
    }

    if (workflowId.startsWith('musaned')) {
      // Musaned credentials — assumed to live on the profile or a joined
      // accounts row. Replace this lookup with your actual source.
      creds.musaned_username = profile.musaned_username || ''
      creds.musaned_password = profile.musaned_password || ''
      creds.musaned_name     = profile.musaned_name || profile.full_name || ''
    } else {
      // Generic portal credentials (LMIS etc.)
      creds.login_value    = profile.login_value || profile.labor_id || ''
      creds.login_password = profile.login_password || ''
    }

    return creds
  }

  // ------------------------------------------------------------------------
  // GET /workflows — what the UI can launch
  // ------------------------------------------------------------------------
  router.get('/workflows', (_req, res) => {
    try {
      res.json({ workflows: listWorkflows() })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ------------------------------------------------------------------------
  // POST /profiles/:profileId/automations/:workflowId/start
  // ------------------------------------------------------------------------
  router.post('/profiles/:profileId/automations/:workflowId/start', async (req, res) => {
    const profileId = Number(req.params.profileId)
    const { workflowId } = req.params

    if (!Number.isFinite(profileId)) {
      return res.status(400).json({ error: 'Invalid profileId' })
    }

    const workflow = getWorkflow(workflowId)
    if (!workflow) {
      return res.status(404).json({ error: `Unknown workflow: ${workflowId}` })
    }

    const profile = await loadProfile(profileId)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Preflight — depends on the workflow
    if (workflowId === 'police_certificate') {
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
    } else if (workflowId === 'musaned_add_candidate') {
      const prof = await db('profiles').where('id', profileId).first()
      const missing = []
      if (!prof?.passport_number || !String(prof.passport_number).trim()) missing.push('Passport Number')
      if (!prof?.full_name || !String(prof.full_name).trim())         missing.push('Full Name')
      if (!prof?.date_of_birth || !String(prof.date_of_birth).trim()) missing.push('Date of Birth')

      const hasPassport = await db('files')
        .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
        .where('profile_fields.profile_id', profileId)
        .andWhere('profile_fields.name', 'Passport')
        .first()
      if (!hasPassport) missing.push('Passport file')

      if (missing.length > 0) {
        return res.status(400).json({
          error: 'Profile is missing: ' + missing.join(', '),
          missing,
        })
      }
    }
    // All other workflow IDs skip preflight

    // Account loading — musaned* needs Musaned creds, everything else generic.
    const credentials = await loadCredentials(workflowId, profile)

    // Context object the runner reads. Keys must match worker.js's ctx.
    const context = {
      ...credentials,
      labor_id: profile.labor_id || '',
      destination_country: profile.destination_country || '',
    }

    try {
      const [id] = await db('automation_queue').insert({
        profile_id: profileId,
        workflow_id: workflowId,
        status: 'pending',
        current_step: 0,
        context: JSON.stringify(context),
        log: '[]',
        pause_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const jobId = typeof id === 'object' ? id.id : id
      console.log(`[automations] queued job #${jobId} ${workflowId} for profile ${profileId}`)

      return res.status(202).json({
        ok: true,
        jobId,
        workflowId,
        status: 'pending',
        pollAfterMs: POLL_HINT_MS,
      })
    } catch (e) {
      console.error('[automations] enqueue failed:', e)
      return res.status(500).json({ error: 'Failed to enqueue job', detail: e.message })
    }
  })

  // ------------------------------------------------------------------------
  // GET /profiles/:profileId/automations — job history for a profile
  // ------------------------------------------------------------------------
  router.get('/profiles/:profileId/automations', async (req, res) => {
    const profileId = Number(req.params.profileId)
    if (!Number.isFinite(profileId)) {
      return res.status(400).json({ error: 'Invalid profileId' })
    }
    try {
      const rows = await db('automation_queue')
        .where('profile_id', profileId)
        .orderBy('id', 'desc')
        .limit(100)
      res.json({ jobs: rows.map(deserializeJob) })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ------------------------------------------------------------------------
  // GET /automations/:id — one job, with parsed log/context
  // ------------------------------------------------------------------------
  router.get('/automations/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })
    const row = await db('automation_queue').where('id', id).first()
    if (!row) return res.status(404).json({ error: 'Job not found' })
    res.json({ job: deserializeJob(row) })
  })

  // ------------------------------------------------------------------------
  // POST /automations/:id/complete
  //
  // Human finished the manual step (solved reCAPTCHA, submitted a form, …).
  // Re-queue the job so the worker picks it up on the next poll and resumes
  // from where it paused.
  //
  // Musaned multi-stage: we stash the previous pause_reason (which encodes
  // the stage as `awaiting-musaned-<stage>`) into context.musanedStage before
  // clearing it, so the stage survives the paused → pending transition.
  // worker.js should prefer context.musanedStage when present; see note.
  // ------------------------------------------------------------------------
  router.post('/automations/:id/complete', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })

    const job = await db('automation_queue').where('id', id).first()
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (job.status !== 'paused') {
      return res.status(409).json({ error: `Job is ${job.status}, not paused` })
    }

    let ctx = {}
    try { ctx = JSON.parse(job.context || '{}') } catch {}

    if (job.pause_reason && job.pause_reason.startsWith('awaiting-musaned-')) {
      ctx.musanedStage = job.pause_reason
    }

    await db('automation_queue').where('id', id).update({
      status: 'pending',
      pause_reason: null,
      context: JSON.stringify(ctx),
      updated_at: new Date().toISOString(),
    })

    console.log(`[automations] job #${id} completed by human — re-queued`)
    res.json({ ok: true, jobId: id, status: 'pending' })
  })

  // ------------------------------------------------------------------------
  // POST /automations/:id/cancel
  // ------------------------------------------------------------------------
  router.post('/automations/:id/cancel', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' })

    const job = await db('automation_queue').where('id', id).first()
    if (!job) return res.status(404).json({ error: 'Job not found' })
    if (job.status === 'done' || job.status === 'failed') {
      return res.status(409).json({ error: `Job already ${job.status}` })
    }

    await db('automation_queue').where('id', id).update({
      status: 'failed',
      pause_reason: 'Cancelled by user',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    console.log(`[automations] job #${id} cancelled`)
    res.json({ ok: true, jobId: id, status: 'failed' })
  })

  return router
}

// --------------------------------------------------------------------------
// Shape helpers
// --------------------------------------------------------------------------
function deserializeJob(row) {
  let context = {}
  let log = []
  try { context = JSON.parse(row.context || '{}') } catch {}
  try { log     = JSON.parse(row.log     || '[]') } catch {}
  return { ...row, context, log }
}