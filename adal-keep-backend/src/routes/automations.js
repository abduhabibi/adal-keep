import express from 'express'
import { listWorkflows } from '../services/workflows.js'
import { dispatchRun, runStatus, queueSnapshot } from '../services/worker.js'
import { markCancelled, isCancelled } from '../services/cancellation.js'
import { closeRunTab } from '../services/tabManager.js'
import { assertPoliceReady, getProfileVerification, runPassportVerification } from '../services/verification.js'

const router = express.Router()

/** Run rows go to the browser: never send login passwords back with them. */
function publicRun(row) {
  if (!row) return row
  let ctx = {}
  try { ctx = JSON.parse(row.context || '{}') } catch {}
  for (const k of Object.keys(ctx)) if (/password/i.test(k)) delete ctx[k]
  return { ...row, context: JSON.stringify(ctx) }
}

// ---------------------------------------------------------------------------
// What the operator is told right after a click. Every answer says whether
// the run is working now (in its own tab) or waiting, and what is ahead of it.
// ---------------------------------------------------------------------------
const isRetryWait = (row) => row?.status === 'pending' && String(row.pause_reason || '').startsWith('Retry ')

function retryNote(row) {
  const at = new Date(row.updated_at)
  const when = isNaN(at.getTime()) ? 'shortly' : `at ${at.toLocaleTimeString()}`
  return `It is waiting to retry after a failed attempt (${when}).`
}

function otherRunsText(n) {
  if (n <= 0) return 'No other run is working.'
  return n === 1 ? '1 other run is working.' : `${n} other runs are working.`
}

/** `s` comes from dispatchRun/runStatus: { state, ahead, running, max }. */
function runMessage(runId, s, verb) {
  const slots = `${s.running} of ${s.max} running`
  if (s.state === 'running') return `Run #${runId} ${verb} — working now in its own browser tab (${slots}).`
  const ahead = s.ahead === 0 ? 'it is next in line'
    : s.ahead === 1 ? '1 run is ahead of it'
    : `${s.ahead} runs are ahead of it`
  return `Run #${runId} ${verb} — waiting in line: ${ahead} (${slots}). It starts by itself when a slot frees.`
}

