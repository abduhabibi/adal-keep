import express from 'express'
import { listWorkflows } from '../services/workflows.js'
import { dispatchRun, runStatus, queueSnapshot } from '../services/worker.js'
import { markCancelled, isCancelled } from '../services/cancellation.js'
import { forgetRunTab, findRunTab, hostOf, codeBoxUp, typeCodeInto, pressCodeButton } from '../services/tabManager.js'
import { openBrowserIfAny, openForPerson } from '../services/browser.js'
import { waiting, answerCaptcha, doneWith } from '../services/attention.js'
import { seal } from '../services/accountVault.js'
import { plainReason, problemOf, goneFromMusaned } from '../services/runOutcome.js'
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
    // She has a contract: she is chosen on Musaned and her Musaned record is
    // there — "Check if chosen" and "Add from Musaned" count as done (✓) unless
    // a run of them is working now.
    const p = await db('profiles').where('id', profileId).first('chosen_at', 'contract_number', 'musaned_stage')
    const contract = (p?.contract_number && String(p.contract_number).trim()) ||
      (p?.chosen_at && !/CANCEL|REJECT/i.test(p.musaned_stage || '')) ||
      await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
        .where('profile_fields.profile_id', profileId).where('profile_fields.name', 'like', 'Contract%').first('files.id')
    if (contract) {
      for (const id of ['musaned_check_chosen', 'musaned_cv_import']) {
        const l = latest[id]
        if (l && ['running', 'pending', 'paused', 'done'].includes(l.status)) continue
        latest[id] = { id: l?.id || null, workflow_id: id, status: 'done', finished_at: p?.chosen_at || null, from_contract: true }
      }
    }
    res.json({
      workflows: workflows.map(w => ({ ...w, latest: latest[w.id] || null })),
      queue: queueSnapshot(),
    })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// Enqueue a workflow
