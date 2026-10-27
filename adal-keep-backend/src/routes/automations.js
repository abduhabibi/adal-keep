import express from 'express'
import { listWorkflows } from '../services/workflows.js'
import { dispatchRun, runStatus, queueSnapshot } from '../services/worker.js'
import { markCancelled, isCancelled } from '../services/cancellation.js'
import { forgetRunTab } from '../services/tabManager.js'
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
    if (workflowId === 'musaned_check_chosen') {
      const prof = await db('profiles').where('id', profileId).first()
      if (!prof?.passport_number || !String(prof.passport_number).trim()) {
        return res.status(400).json({ error: 'Profile is missing the passport number', missing: ['Passport number'] })
      }
    } else if (workflowId.startsWith('musaned')) {
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
    } else if (workflowId === 'wafid_book') {
      const prof = await db('profiles').where('id', profileId).first()
      const { bookingValues, missingForBooking } = await import('../services/wafidWorkflow.js')
      const em = await db('settings').where('key', 'agency_email').first().catch(() => null)
      const missing = missingForBooking(bookingValues(prof || {}, { email: em?.value || '' }))
      if (missing.length) {
        return res.status(400).json({ error: 'Profile is missing for Wafid: ' + missing.join(', '), missing })
      }
    } else if (workflowId === 'wafid_check' || workflowId === 'wafid_slip') {
      const prof = await db('profiles').where('id', profileId).first()
      if (!prof?.passport_number || !String(prof.passport_number).trim()) {
        return res.status(400).json({ error: 'Profile is missing the passport number', missing: ['Passport number'] })
      }
    } else if (workflowId === 'insurance_certificate') {
      const prof = await db('profiles').where('id', profileId).first()
      const { insuranceValues, missingForInsurance } = await import('../services/insuranceCertificate.js')
      const missing = missingForInsurance(insuranceValues(prof || {}))
      if (missing.length) return res.status(400).json({ error: 'Profile is missing for the insurance: ' + missing.join(', '), missing })
      if (!(await db('insurance_accounts').first())) return res.status(400).json({ error: 'No insurance account yet — add one under "Insurance login account"', missing: ['Insurance account'] })
    } else if (workflowId === 'mofa_visa') {
      const prof = await db('profiles').where('id', profileId).first()
      const { visaValues, missingForVisa } = await import('../services/mofaVisa.js')
      const photo = await db('files')
        .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
        .where('profile_fields.profile_id', profileId).andWhere('profile_fields.name', 'Photo').first()
      const missing = missingForVisa(visaValues(prof || {}, { photoPath: photo ? 'yes' : '' }))
      if (missing.length) {
        return res.status(400).json({ error: 'Profile is missing for the visa: ' + missing.join(', '), missing })
      }
      const acct = await db('visa_accounts').first()
      if (!acct) return res.status(400).json({ error: 'No visa platform account yet — add one under "Visa platform login account"', missing: ['Visa platform account'] })
    } else if (workflowId === 'lmis_contract') {
      const prof = await db('profiles').where('id', profileId).first()
      if (!prof?.labor_id || !String(prof.labor_id).trim()) {
        return res.status(400).json({ error: 'Profile is missing the Labor ID', missing: ['Labor ID'] })
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
      if (active.pause_reason === 'awaiting-visa-save') {
        return res.json({
          ok: true, runId, resumed: true, state: 'paused',
          message: `Run #${runId} filled the visa form already — press Save in its tab, then "✔️ Visa saved".`,
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
    } else if (workflowId.startsWith('insurance')) {
      let acct = accountId ? await db('insurance_accounts').where('id', accountId).first() : null
      if (!acct) acct = await db('insurance_accounts').orderBy('is_default', 'desc').first()
      if (acct) {
        accountContext.insurance_username = acct.username
        accountContext.insurance_password = acct.password
        accountContext.insurance_name = acct.name
        accountContext.account_id = acct.id
        await db('insurance_accounts').where('id', acct.id).update({ last_used_at: new Date().toISOString() })
      }
    } else if (workflowId.startsWith('mofa')) {
      // One visa platform account for every visa run.
      let acct = accountId ? await db('visa_accounts').where('id', accountId).first() : null
      if (!acct) acct = await db('visa_accounts').orderBy('is_default', 'desc').first()
      if (acct) {
        accountContext.visa_username = acct.username
        accountContext.visa_password = acct.password
        accountContext.visa_name = acct.name
        accountContext.account_id = acct.id
        await db('visa_accounts').where('id', acct.id).update({ last_used_at: new Date().toISOString() })
      }
    } else if (!workflowId.startsWith('wafid')) {
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
// Profiles with a run working now ('running') or waiting ('waiting': queued,
// or paused for a person). Used by the "Run" filter on the profile lists.
router.get('/automations/active', async (req, res) => {
  try {
    const db = req.app.locals.db
    const rows = await db('automation_queue').whereIn('status', ['running', 'pending', 'paused']).select('profile_id', 'status')
    const by = new Map()
    for (const r of rows) {
      const st = r.status === 'running' ? 'running' : 'waiting'
      if (by.get(r.profile_id) !== 'running') by.set(r.profile_id, st)
    }
    res.json([...by].map(([profile_id, state]) => ({ profile_id, state })))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Where every profile stands in the whole journey (Musaned → employer →
// Wafid → LMIS contract → visa). Used by the "Stage" filter on the lists.
export const STAGES = [
  ['visa_applied', 'Visa applied'],
  ['visa', 'Visa — form filled, waiting for Save'],
  ['visa_ready', 'LMIS contract done — ready for visa'],
  ['lmis_contract', 'LMIS contract in progress'],
  ['insured', 'Insurance certificate done'],
  ['insurance', 'Insurance certificate — waiting for you'],
  ['contract_ready', 'Wafid FIT — ready for LMIS contract'],
  ['medical_fit', 'Wafid FIT — no employer yet'],
  ['wafid', 'Wafid booked'],
  ['chosen', 'Chosen by an employer'],
  ['musaned', 'On Musaned — waiting for an employer'],
  ['other_agency', 'Registered by another agency'],
  ['new', 'Not on Musaned yet'],
]

export function stageOf(p, runs = {}) {
  const live = (r) => r && ['running', 'pending', 'paused'].includes(r.status)
  const visa = String(p.visa_stage || '')
  if (/applied/i.test(visa)) return 'visa_applied'
  if (live(runs.mofa_visa) || /waiting|filled/i.test(visa)) return 'visa'
  if (runs.lmis_contract?.status === 'done') return 'visa_ready'
  if (live(runs.lmis_contract)) return 'lmis_contract'
  if (runs.insurance_certificate?.status === 'done') return 'insured'
  if (live(runs.insurance_certificate)) return 'insurance'
  if (p.status === 'medical_fit') return p.chosen_at ? 'contract_ready' : 'medical_fit'
  if (p.status === 'medical_applied' || live(runs.wafid_book) || runs.wafid_book?.status === 'done') return 'wafid'
  if (p.chosen_at) return 'chosen'
  if (/another agency/i.test(p.musaned_stage || '')) return 'other_agency'
  if (p.musaned_stage || runs.musaned_add_candidate?.status === 'done') return 'musaned'
  return 'new'
}

/**
 * One profile's journey, two tracks from the same start:
 *   LMIS:    CV → Musaned → Wafid → LMIS contract
 *   Embassy: CV → Musaned → Wafid → Tasheer → Insurance → Enjaz · Visa
 *            (Enjaz is the visa platform: one step)
 * Each step: state 'done' | 'active' (working or waiting for a person) |
 * 'failed' | 'todo' | 'soon' (not built yet), and a short note.
 */
export function journeyOf(p, runs = {}, hasCv = false) {
  const live = (r) => r && ['running', 'pending', 'paused'].includes(r.status)
  const step = (key, title, state, note = '', workflow = '') => ({ key, title, state, note, workflow })
  const fromRun = (r, doneNote = '') => r?.status === 'done' ? ['done', doneNote]
    : live(r) ? ['active', r.status === 'paused' ? 'waiting for you' : r.status === 'running' ? 'working now' : 'in line']
    : r?.status === 'failed' ? ['failed', 'last run failed'] : ['todo', '']
  const cv = step('cv', 'CV', hasCv ? 'done' : 'todo', hasCv ? 'made' : '')
  const added = runs.musaned_add_candidate?.status === 'done' || !!p.musaned_stage
  const m = live(runs.musaned_add_candidate) ? fromRun(runs.musaned_add_candidate)
    : /another agency/i.test(p.musaned_stage || '') ? ['failed', 'registered by another agency']
    : added ? ['done', p.chosen_at ? `chosen ${String(p.chosen_at).slice(0, 10)}` : 'not chosen yet'] : ['todo', '']
  const musaned = step('musaned', 'Musaned', m[0], m[1], 'musaned_add_candidate')
  const w = p.status === 'medical_fit' ? ['done', 'FIT'] : p.status === 'medical_rejected' ? ['failed', 'UNFIT']
    : p.status === 'medical_applied' ? ['active', 'booked — waiting for the result'] : fromRun(runs.wafid_book)
  const wafid = step('wafid', 'Wafid', w[0], w[1], 'wafid_book')
  const lmis = step('lmis', 'LMIS contract', ...fromRun(runs.lmis_contract, 'created'), 'lmis_contract')
  const visa = /applied/i.test(p.visa_stage || '') ? ['done', p.visa_application_number ? `no. ${p.visa_application_number}` : 'applied']
    : fromRun(runs.mofa_visa)
  return {
    lmis: [cv, musaned, wafid, lmis],
    embassy: [cv, musaned, wafid,
      step('tasheer', 'Tasheer', 'soon', 'coming'),
      step('insurance', 'Insurance', ...fromRun(runs.insurance_certificate, 'certificate done'), 'insurance_certificate'),
      step('visa', 'Enjaz · Visa', visa[0], visa[1], 'mofa_visa')],
  }
}

router.get('/profiles/:profileId/journey', async (req, res) => {
  try {
    const db = req.app.locals.db
    const id = Number(req.params.profileId)
    const p = await db('profiles').where('id', id).first()
    if (!p) return res.status(404).json({ error: 'Profile not found' })
    const runs = {}
    for (const r of await db('automation_queue').where('profile_id', id).select('workflow_id', 'status').orderBy('id', 'asc')) runs[r.workflow_id] = r
    const cv = await db('generated_cvs').where('profile_id', id).first().catch(() => null)
    res.json(journeyOf(p, runs, !!cv))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/automations/stages', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profiles = await db('profiles').select('id', 'status', 'musaned_stage', 'chosen_at', 'visa_stage', 'visa_application_number')
    const rows = await db('automation_queue').select('id', 'profile_id', 'workflow_id', 'status').orderBy('id', 'asc')
    const latest = new Map()
    for (const r of rows) {
      if (!latest.has(r.profile_id)) latest.set(r.profile_id, {})
      latest.get(r.profile_id)[r.workflow_id] = r
    }
    const withCv = new Set((await db('generated_cvs').distinct('profile_id').catch(() => [])).map(r => r.profile_id))
    // Every journey step's state per profile: { cv: 'done', musaned: 'active', … }.
    const stepsOf = (p) => {
      const j = journeyOf(p, latest.get(p.id) || {}, withCv.has(p.id))
      return Object.fromEntries([...j.lmis, ...j.embassy].map(s => [s.key, s.state]))
    }
    res.json({ stages: STAGES, profiles: profiles.map(p => ({ profile_id: p.id, stage: stageOf(p, latest.get(p.id)), steps: stepsOf(p) })) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

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
    // Running the visa form again would make a second application.
    if (row.pause_reason === 'awaiting-insurance-save') {
      return res.status(409).json({ error: `Run #${runId} filled the certificate form already. Finish it in its tab, then "✔️ Insurance done" — or Cancel it to start over.` })
    }
    if (row.pause_reason === 'awaiting-visa-save') {
      return res.status(409).json({ error: `Run #${runId} filled the visa form already. Press Save in its tab, then "✔️ Visa saved" — or Cancel it to start over.` })
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

    // 3. The run lets go of its tab; the tab stays open for the person.
    const tabClosed = false
    try { forgetRunTab(runId) } catch {}

    // Runs cancelled a moment ago are still unwinding: they do not count.
    const others = queueSnapshot().running.filter(r => r.runId !== runId && !isCancelled(r.runId)).length
    const message = row.status === 'pending'
      ? `Run #${runId} cancelled — taken out of the line. ${otherRunsText(others)}`
      : `Run #${runId} cancelled${tabClosed ? ' and its tab closed' : ''}. ${otherRunsText(others)}`
    res.json({ ok: true, tabClosed, message })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Mark a paused run as fully complete (the person pressed Submit / SAVE in its
// tab): sets status=done. Its tab stays open.
router.post('/automations/:id/complete', async (req, res) => {
  try {
    const db = req.app.locals.db
    const runId = Number(req.params.id)

    const row = await db('automation_queue').where('id', runId).first()
    if (!row) return res.status(404).json({ error: 'Run not found' })
    if (row.status !== 'paused') {
      return res.status(409).json({ error: `Run #${runId} is ${row.status} — only a run waiting for you can be marked complete.` })
    }

    // The tab stays open (the person may still need it); no run uses it again.
    const tabClosed = false
    try { forgetRunTab(runId) } catch {}

    await db('automation_queue').where('id', runId).update({
      status: 'done',
      pause_reason: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // What finishing this run starts next.
    let next = ''
    try {
      if (row.workflow_id === 'wafid_book') {
        // Booked and paid on Wafid: the result checker now watches it.
        await db('profiles').where('id', row.profile_id).update({ status: 'medical_applied', updated_at: new Date().toISOString() })
        next = ' Status: Medical · Applied — Adal Keep checks the result on Wafid by itself.'
      } else if (row.workflow_id === 'mofa_visa') {
        // The person pressed Save on the visa platform.
        const { VISA_STAGES } = await import('../services/mofaVisa.js')
        await db('profiles').where('id', row.profile_id).update({ visa_stage: VISA_STAGES.applied, visa_applied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        next = ' Visa stage: Visa applied.'
      } else if (row.workflow_id === 'musaned_add_candidate') {
        // She is on Musaned now: the 4-hourly contract check watches for an employer.
        next = ' Adal Keep now checks every 4 hours whether a Saudi employer chooses her.'
      }
    } catch (e) { console.warn('[complete] next step:', e.message) }

    res.json({
      ok: true,
      tabClosed,
      message: `Run #${runId} marked complete${tabClosed ? ' — its tab was closed' : ''}.${next}`,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