// List workflows + latest run per workflow for a profile, and what is working now
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
    res.json({
      workflows: workflows.map(w => ({ ...w, latest: latest[w.id] || null })),
      queue: queueSnapshot(),
    })
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
      // Musaned needs a personal photo, marital status, religion and a mobile number
      const prof = await db('profiles').where('id', profileId).first()
      const { musanedMissing, photoOnFile } = await import('../services/musanedPreflight.js')
      const missing = musanedMissing(prof, await photoOnFile(db, profileId))
      if (missing.length) {
        return res.status(400).json({
          error: 'Musaned not started. Profile is missing: ' + missing.join(', '),
          missing,
        })
      }
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
        const why = (verification?.problems || [])[0]
        return res.status(400).json({
          error: `Passport verification is ${gate.ticks}/3 green ticks — ` + gate.blockers.join('; ') + (why ? `. ${why}` : ''),
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

    // One run per profile + workflow at a time. A second click never starts a
    // second copy (that is what put two runs in one tab): it reports on the
    // run that already exists, and resumes it if it was paused.
    const active = await db('automation_queue')
      .where({ profile_id: profileId, workflow_id: workflowId })
      .whereIn('status', ['running', 'paused', 'pending'])
      .orderBy('id', 'desc').first()
    if (active) {
      const runId = active.id
      if (active.status === 'running') {
        const s = await runStatus(db, runId)
        return res.json({
          ok: true, runId, resumed: true, ...s, state: 'running',
          message: `Run #${runId} is already working in its own tab — not started a second time. ${otherRunsText(s.running - 1)}`,
        })
      }
      if (isRetryWait(active)) {
        return res.json({
          ok: true, runId, resumed: true, state: 'queued',
          message: `Run #${runId} is already queued. ${retryNote(active)}`,
        })
      }
      if (active.status === 'paused') {
        await db('automation_queue').where('id', runId).andWhere('status', 'paused')
          .update({ status: 'pending', updated_at: new Date().toISOString() })
      }
      const s = await dispatchRun(db, runId)
      const verb = active.status === 'paused' ? 'resumed' : 'was already queued'
      return res.json({ ok: true, runId, resumed: true, ...s, message: runMessage(runId, s, verb) })
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

    // Start it now if a slot is free; otherwise it waits in line and starts by
    // itself. Either way the answer says which, before the browser does anything.
    const s = await dispatchRun(db, runId)
    res.json({ ok: true, runId, resumed: false, ...s, message: runMessage(runId, s, s.state === 'running' ? 'started' : 'queued') })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Police certificate runs that are ready for the person's Submit: the page
// plays a chime when a new one shows up.
router.get('/automations/ready-for-submit', async (req, res) => {
  try {
    const db = req.app.locals.db
    const rows = await db('automation_queue')
      .where({ workflow_id: 'police_certificate', status: 'paused', pause_reason: 'awaiting-human-submit' })
      .select('id', 'profile_id', 'updated_at')
      .orderBy('id', 'desc').limit(50)
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Get one run with its log (and, while it waits, where it stands in line)
router.get('/automations/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const row = await db('automation_queue').where('id', req.params.id).first()
    if (!row) return res.status(404).json({ error: 'Not found' })
    let log = []
    try { log = JSON.parse(row.log || '[]') } catch {}
    const queue = row.status === 'pending' ? await runStatus(db, row.id) : null
    res.json({ ...publicRun(row), log, queue })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Continue a paused run (after the person signed in, entered the OTP, ...)
router.post('/automations/:id/resume', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)
    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })
    if (row.status === 'running') {
      return res.status(409).json({ error: `Run #${runId} is already working in its own tab.` })
    }
    if (isRetryWait(row)) {
      return res.json({ ok: true, state: 'queued', message: `Run #${runId} is already queued. ${retryNote(row)}` })
    }
    if (row.status !== 'paused' && row.status !== 'pending') {
      return res.status(409).json({ error: `Run #${runId} is ${row.status} — nothing to continue. Start it again from its card.` })
    }
    if (row.status === 'paused') {
      await db('automation_queue').where('id', runId).andWhere('status', 'paused')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
    }
    const s = await dispatchRun(db, runId)
    res.json({ ok: true, ...s, message: runMessage(runId, s, row.status === 'paused' ? 'continued' : 'was already queued') })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Pause = take a waiting run out of the line. A run that is working cannot be
// stopped mid-step without losing its place in the portal form; it pauses by
// itself when it needs a person, and Cancel stops it at once.
router.post('/automations/:id/pause', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)
    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })
    if (row.status === 'running') {
      return res.status(409).json({
        error: `Run #${runId} is working in its tab and cannot be paused mid-step. It pauses by itself when it needs you; use Cancel to stop it now.`,
      })
    }
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `Run #${runId} is ${row.status} — nothing to pause.` })
    }
    const n = await db('automation_queue').where('id', runId).andWhere('status', 'pending').update({
      status: 'paused',
      pause_reason: req.body?.reason || 'Paused by user',
      updated_at: new Date().toISOString(),
    })
    if (!n) return res.status(409).json({ error: `Run #${runId} started working a moment ago — use Cancel to stop it.` })
    res.json({ ok: true, message: `Run #${runId} paused — taken out of the line. Press Continue to queue it again.` })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Cancel a run — stop it and close the one tab it owns. Other runs' tabs and
// the operator's own tabs are never touched.
router.post('/automations/:id/cancel', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)
    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })
    if (['done', 'failed', 'cancelled'].includes(row.status)) {
      return res.status(409).json({ error: `Run #${runId} already ${row.status === 'done' ? 'finished' : row.status}.` })
    }

    // 1. A working run stops at its next step (the workflows check this flag).
    //    Flagged for every status: a run claimed a moment ago is caught too.
    markCancelled(runId)

    // 2. Record the cancellation (source of truth for the UI).
    await db('automation_queue').where('id', runId).update({
      status: 'cancelled',
      pause_reason: 'Cancelled by user',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // 3. Close the tab this run owns, found through the run → tab registry.
    let tabClosed = false
    try { tabClosed = await closeRunTab(runId) } catch (e) { console.warn('[cancel] could not close tab:', e.message) }

    // Runs cancelled a moment ago are still unwinding: they do not count.
    const others = queueSnapshot().running.filter(r => r.runId !== runId && !isCancelled(r.runId)).length
    const message = row.status === 'pending'
      ? `Run #${runId} cancelled — taken out of the line. ${otherRunsText(others)}`
      : `Run #${runId} cancelled${tabClosed ? ' and its tab closed' : ''}. ${otherRunsText(others)}`
    res.json({ ok: true, tabClosed, message })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Mark a paused run as fully complete (the person pressed Submit / SAVE in its
// tab): closes that tab, sets status=done.
router.post('/automations/:id/complete', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)

    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })
    if (row.status !== 'paused') {
      return res.status(409).json({ error: `Run #${runId} is ${row.status} — only a run waiting for you can be marked complete.` })
    }

    let tabClosed = false
    try { tabClosed = await closeRunTab(runId) } catch (e) { console.warn('[complete] could not close tab:', e.message) }

    await db('automation_queue').where('id', runId).update({
      status: 'done',
      pause_reason: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    res.json({
      ok: true,
      tabClosed,
      message: `Run #${runId} marked complete${tabClosed ? ' — its tab was closed' : ''}.`,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