router.post('/profiles/:profileId/automations/:workflowId/start', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const workflowId = req.params.workflowId

    // The agency's plan (plans.js): a robot outside it does not start.
    const inPlan = featureForWorkflow(workflowId)
    if (inPlan) needFeature(inPlan.key)

    // Preflight — depends on the workflow
    // Musaned workflows need no files
    if (['musaned_check_chosen', 'musaned_cv_import', 'musaned_delete'].includes(workflowId)) {
      const prof = await db('profiles').where('id', profileId).first()
      if (!prof?.passport_number || !String(prof.passport_number).trim()) {
        return res.status(400).json({ error: 'Profile is missing the passport number', missing: ['Passport number'] })
      }
    } else if (workflowId.startsWith('musaned')) {
      // Musaned needs a personal photo, marital status, religion and a mobile number
      const prof = await db('profiles').where('id', profileId).first()
      const { musanedMissing, photoOnFile } = await import('../services/musanedPreflight.js')
      // Marital status and religion are asked in the notification during the run.
      const missing = musanedMissing(prof, await photoOnFile(db, profileId)).filter(m => !/^(marital status|religion)$/.test(m))
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
    } else if (workflowId === 'mofa_find_app') {
      const prof = await db('profiles').where('id', profileId).first()
      if (!String(prof?.passport_number || '').trim()) return res.status(400).json({ error: 'Profile is missing the passport number', missing: ['Passport number'] })
      if (!(await db('visa_accounts').first())) return res.status(400).json({ error: 'No visa platform account yet — add one under "Visa platform login account"', missing: ['Visa platform account'] })
    } else if (workflowId === 'mofa_pay') {
      const prof = await db('profiles').where('id', profileId).first()
      const missing = [!String(prof?.visa_application_number || '').trim() && 'Application number', !String(prof?.passport_number || '').trim() && 'Passport number'].filter(Boolean)
      if (missing.length) return res.status(400).json({ error: 'Profile is missing for the visa payment: ' + missing.join(', ') + (missing.includes('Application number') ? ' (the visa application gives it — "Make visa" first)' : ''), missing })
      if (!(await db('visa_accounts').first())) return res.status(400).json({ error: 'No visa platform account yet — add one under "Visa platform login account"', missing: ['Visa platform account'] })
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

    // Make insurance for several at once: ONE certificate, every one of them a
    // member (the run fills her, Add Member, the next …). The others get a run
    // that waits on this one and finishes with it.
    let group = [], skipped = []
    if (workflowId === 'insurance_certificate' && Array.isArray(req.body?.group_ids) && req.body.group_ids.length > 1) {
      const { insuranceValues, missingForInsurance } = await import('../services/insuranceCertificate.js')
      const ids = [...new Set(req.body.group_ids.map(Number).filter(n => n && n !== profileId))]
      const rows = await db('profiles').whereIn('id', ids)
      const busy = new Set((await db('automation_queue').whereIn('profile_id', ids).where('workflow_id', workflowId)
        .whereIn('status', ['running', 'paused', 'pending']).select('profile_id')).map(r => r.profile_id))
      for (const id of ids) {
        const p = rows.find(r => r.id === id)
        const missing = p ? missingForInsurance(insuranceValues(p)) : ['profile not found']
        if (busy.has(id)) skipped.push({ id, missing: ['an insurance run is already open for her'] })
        else if (missing.length) skipped.push({ id, missing })
        else group.push(id)
      }
      if (group.length) accountContext.group_ids = [profileId, ...group]
    }

    // Add from Musaned: the CV template the person chose.
    if (workflowId === 'musaned_cv_import' && req.body?.template_id) accountContext.cv_template_id = Number(req.body.template_id)

    const [runId] = await db('automation_queue').insert({
      profile_id: profileId,
      workflow_id: workflowId,
      account_id: accountId || null,
      status: 'pending',
      current_step: 0,
      context: seal(JSON.stringify(accountContext)),
      log: '[]',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // The others on the same certificate: a run each, waiting on this one.
    const mainId = Number(runId?.id ?? runId)
    for (const id of group) {
      await db('automation_queue').insert({
        profile_id: id, workflow_id: workflowId, account_id: accountId || null,
        status: 'paused', pause_reason: `with-run-${mainId}`, current_step: 0,
        context: seal(JSON.stringify({ with_run: mainId })), log: '[]',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })
    }

    // Start it now if a slot is free; otherwise it waits in line and starts by
    // itself. Either way the answer says which, before the browser does anything.
    const s = await dispatchRun(db, runId)
    res.json({ ok: true, runId, resumed: false, ...s, members: 1 + group.length, skipped, message: runMessage(runId, s, s.state === 'running' ? 'started' : 'queued') + (group.length ? ` One certificate for ${1 + group.length}.` : '') })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
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
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// Get one run with its log (and, while it waits, where it stands in line)
// Profiles with a run working now ('running') or waiting ('waiting': queued,
// or paused for a person). Used by the "Run" filter on the profile lists.
const PLAIN_WAIT = {
  'awaiting-insurance-save': 'Insurance: look it over and press Save',
  'awaiting-visa-save': 'Visa: type the captcha and press Save',
  'awaiting-visa-pay': 'Visa: pay the fees',
  'awaiting-musaned-login': 'Musaned: sign in',
  'awaiting-musaned-captcha': 'Musaned: tick the reCAPTCHA',
  'awaiting-musaned-otp': 'Musaned: type the code',
  'awaiting-human-save': 'Look it over and press Save',
  'awaiting-human-submit': 'Look it over and press Submit',
}
// The notification bar: what needs a person now.
router.get('/automations/attention', async (req, res) => {
  try {
    const db = req.app.locals.db
    const calls = waiting()
    // Paused for a person today, in plain words. Older ones and runs a restart
    // interrupted stay on their profiles: nobody is being called for them now.
    const since = new Date(Date.now() - 12 * 3600000).toISOString()
    const paused = await db('automation_queue').where('status', 'paused').where('updated_at', '>', since)
      .where('pause_reason', 'not like', 'Interrupted%').where('pause_reason', 'not like', 'with-run-%').orderBy('id', 'desc').limit(10).select('id', 'pause_reason', 'updated_at')
    for (const r of paused) if (!calls.some(c => c.run_id === r.id)) calls.push({ run_id: r.id, title: PLAIN_WAIT[r.pause_reason] || 'Waiting for you', body: '', at: new Date(r.updated_at).getTime(), image: null })
    const runs = await db('automation_queue as q').leftJoin('profiles as p', 'p.id', 'q.profile_id')
      .whereIn('q.id', calls.map(c => c.run_id)).select('q.id', 'q.profile_id', 'q.workflow_id', 'p.full_name')
    const of = new Map(runs.map(r => [r.id, r]))
    res.json(calls.filter(c => of.has(c.run_id)).map(c => ({ ...c, ...of.get(c.run_id), id: undefined })).sort((a, b) => b.at - a.at))
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})
router.post('/automations/:id/captcha', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'Type it first' })
    await answerCaptcha(req.params.id, text)
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
router.post('/automations/:id/attention/done', (req, res) => {
  doneWith(req.params.id, { force: true })
  res.json({ ok: true })
})
// Morning sign-in (services/sessionKeeper.js): each site signed in or not; a window to sign in.
router.get('/sessions', async (req, res) => {
  try { res.json(await (await import('../services/sessionKeeper.js')).sessionsNow()) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/sessions/:key/open', async (req, res) => {
  try { res.json(await (await import('../services/sessionKeeper.js')).openSite(req.params.key, req.app.locals.db)) } catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/browser/open', async (req, res) => {
  try { await openForPerson(); res.json({ ok: true }) } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

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
  ['arrived', 'Arrived KSA'],
  ['visa_issued', 'Visa issued'],
  ['embassy', 'Sent to the Saudi Embassy'],
  ['fmol_approved', 'FMOL approved'],
  ['fmol', 'Waiting for FMOL approval'],
  ['epro_approved', 'EPRO approved'],
  ['epro', 'Waiting for our (EPRO) approval'],
  ['visa_printed', 'Visa printed'],
  ['visa_paid', 'Visa fees paid'],
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

// Musaned's own contract stages, in order (its tabs).
import { MUSANED_ORDER, musanedStep } from '../services/musanedStages.js'
import { featureForWorkflow, needFeature } from '../services/plans.js'
export { MUSANED_ORDER, musanedStep }

export function stageOf(p, runs = {}) {
  const live = (r) => r && ['running', 'pending', 'paused'].includes(r.status)
  const at = musanedStep(p.musaned_stage)
  if (at >= 4) return MUSANED_ORDER[at][1]
  const visa = String(p.visa_stage || '')
  if (/printed/i.test(visa)) return 'visa_printed'
  if (/paid/i.test(visa)) return 'visa_paid'
  if (/applied/i.test(visa)) return 'visa_applied'
  if (live(runs.mofa_visa) || /waiting|filled/i.test(visa)) return 'visa'
  if (runs.lmis_contract?.status === 'done') return 'visa_ready'
  if (live(runs.lmis_contract)) return 'lmis_contract'
  if (runs.insurance_certificate?.status === 'done') return 'insured'
  if (live(runs.insurance_certificate)) return 'insurance'
  if (at >= 0) return MUSANED_ORDER[at][1]
  if (p.status === 'medical_fit') return p.chosen_at ? 'contract_ready' : 'medical_fit'
  if (p.status === 'medical_applied' || live(runs.wafid_book) || runs.wafid_book?.status === 'done') return 'wafid'
  if (p.chosen_at) return 'chosen'
  if (/another agency/i.test(p.musaned_stage || '')) return 'other_agency'
  if (!goneFromMusaned(runs) && (p.musaned_stage || runs.musaned_add_candidate?.status === 'done')) return 'musaned'
  return 'new'
}

// The documents each step needs (a field counts when it holds a file;
// "Contract" is any of the contract fields).
export const STEP_DOCS = {
  cv: ['Passport', 'Photo', 'Full Body Photo', 'CV'],
  musaned: ['Passport', 'Photo', 'CV'],
  selected: ['Contract'],
  wafid: ['Passport', 'Photo', 'Appointment Slip', 'Medical Report'],
  epro: ['Contract'],
  insurance: ['Insurance'],
  fmol: ['Contract', 'Slip', 'Medical Report', 'Labour ID'],
  embassy: ['Passport', 'Photo', 'Contract', 'Medical Report', 'Insurance'],
  visa: ['Visa'],
}
const hasDoc = (names, d) => d === 'Contract' ? [...names].some(n => /^Contract\b/i.test(n)) : names.has(d)

/** Field names that hold a file, per profile: Map(id → Set). */
export async function docsOf(db, ids) {
  const rows = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .modify(q => { if (ids) q.whereIn('profile_fields.profile_id', ids) })
    .distinct('profile_fields.profile_id', 'profile_fields.name').catch(() => [])
  const m = new Map()
  for (const r of rows) { if (!m.has(r.profile_id)) m.set(r.profile_id, new Set()); m.get(r.profile_id).add(r.name) }
  return m
}

/** WhatsApp agents her CV is out at now (or the one that chose her): Map(id → [names]). */
export async function agentsOut(db, ids) {
  const rows = await db('whatsapp_sends').join('whatsapp_agents', 'whatsapp_agents.id', 'whatsapp_sends.agent_id')
    .whereIn('whatsapp_sends.status', ['sent', 'chosen_here'])
    .modify(q => { if (ids) q.whereIn('whatsapp_sends.profile_id', ids) })
    .distinct('whatsapp_sends.profile_id', 'whatsapp_agents.name', 'whatsapp_sends.status').catch(() => [])
  const m = new Map()
  for (const r of rows) { if (!m.has(r.profile_id)) m.set(r.profile_id, []); m.get(r.profile_id).push(r.status === 'chosen_here' ? `${r.name} ✓` : r.name) }
  return m
}

/**
 * One profile's journey, two tracks from the same start:
 *   LMIS:    CV → Musaned → Wafid → LMIS contract
 *   Embassy: CV → Musaned → Wafid → Tasheer → Insurance → Enjaz · Visa
 *            (Enjaz is the visa platform: one step)
 * Each step: state 'done' | 'active' (working or waiting for a person) |
 * 'failed' | 'todo' | 'soon' (not built yet), and a short note.
 */
export function journeyOf(p, runs = {}, hasCv = false, docs = null, agents = []) {
  const live = (r) => r && ['running', 'pending', 'paused'].includes(r.status)
  const step = (key, title, state, note = '', workflow = '') => ({ key, title, state, note, workflow })
  const fromRun = (r, doneNote = '') => r?.status === 'done' ? ['done', doneNote]
    : live(r) ? ['active', r.status === 'paused' ? 'waiting for you' : r.status === 'running' ? 'working now' : /^Retry/.test(r.pause_reason || '') ? `trying again — ${plainReason(r.pause_reason)}` : 'in line']
    : r?.status === 'failed' ? ['failed', plainReason(r.pause_reason)] : ['todo', '']
  const cv = step('cv', 'CV', hasCv ? 'done' : 'todo', hasCv ? 'made' : '')
  const gone = goneFromMusaned(runs)
  const added = !gone && (runs.musaned_add_candidate?.status === 'done' || !!p.musaned_stage)
  // On Musaned and nobody chose her yet: 'waiting' (its own colour), not done.
  const m = live(runs.musaned_add_candidate) ? fromRun(runs.musaned_add_candidate)
    : /another agency/i.test(p.musaned_stage || '') ? ['failed', 'registered by another agency']
    : added ? (p.chosen_at ? ['done', `chosen ${String(p.chosen_at).slice(0, 10)}`] : ['waiting', 'not chosen yet'])
    : gone ? ['todo', 'not on Musaned']
    : runs.musaned_add_candidate?.status === 'failed' ? fromRun(runs.musaned_add_candidate) : ['todo', '']
  const musaned = step('musaned', 'Musaned', m[0], m[1], 'musaned_add_candidate')
  const w = p.status === 'medical_fit' ? ['done', 'FIT'] : p.status === 'medical_rejected' ? ['failed', 'UNFIT']
    : p.status === 'medical_applied' ? ['active', 'booked — waiting for the result'] : fromRun(runs.wafid_book)
  const wafid = step('wafid', 'Wafid', w[0], w[1], 'wafid_book')
  // Chosen by an employer on Musaned (a cancelled or rejected request is not).
  const at = musanedStep(p.musaned_stage)
  const chosen = (!!p.chosen_at || at >= 0) && !/CANCEL|REJECT/i.test(p.musaned_stage || '')
  const selected = step('selected', 'Selected', chosen ? 'done' : 'todo', chosen ? String(p.chosen_at).slice(0, 10) : '', 'musaned_check_chosen')
  // The wakala the office pays on Musaned (Employment Requests → Payment).
  const pay = String(p.musaned_payment || '').trim()
  const wakala = step('wakala', 'Paid wakala', /^paid$/i.test(pay) ? 'done' : chosen && /^unpaid$/i.test(pay) ? 'failed' : 'todo',
    /^paid$/i.test(pay) ? 'paid' : chosen && /^unpaid$/i.test(pay) ? 'unpaid' : '', 'musaned_check_chosen')
  const visa = /applied|paid|printed/i.test(p.visa_stage || '') ? ['done', `${/printed/i.test(p.visa_stage) ? 'printed' : /paid/i.test(p.visa_stage) ? 'paid' : 'applied'}${p.visa_application_number ? ` · no. ${p.visa_application_number}` : ''}`]
    : fromRun(runs.mofa_visa)
  // Musaned's tabs: EPRO approval → EPRO approved → FMOL approval → FMOL approved → Sent to the Saudi Embassy → Visa issued → Arrived KSA.
  const past = (i) => at >= i
  const epro = step('epro', 'EPRO', past(1) ? 'done' : at === 0 ? 'active' : 'todo', past(1) ? 'approved' : at === 0 ? 'waiting for our approval' : '', 'musaned_check_chosen')
  const ins = fromRun(runs.insurance_certificate, 'certificate done')
  const insurance = step('insurance', 'Insurance', ins[0] === 'todo' && past(3) ? 'done' : ins[0], ins[0] === 'todo' && past(3) ? '' : ins[1], 'insurance_certificate')
  const lmisRun = fromRun(runs.lmis_contract, 'contract done')
  const fmol = step('fmol', 'FMOL', past(3) || lmisRun[0] === 'done' ? 'done' : at === 2 ? 'active' : lmisRun[0],
    past(3) ? 'approved' : lmisRun[0] === 'done' ? lmisRun[1] : at === 2 ? 'waiting for FMOL approval' : lmisRun[1], 'lmis_contract')
  const embassy = step('embassy', 'Embassy', past(4) || visa[0] === 'done' ? 'done' : visa[0],
    past(4) ? 'sent to the Saudi Embassy' : visa[1], 'mofa_visa')
  const visaStep = step('visa', 'Visa issued', past(5) || /printed/i.test(p.visa_stage || '') ? 'done' : at === 4 ? 'active' : 'todo',
    past(5) ? (p.visa_number ? `visa ${p.visa_number}` : 'issued') : /printed/i.test(p.visa_stage || '') ? 'printed' : at === 4 ? 'at the embassy' : '')
  const arrived = step('arrived', 'Arrived KSA', past(6) ? 'done' : 'todo', past(6) ? 'arrived' : '')
  // Who each step is with, and its documents (have / missing).
  const employer = [p.employer_name, p.work_city].filter(Boolean).join(' · ')
  const who = {
    cv: agents.length ? `WhatsApp: ${agents.join(', ')}` : '',
    musaned: [p.musaned_pro && `Office: ${p.musaned_pro}`, p.employer_name && `Employer: ${p.employer_name}`].filter(Boolean).join(' · '),
    selected: [p.musaned_pro && `Office: ${p.musaned_pro}`, p.contract_number && `Contract ${p.contract_number}`].filter(Boolean).join(' · '),
    wakala: p.musaned_pro ? `Office: ${p.musaned_pro}` : '',
    wafid: p.medical_valid_until ? `Medical valid until ${String(p.medical_valid_until).slice(0, 10)}` : '',
    insurance: '',
    epro: p.musaned_pro ? `Office: ${p.musaned_pro}` : '',
    fmol: p.labor_id ? `Labour ID ${p.labor_id}` : '',
    embassy: p.visa_application_number ? `Application ${p.visa_application_number}` : '',
    visa: [p.visa_number && `Visa ${p.visa_number}`, p.visa_application_number && `Application ${p.visa_application_number}`].filter(Boolean).join(' · '),
  }
  for (const st of [cv, musaned, selected, wafid, wakala, epro, insurance, fmol, embassy, visaStep, arrived]) {
    st.who = who[st.key] || ''
    if (docs) {
      const need = STEP_DOCS[st.key] || []
      st.docs = need.map(d => ({ name: d, have: hasDoc(docs, d) }))
    }
  }
  return {
    lmis: [cv, musaned, selected, wafid],
    embassy: [cv, musaned, selected, wafid, epro, insurance, fmol, embassy, visaStep, arrived],
    // The wakala is not a step on the line: the list's Paid / Unpaid buttons.
    extra: [wakala],
  }
}

// What the phone's browser fills on each portal (services/phoneFillPlan.js).
router.get('/profiles/:profileId/fill-plan', async (req, res) => {
  try {
    const db = req.app.locals.db
    const p = await db('profiles').where('id', Number(req.params.profileId)).first()
    if (!p) return res.status(404).json({ error: 'Profile not found' })
    const { fillPlans, fillSettings } = await import('../services/phoneFillPlan.js')
    let employee = ''
    try { employee = (await (await import('../services/activeEmployee.js')).getActiveEmployee(db))?.name || '' } catch {}
    res.json({ plans: fillPlans(p, await fillSettings(db), employee) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

router.get('/profiles/:profileId/journey', async (req, res) => {
  try {
    const db = req.app.locals.db
    const id = Number(req.params.profileId)
    const p = await db('profiles').where('id', id).first()
    if (!p) return res.status(404).json({ error: 'Profile not found' })
    const runs = {}
    for (const r of await db('automation_queue').where('profile_id', id).select('workflow_id', 'status').orderBy('id', 'asc')) runs[r.workflow_id] = r
    const cv = await db('generated_cvs').where('profile_id', id).first().catch(() => null)
    const docs = (await docsOf(db, [id])).get(id) || new Set()
    res.json({ ...journeyOf(p, runs, !!cv || docs.has('CV'), docs, (await agentsOut(db, [id])).get(id) || []), cv_missing: cvMissing(p, docs, !!cv || docs.has('CV')) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

/** What her CV still lacks before it can go to agents ([] = complete): a CV made, or all a CV shows. */
export function cvMissing(p, docs = new Set(), hasCv = false) {
  if (hasCv) return []
  return [
    !String(p.full_name || '').trim() && 'name',
    !String(p.passport_number || '').trim() && 'passport number',
    !p.date_of_birth && 'date of birth',
    !docs.has('Photo') && 'photo',
    !docs.has('Passport') && 'passport scan',
  ].filter(Boolean)
}

router.get('/automations/stages', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profiles = await db('profiles').select('id', 'status', 'musaned_stage', 'chosen_at', 'visa_stage', 'visa_application_number',
      'musaned_pro', 'employer_name', 'work_city', 'contract_number', 'labor_id', 'visa_number', 'medical_valid_until', 'musaned_payment')
    const rows = await db('automation_queue').select('id', 'profile_id', 'workflow_id', 'status', 'pause_reason', 'finished_at').orderBy('id', 'asc')
    const latest = new Map()
    for (const r of rows) {
      if (!latest.has(r.profile_id)) latest.set(r.profile_id, {})
      latest.get(r.profile_id)[r.workflow_id] = r
    }
    const withCv = new Set((await db('generated_cvs').distinct('profile_id').catch(() => [])).map(r => r.profile_id))
    const docs = await docsOf(db)
    const agents = await agentsOut(db)
    // Every journey step per profile: its state { cv: 'done', … }, who it is
    // with { musaned: 'Office: …' } and its missing documents { lmis: ['Slip'] }.
    const stepsOf = (p) => {
      const d = docs.get(p.id) || new Set()
      const all = (() => { const j = journeyOf(p, latest.get(p.id) || {}, withCv.has(p.id) || d.has('CV'), d, agents.get(p.id) || []); return [...j.embassy, ...j.extra] })()
      return {
        steps: Object.fromEntries(all.map(s => [s.key, s.state])),
        notes: Object.fromEntries(all.filter(s => s.state === 'failed' && s.note).map(s => [s.key, s.note])),
        problem: problemOf(latest.get(p.id), new Set(all.filter(s => s.state === 'done').map(s => s.workflow))),
        who: Object.fromEntries(all.filter(s => s.who).map(s => [s.key, s.who])),
        missing: Object.fromEntries(all.map(s => [s.key, (s.docs || []).filter(x => !x.have).map(x => x.name)]).filter(([, m]) => m.length)),
      }
    }
    res.json({ stages: STAGES, profiles: profiles.map(p => ({ profile_id: p.id, stage: stageOf(p, latest.get(p.id)), ...stepsOf(p) })) })
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
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// The account this run signs in with — shown small by the run's buttons, so a
// person who signs in by hand has it at hand. Asked for only when shown.
router.get('/automations/:id/login', async (req, res) => {
  try {
    const row = await req.app.locals.db('automation_queue').where('id', req.params.id).first('context')
    let c = {}
    try { c = JSON.parse(row?.context || '{}') } catch {}
    const pairs = [['musaned_username', 'musaned_password', 'musaned_name'], ['insurance_username', 'insurance_password', 'insurance_name'],
      ['visa_username', 'visa_password', 'visa_name'], ['login_value', 'login_password', 'account_name']]
    const k = pairs.find(([u, pw]) => c[u] || c[pw])
    res.json(k ? { name: c[k[2]] || '', user: c[k[0]] || '', password: c[k[1]] || '' } : {})
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// Continue a paused run (after the person signed in, entered the OTP, ...)
/**
 * The run's tab, live, for a person who is not at the PC (the phone app):
 *   GET  /automations/:id/screen  a JPEG of the tab as it is now
 *   POST /automations/:id/input   {kind:'click', x, y} (0–1 of the picture) ·
 *                                 {kind:'type', text} · {kind:'key', key} ·
 *                                 {kind:'scroll', dy}
 * Clicks and keys reach the tab as a person's own (the run never presses
 * Submit / Save itself; a person can, from here).
 */
export async function runTab(db, runId) {
  const run = await db('automation_queue').where('id', runId).first('id', 'workflow_id').catch(() => null)
  if (!run) return null
  return findRunTab(await openBrowserIfAny(), run.id, run.workflow_id)
}
const liveTab = (req) => runTab(req.app.locals.db, req.params.id)

router.get('/automations/:id/screen', async (req, res) => {
  const page = await liveTab(req)
  if (!page) return res.status(404).json({ error: 'This run has no open tab.' })
  try {
    const shot = await Promise.race([
      page.screenshot({ type: 'jpeg', quality: 60, captureBeyondViewport: false }),
      new Promise((_, no) => setTimeout(() => no(new Error('The tab did not answer.')), 8000)),
    ])
    const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]).catch(() => [0, 0])
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Tab-Size': size.join('x'), 'X-Tab-Url': encodeURI(page.url()).slice(0, 300), 'Access-Control-Expose-Headers': 'X-Tab-Size, X-Tab-Url' })
    res.end(shot)
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// The tab as it changes, for an <img>: the newest picture only, so a slow connection
// skips frames instead of falling behind.
router.get('/automations/:id/stream', async (req, res) => {
  const page = await liveTab(req)
  if (!page) return res.status(404).json({ error: 'This run has no open tab.' })
  const { watchFrames } = await import('../services/liveFrames.js')
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=adalframe', 'Cache-Control': 'no-store', Connection: 'close' })
  const stop = await watchFrames(page, (img) => {
    if (res.writableNeedDrain) return
    res.write(`--adalframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${img.length}\r\n\r\n`)
    res.write(img)
    res.write('\r\n')
  })
  req.on('close', stop)
})

// What goes with the pictures: the address, and whether the page asks for a code.
router.get('/automations/:id/tab', async (req, res) => {
  const page = await liveTab(req)
  if (!page) return res.status(404).json({ error: 'This run has no open tab.' })
  res.set('Cache-Control', 'no-store').json({ url: page.url(), title: await page.title().catch(() => ''), codeBox: await codeBoxUp(page) })
})

export const LIVE_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Delete', 'PageDown', 'PageUp', 'Home', 'End', 'Space']
/** Scrolls the page, or the box inside it that scrolls (a long form often sits in one). */
function scrollPage(dx, dy) {
  const can = (e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)
  const boxes = [...document.querySelectorAll('*')].filter(can).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)
  const page = document.scrollingElement || document.documentElement
  const before = page.scrollTop
  page.scrollBy({ left: dx, top: dy, behavior: 'instant' })
  if (page.scrollTop === before && boxes[0]) boxes[0].scrollBy({ left: dx, top: dy, behavior: 'instant' })
}

/** One tap, key, scroll or move in a run's tab (the phone's / Admin's live view). */
export async function liveInput(page, b = {}) {
  if (b.kind === 'click') {
    const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight])
    const x = Math.max(0, Math.min(1, Number(b.x))) * w, y = Math.max(0, Math.min(1, Number(b.y))) * h
    await page.mouse.click(x, y)
  } else if (b.kind === 'type') {
    await page.keyboard.type(String(b.text || '').slice(0, 500), { delay: 20 })
  } else if (b.kind === 'key') {
    const key = String(b.key || '')
    if (!LIVE_KEYS.includes(key)) throw Object.assign(new Error('Unknown key'), { status: 400 })
    await page.keyboard.press(key === 'Space' ? ' ' : key)
  } else if (b.kind === 'code') {
    const code = String(b.code || '').replace(/\D/g, '')
    if (code.length < 4 || code.length > 8) throw Object.assign(new Error('That is not a code: copy it from the authenticator first.'), { status: 400 })
    if (!(await typeCodeInto(page, code))) throw Object.assign(new Error('The code box is not on the page.'), { status: 409 })
    await new Promise(r => setTimeout(r, 300))
    await pressCodeButton(page)
  } else if (b.kind === 'scroll') {
    await page.evaluate(scrollPage, Math.max(-2000, Math.min(2000, Number(b.dx) || 0)), Math.max(-3000, Math.min(3000, Number(b.dy) || 0)))
  } else if (b.kind === 'bottom') {
    await page.evaluate(scrollPage, 0, 1e7)
  } else if (b.kind === 'nav') {
    let u = String(b.url || '').trim()
    if (!/^https?:\/\//i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? `https://www.google.com/search?q=${encodeURIComponent(u)}` : `https://${u}`
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 })
  } else if (b.kind === 'back') await page.goBack({ timeout: 20000 }).catch(() => {})
  else if (b.kind === 'forward') await page.goForward({ timeout: 20000 }).catch(() => {})
  else if (b.kind === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  else if (['tap', 'tapAt', 'reveal', 'set', 'pick'].includes(b.kind)) await (await import('../services/pageMirror.js')).mirrorInput(page, b)
  else throw Object.assign(new Error('Unknown input'), { status: 400 })
}

// Runs in the page: is this the button that signs in?
function isSignIn(el) {
  const b = el?.closest?.('button, [role="button"], input[type="submit"], a')
  return /^\s*(sign\s*in|log\s*in|login|تسجيل الدخول|دخول)\s*$/i.test(b?.innerText || b?.value || '')
}

/** A person's tap or Enter that signs in to Musaned, seen before it happens (the page goes after). */
export async function pressesSignIn(page, b = {}) {
  if (!/(^|\.)(wahid\.sa|musaned\.com\.sa)$/.test(hostOf(page.url()))) return false
  if (b.kind === 'click') return page.evaluate(`(${isSignIn})(document.elementFromPoint(${Number(b.x)} * innerWidth, ${Number(b.y)} * innerHeight))`)
  if (b.kind === 'key' && b.key === 'Enter') return page.evaluate(() => document.activeElement?.type === 'password')
  if (b.kind === 'tap' || b.kind === 'tapAt') {
    const el = await (await import('../services/pageMirror.js')).handleOf(page, b.id)
    return el.evaluate(isSignIn)
  }
  return false
}

/** The code of the run's own Musaned account now: another account's would not sign it in. */
async function codeOfRun(db, runId) {
  const run = await db('automation_queue').where('id', runId).first('account_id', 'context', 'workflow_id')
  if (!run?.workflow_id?.startsWith('musaned')) return null
  let saved = {}
  try { saved = JSON.parse(run.context || '{}') } catch {}
  return (await import('../services/musanedTotp.js')).authenticatorInfo(saved.account_id || run.account_id)?.code || null
}

/** liveInput for a person: answers with the Musaned code when the tap was Sign in. */
export async function personInput(db, runId, page, b) {
  const signIn = await pressesSignIn(page, b).catch(() => false)
  await liveInput(page, b)
  return signIn ? codeOfRun(db, runId).catch(() => null) : null
}

// The tab as a light page for the phone (services/pageMirror.js).
const mirrorShots = new Map()
router.get('/automations/:id/mirror', async (req, res) => {
  const page = await liveTab(req)
  if (!page) return res.status(404).json({ error: 'This run has no open tab.' })
  try {
    const { mirrorOf } = await import('../services/pageMirror.js')
    if (!mirrorShots.has(req.params.id)) mirrorShots.set(req.params.id, new Map())
    if (mirrorShots.size > 20) mirrorShots.delete(mirrorShots.keys().next().value)
    res.set('Cache-Control', 'no-store').json(await mirrorOf(page, mirrorShots.get(req.params.id)))
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

router.post('/automations/:id/input', async (req, res) => {
  const page = await liveTab(req)
  if (!page) return res.status(404).json({ error: 'This run has no open tab.' })
  try { res.json({ ok: true, code: await personInput(req.app.locals.db, req.params.id, page, req.body || {}) }) }
  catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})


/**
 * A person's button on a run (Cancel, a "done" button, Continue) goes into her
 * notes too, under the run's portal — so the notes never still say "waiting
 * for a person" after the person answered.
 */
const PORTAL_OF = [[/^musaned/, 'Musaned'], [/^wafid/, 'Wafid medical'], [/^insurance/, 'Insurance'], [/^mofa/, 'Visa'], [/^police/, 'Police'], [/^(lmis|contract|delete)/, 'LMIS']]
async function noteRun(db, row, what) {
  try {
    if (!row?.profile_id) return
    const portal = (PORTAL_OF.find(([re]) => re.test(row.workflow_id)) || [null, 'Run'])[1]
    const name = listWorkflows().find(w => w.id === row.workflow_id)?.name || row.workflow_id
    const p = await db('profiles').where('id', row.profile_id).first('notes')
    const line = `[${new Date().toISOString().slice(0, 10)}] ${portal}: ${name} (run #${row.id}) ${what}`
    await db('profiles').where('id', row.profile_id).update({ notes: p?.notes ? `${p.notes}\n${line}` : line, updated_at: new Date().toISOString() })
  } catch (e) { console.warn('[notes]', e.message) }
}

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
    if (/^with-run-/.test(row.pause_reason || '')) {
      return res.status(409).json({ error: `She is on the certificate of run #${row.pause_reason.slice(9)} — it finishes with that run.` })
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
    if (row.status === 'paused') await noteRun(db, row, 'continued by a person')
    const s = await dispatchRun(db, runId)
    res.json({ ok: true, ...s, message: runMessage(runId, s, row.status === 'paused' ? 'continued' : 'was already queued') })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
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
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
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

    await noteRun(db, row, 'cancelled by a person')
    if (row.workflow_id === 'insurance_certificate') await (await import('../services/insuranceCertificate.js')).settleMembers(db, runId, 'cancelled', `cancelled with run #${runId}`)

    // 3. The run lets go of its tab; the tab stays open for the person.
    const tabClosed = false
    try { forgetRunTab(runId) } catch {}

    // Runs cancelled a moment ago are still unwinding: they do not count.
    const others = queueSnapshot().running.filter(r => r.runId !== runId && !isCancelled(r.runId)).length
    const message = row.status === 'pending'
      ? `Run #${runId} cancelled — taken out of the line. ${otherRunsText(others)}`
      : `Run #${runId} cancelled${tabClosed ? ' and its tab closed' : ''}. ${otherRunsText(others)}`
    res.json({ ok: true, tabClosed, message })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
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

    await noteRun(db, row, 'done — marked by a person')
    if (row.workflow_id === 'insurance_certificate') await (await import('../services/insuranceCertificate.js')).settleMembers(db, runId, 'done')

    // What finishing this run starts next.
    let next = ''
    try {
      if (row.workflow_id === 'wafid_book') {
        // Booked and paid on Wafid: the result checker now watches it.
        await db('profiles').where('id', row.profile_id).update({ status: 'medical_applied', updated_at: new Date().toISOString() })
        next = ' Status: Medical · Applied — Adal Keep checks the result on Wafid by itself.'
        // The appointment slip comes into her profile by itself (to print).
        try { const { queueWafidSlip } = await import('../services/wafidStatus.js'); await queueWafidSlip(db, row.profile_id, 'booked') } catch {}
      } else if (row.workflow_id === 'mofa_visa') {
        // The person pressed Save on the visa platform.
        const { VISA_STAGES } = await import('../services/mofaVisa.js')
        await db('profiles').where('id', row.profile_id).update({ visa_stage: VISA_STAGES.applied, visa_applied_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        next = ' Visa stage: Visa applied.'
      } else if (row.workflow_id === 'mofa_pay') {
        // The person paid the visa fees on the visa platform.
        await db('profiles').where('id', row.profile_id).update({ visa_stage: 'Visa paid', updated_at: new Date().toISOString() })
        next = ' Visa stage: Visa paid.'
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
