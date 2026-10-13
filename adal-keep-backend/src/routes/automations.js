import express from 'express'
import { listWorkflows } from '../services/workflows.js'
import { drainQueue } from '../services/worker.js'
import { markCancelled } from '../services/cancellation.js'
import { assertPoliceReady, getProfileVerification, runPassportVerification } from '../services/verification.js'

const router = express.Router()

// List workflows + latest run per workflow for a profile
/** Run rows go to the browser: never send login passwords back with them. */
function publicRun(row) {
  if (!row) return row
  let ctx = {}
  try { ctx = JSON.parse(row.context || '{}') } catch {}
  for (const k of Object.keys(ctx)) if (/password/i.test(k)) delete ctx[k]
  return { ...row, context: JSON.stringify(ctx) }
}

router.get('/profiles/:profileId/automations', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const workflows = listWorkflows()
    const runs = await db('automation_queue')
      .where('profile_id', profileId)
      .orderBy('id', 'desc')
    const latest = {}
    for (const r of runs) if (!latest[r.workflow_id]) latest[r.workflow_id] = publicRun(r)
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

      // HARD GATE — police clearance only unlocks at 3/3 green ticks.
      // A file existing is not the same as a document we could read and
      // prove: this is what stops a blurry or blank passport photo from
      // driving a real government submission.
      let gate = await assertPoliceReady(profileId, { handle: db })
      if (!gate.ok) {
        // Re-read the passport once before refusing: a stored check can be
        // stale (ingested before the MinerU gate existed, or re-uploaded).
        try { await runPassportVerification(profileId, { handle: db }) }
        catch (e) { console.warn('[AUTO] passport re-check failed:', e.message) }
        gate = await assertPoliceReady(profileId, { handle: db })
      }
      if (!gate.ok) {
        const verification = await getProfileVerification(profileId, { handle: db })
        return res.status(400).json({
          error: `Passport verification is ${gate.ticks}/3 green ticks — ` + gate.blockers.join('; '),
          verification_required: true,
          ticks: gate.ticks,
          blockers: gate.blockers,
          verification,
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

    // The operator may hand-pick WHICH numbered agent runs this job (the
    // "choose an agent" prompt). Store its lane id so only that lane claims it.
    let preferredLane = Number(req.body?.agent_lane_id)
    if (!Number.isFinite(preferredLane) || preferredLane <= 0) preferredLane = null

    // Resume an existing active run instead of duplicating
    const active = await db('automation_queue')
      .where({ profile_id: profileId, workflow_id: workflowId })
      .whereIn('status', ['running', 'paused', 'pending'])
      .orderBy('id', 'desc').first()
    if (active) {
      const patch = { status: 'pending', updated_at: new Date().toISOString() }
      // Re-point an idle run at the agent the operator just chose (a running
      // one keeps its current agent).
      if (preferredLane) patch.preferred_lane = preferredLane
      await db('automation_queue').where('id', active.id).update(patch)
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
      preferred_lane: preferredLane,
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
    res.json({ ...publicRun(row), log })
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

// Cancel a run — signal the running agent to STOP and close its tab.
router.post('/automations/:id/cancel', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)

    // 1. Flip the cooperative-cancel flag so the in-flight workflow stops at
    //    its next step instead of running to completion.
    markCancelled(runId)

    // 2. Record the cancellation (source of truth for the UI).
    await db('automation_queue').where('id', runId).update({
      status: 'cancelled',
      pause_reason: 'Cancelled by user',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // 3. Best-effort: close the browser tab tagged with this job id so the
    //    agent visibly stops working.
    let tabClosed = false
    try {
      const { getBrowser } = await import('../services/browser.js')
      const browser = await getBrowser()
      for (const target of browser.targets()) {
        if (target.type() !== 'page') continue
        try {
          const p = await target.page()
          if (!p) continue
          const tag = await p.evaluate(() => {
            try { return localStorage.getItem('adal_job_id') } catch { return null }
          })
          if (String(tag) === String(runId)) { await p.close(); tabClosed = true; break }
        } catch {}
      }
    } catch (e) {
      console.warn('[cancel] could not close tab:', e.message)
    }

    res.json({ ok: true, tabClosed })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Mark a paused run as fully complete: closes its browser tab, sets status=done.
router.post('/automations/:id/complete', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)

    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })

    // Find the browser tab tagged with this job id. If that tab belongs to a
    // PINNED agent (locked to a portal) we KEEP it open so the logged-in
    // session carries over to the next Musaned/LMIS job — no re-login.
    // Note: browser.pages() only returns pages in the default context —
    // worker.js pages live in per-lane contexts, so we walk browser.targets()
    // instead to see every open page across every context.
    let tabClosed = false
    let tabKept = false
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
          const info = await p.evaluate(() => {
            try {
              return {
                job: localStorage.getItem('adal_job_id'),
                keep: localStorage.getItem('adal_keep_tab') === '1',
              }
            } catch { return { job: null, keep: false } }
          })
          if (String(info.job) === String(runId)) {
            if (info.keep) {
              // Pinned agent → keep the logged-in tab for the next job.
              await p.evaluate(() => {
                try { localStorage.removeItem('adal_job_id') } catch {}
              }).catch(() => {})
              tabKept = true
              console.log(`[complete] kept session tab for job #${runId} (pinned agent)`)
            } else {
              await p.close()
              tabClosed = true
              console.log(`[complete] closed tab for job #${runId}`)
            }
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

    res.json({ ok: true, tabClosed, tabKept })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router