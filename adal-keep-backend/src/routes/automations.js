import express from 'express'
import { listWorkflows } from '../services/workflows.js'
import { dispatchRun, runStatus, queueSnapshot } from '../services/worker.js'
import { markCancelled, isCancelled } from '../services/cancellation.js'
import { forgetRunTab, dropTab, tabOfRun, tabAnswers, findRunTab, hostOf, codeBoxUp, activeRunIds, typeCodeInto, pressCodeButton } from '../services/tabManager.js'
import { openBrowserIfAny, openForPerson } from '../services/browser.js'
import { waiting, answerCaptcha, doneWith, TASK_MS } from '../services/attention.js'
import { seal } from '../services/accountVault.js'
import { plainReason, problemOf, goneFromMusaned } from '../services/runOutcome.js'
import { hands, handsOn } from '../services/liveHands.js'
import { personAsked } from '../services/personPress.js'
import { CV_COLUMNS, completeIds, isComplete, lacksOf } from '../services/cvComplete.js'
import { assertPoliceReady, getProfileVerification, runPassportVerification } from '../services/verification.js'

const router = express.Router()

/** Why a new insurance for her would be a second one, or null (her certificate on file, or already requested). */
export async function insuranceAlreadyDone(db, profileId) {
  const cert = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .where({ 'profile_fields.profile_id': profileId, 'profile_fields.name': 'Insurance' }).first('files.id').catch(() => null)
  if (cert) return 'Her insurance is already done: the certificate is on her profile (Documents → Insurance).'
  const { insuranceHistory, dayOf } = await import('../services/insuranceFetch.js')
  const h = await insuranceHistory(db, profileId)
  if (!h.count) return null
  return `Her insurance was already requested on ${dayOf(h.last)} (${h.count} time${h.count === 1 ? '' : 's'}). FetaP issues it about a day later: use "Get insurance certificate" instead.`
}

const runCols = new WeakMap()   // per database
async function runColumns(db) {
  if (!runCols.has(db)) runCols.set(db, Object.keys(await db('automation_queue').columnInfo()))
  return runCols.get(db)
}

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
    // The newest run of each robot only, without its log (up to 100 KB; /automations/:id gives it).
    const newest = await db('automation_queue').where('profile_id', profileId).groupBy('workflow_id').max('id as id')
    const cols = (await runColumns(db)).filter(c => c !== 'log')
    const runs = await db('automation_queue').whereIn('id', newest.map(r => r.id)).select(cols)
    const latest = {}
    for (const r of runs) latest[r.workflow_id] = publicRun(r)
    // She has a contract: she is chosen on Musaned and her Musaned record is
    // there — "Check if chosen" and "Add from Musaned" count as done (✓) unless
    // a run of them is working now.
    const p = await db('profiles').where('id', profileId).first('chosen_at', 'contract_number', 'musaned_stage', 'status', 'visa_application_number')
    // Her application number is there (found or typed by hand): "Find
    // application number" counts as done (✓) unless a run of it is working now.
    if (p?.visa_application_number && String(p.visa_application_number).trim()) {
      const l = latest.mofa_find_app
      if (!l || !['running', 'pending', 'paused', 'done'].includes(l.status)) {
        latest.mofa_find_app = { id: l?.id || null, workflow_id: 'mofa_find_app', status: 'done', finished_at: l?.finished_at || null, from_number: true }
      }
    }
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
    // The one step she is at (the page shows only its robot until EPRO is approved).
    let step = null
    try { const full = await db('profiles').where('id', profileId).first(); if (full) step = stepNow(full, await journeyFor(db, profileId, full)) } catch {}
    // A finished "Check if chosen" is not a ✓ unless she really is chosen.
    if (latest.musaned_check_chosen) latest.musaned_check_chosen = { ...latest.musaned_check_chosen, chosen: !!contract }
    res.json({
      step,
      // EPRO approve: only once her Wafid medical is FIT.
      workflows: workflows.filter(w => w.id !== 'musaned_epro_approve' || p?.status === 'medical_fit' || latest[w.id]).map(w => ({ ...w, latest: latest[w.id] || null })),
      queue: queueSnapshot(),
    })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// Enqueue a workflow
// An Adal Companion's robot browser (services/remoteBrowsers.js): it says every minute where it is.
router.post('/companion/robot-browser', async (req, res) => {
  if (!req.pcAccess) return res.status(403).json({ error: 'Only an approved Adal Companion' })
  const { registerDevice } = await import('../services/remoteBrowsers.js')
  const { ipOf } = await import('../services/networkGate.js')
  const r = registerDevice(req.pcAccess, ipOf(req), req.body || {})
  // The other Companions it should reach over the office network (it says how many it did).
  const { liveDevices } = await import('../services/remoteBrowsers.js')
  // The signed release this PC runs (a Companion takes it from here, lanUpdate.js), and whether a run works now.
  const lan = await import('../services/lanServe.js').then(l => ({ release: l.releaseHere()?.manifest?.sha || '' })).catch(() => ({}))
  const { runsWorking } = await import('../services/busy.js')
  res.json({ ...r, ...lan, runs: runsWorking(), peers: liveDevices().filter(d => d.id !== req.pcAccess.id).map(d => ({ name: d.name, ip: d.ip, port: d.port })) })
})
// The sidebar's Browsers: every robot browser working now, on any PC (services/robotBrowsers.js).
router.get('/browsers', async (req, res) => {
  try {
    const list = await (await import('../services/robotBrowsers.js')).listBrowsers(req.app.locals.db)
    // The live view's tab strip: the sites' own open tabs too (services/openTabs.js).
    if (req.query.tabs) list.push(...await (await import('../services/openTabs.js')).openTabs(null, list.map(x => Number(x.run_id)).filter(Boolean)).catch(() => []))
    res.set('Cache-Control', 'no-store').json(list)
  }
  catch (e) { res.status(500).json({ error: e.message }) }
})
// "Watch robots" (services/watchRobots.js): the robots' window on screen / back out of sight, on a person's click only.
// The five standing site tabs (siteTabs.js), for the Robots page: signed in and standing by, working, or sign in needed.
router.get('/automations/site-tabs', async (req, res) => {
  const T = await import('../services/siteTabs.js')
  if (!T.siteTabsOn()) return res.json({ off: true, sites: [] })
  const running = new Set((await req.app.locals.db('automation_queue').where('status', 'running').pluck('id').catch(() => [])).map(Number))
  res.json({ sites: await T.siteTabsNow({ running }) })
})

// The Robots page by site (bySite.js): each site's tasks waiting and working, and its last results.
router.get('/automations/by-site', async (req, res) => {
  try {
    const B = await import('../services/bySite.js')
    if (!B.bySiteOn()) return res.json({ off: true, sites: [] })
    let skipped = []
    try { skipped = (await import('../services/taskGate.js')).lastSkipped() } catch {}
    res.set('Cache-Control', 'no-store').json(await B.bySite(req.app.locals.db, { skipped }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/automations/watch-robots', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await (await import('../services/watchRobots.js')).watchState()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/automations/watch-robots', async (req, res) => {
  try { res.json(await (await import('../services/watchRobots.js')).setWatch(!!req.body?.watch)) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/companion/robot-browsers', async (req, res) => {
  const { liveDevices } = await import('../services/remoteBrowsers.js')
  res.json(liveDevices())
})

// What a robot still needs, nothing started (the profile page's pop-up): the start's own checks, with { check: true }.
router.get('/profiles/:profileId/automations/:workflowId/needs', (req, res, next) => {
  req.body = { ...(req.body || {}), check: true }
  req.method = 'POST'
  req.url = req.url.replace(/\/needs(\?.*)?$/, '/start')
  next()
})
router.post('/profiles/:profileId/automations/:workflowId/start', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const workflowId = req.params.workflowId

    // The agency's plan (plans.js): a robot outside it does not start.
    const inPlan = featureForWorkflow(workflowId)
    if (inPlan) needFeature(inPlan.key)

    // Step by step until the EPRO is approved: only the robots of the step she is at.
    if (!req.body?.anyStep) {
      const full = await db('profiles').where('id', profileId).first()
      if (full) {
        const step = stepNow(full, await journeyFor(db, profileId, full))
        const allowed = STEP_ROBOTS[step.key]
        if (allowed && !allowed.includes(workflowId)) {
          return res.status(409).json({ error: `Step ${step.n} of ${step.of} first: ${step.title}.`, step })
        }
      }
    }

    // Preflight — depends on the workflow
    // Musaned workflows need no files
    if (workflowId === 'musaned_epro_approve') {
      const prof = await db('profiles').where('id', profileId).first()
      if (prof?.status !== 'medical_fit') return res.status(400).json({ error: 'EPRO approve comes after the Wafid medical is FIT.' })
      const { eproSignature } = await import('../services/eproSignature.js')
      if (!eproSignature()) return res.status(400).json({ error: 'Upload the signed contract once in Settings → Integrations → EPRO signature first.' })
    }
    if (['musaned_check_chosen', 'musaned_cv_import', 'musaned_delete', 'musaned_epro_approve'].includes(workflowId)) {
      const prof = await db('profiles').where('id', profileId).first()
      if (!prof?.passport_number || !String(prof.passport_number).trim()) {
        return res.status(400).json({ error: 'Profile is missing the passport number', missing: ['Passport number'] })
      }
    } else if (workflowId.startsWith('musaned')) {
      // Musaned needs a personal photo, marital status, religion and a mobile number
      const prof = await db('profiles').where('id', profileId).first()
      const { musanedMissing, photoOnFile } = await import('../services/musanedPreflight.js')
      // Marital status and religion are asked in the notification during the run.
      // Her CV is complete: Musaned needs nothing more, so nothing is checked or asked again.
      const missing = await isComplete(db, profileId, prof) ? [] : musanedMissing(prof, await photoOnFile(db, profileId)).filter(m => req.body?.check || !/^(marital status|religion)$/.test(m))
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
    } else if (workflowId === 'tasheer_schedule') {
      const prof = await db('profiles').where('id', profileId).first()
      const T = await import('../services/tasheer.js')
      const missing = T.missingForTasheer(prof || {}, await T.tasheerSettings(db))
      if (missing.length) return res.status(400).json({ error: 'Profile is missing for Tasheer: ' + missing.join(', '), missing })
      if (!(await db('tasheer_accounts').first())) return res.status(400).json({ error: 'No Tasheer account yet — add one under AI Actions → Tasheer → Login', missing: ['Tasheer account'] })
    } else if (workflowId === 'insurance_certificate') {
      const prof = await db('profiles').where('id', profileId).first()
      const { insuranceValues, missingForInsurance } = await import('../services/insuranceCertificate.js')
      const missing = missingForInsurance(insuranceValues(prof || {}))
      if (missing.length) return res.status(400).json({ error: 'Profile is missing for the insurance: ' + missing.join(', '), missing })
      if (!(await db('insurance_accounts').first())) return res.status(400).json({ error: 'No insurance account yet — add one under "Insurance login account"', missing: ['Insurance account'] })
      // Her insurance already done (asked on 2026-11-19): the agency is told; force only on purpose.
      if (!req.body?.force) {
        const done = await insuranceAlreadyDone(db, profileId)
        if (done) return res.status(409).json({ error: done, alreadyDone: true })
      }
    } else if (workflowId === 'insurance_fetch') {
      const prof = await db('profiles').where('id', profileId).first()
      if (!String(prof?.passport_number || '').trim()) return res.status(400).json({ error: 'Profile is missing the passport number', missing: ['Passport number'] })
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
      const { missingForLmisContract } = await import('../services/lmisContract.js')
      const missing = missingForLmisContract(prof || {})
      if (missing.length) return res.status(400).json({ error: 'Profile is missing for the LMIS contract: ' + missing.join(', '), missing })
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

    // Only a check (the profile page's next-step pop-up, asked on 2026-11-20): nothing is missing; nothing is started.
    if (req.body?.check) return res.json({ ok: true, missing: [] })

    // One run per profile + workflow at a time. A second click never starts a
    // second copy (that is what put two runs in one tab): it reports on the
    // run that already exists, and resumes it if it was paused.
    let active = await db('automation_queue')
      .where({ profile_id: profileId, workflow_id: workflowId })
      .whereIn('status', ['running', 'paused', 'pending'])
      .orderBy('id', 'desc').first()
    // Robots on every PC: "running" in this copy, but no PC holds her and that site (runClaims) and the row has not
    // moved for 90 s — its PC went away (its own copy may say so already; this one has not heard yet). It ends here
    // ("stopped — PC went away") and the person's Start runs her fresh (brain scenario 4).
    if (active?.status === 'running') {
      try {
        const C = await import('../services/runClaims.js')
        const quiet = Date.now() - new Date(active.updated_at || 0).getTime() > 90e3
        if (C.claimsOn() && quiet && !C.runClaimsNow().some(l => l.key === C.keyOf(active))) {
          const { GONE_NOTE } = await import('../services/worker.js')
          let log = []; try { log = JSON.parse(active.log || '[]') } catch {}
          log.push({ ts: new Date().toISOString(), level: 'error', msg: `${GONE_NOTE} (no PC holds this run; a person started her again)` })
          await db('automation_queue').where({ id: active.id, status: 'running' }).update({ status: 'failed', pause_reason: GONE_NOTE, log: JSON.stringify(log), updated_at: new Date().toISOString() })
          active = null
        }
      } catch {}
    }
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
      if (active.status === 'paused') {
        await db('automation_queue').where('id', runId).andWhere('status', 'paused')
          .update({ status: 'pending', updated_at: new Date().toISOString() })
      }
      await personAsked(db, active)
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
    } else if (workflowId.startsWith('tasheer')) {
      let acct = accountId ? await db('tasheer_accounts').where('id', accountId).first() : null
      if (!acct) acct = await db('tasheer_accounts').orderBy('is_default', 'desc').first()
      if (acct) {
        accountContext.tasheer_username = acct.username
        accountContext.tasheer_password = acct.password
        accountContext.tasheer_name = acct.name
        accountContext.account_id = acct.id
        await db('tasheer_accounts').where('id', acct.id).update({ last_used_at: new Date().toISOString() }).catch(() => {})
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
    if (['insurance_certificate', 'tasheer_schedule'].includes(workflowId) && Array.isArray(req.body?.group_ids) && req.body.group_ids.length > 1) {
      const { insuranceValues, missingForInsurance: forInsurance } = await import('../services/insuranceCertificate.js')
      const T = workflowId === 'tasheer_schedule' ? await import('../services/tasheer.js') : null
      const ts = T ? await T.tasheerSettings(db) : null
      const missingForInsurance = T ? (p) => T.missingForTasheer(p, ts) : (v) => forInsurance(v)
      const ids = [...new Set(req.body.group_ids.map(Number).filter(n => n && n !== profileId))]
      const rows = await db('profiles').whereIn('id', ids)
      const busy = new Set((await db('automation_queue').whereIn('profile_id', ids).where('workflow_id', workflowId)
        .whereIn('status', ['running', 'paused', 'pending']).select('profile_id')).map(r => r.profile_id))
      for (const id of ids) {
        const p = rows.find(r => r.id === id)
        const missing = p ? missingForInsurance(T ? p : insuranceValues(p)) : ['profile not found']
        if (busy.has(id)) skipped.push({ id, missing: [`a${T ? ' Tasheer' : 'n insurance'} run is already open for her`] })
        else if (missing.length) skipped.push({ id, missing })
        else group.push(id)
      }
      if (group.length) accountContext.group_ids = [profileId, ...group]
    }

    // Add from Musaned: the CV template the person chose.
    if (workflowId === 'musaned_cv_import' && req.body?.template_id) accountContext.cv_template_id = Number(req.body.template_id)

    // Started on an Adal Companion whose robot browser is on the office network:
    // the robot works there, on that PC's screen (services/remoteBrowsers.js).
    if (req.pcAccess && !req.body?.on_main) {
      const { deviceForRequest } = await import('../services/remoteBrowsers.js')
      const { ipOf } = await import('../services/networkGate.js')
      const dev = deviceForRequest(req.pcAccess, ipOf(req))
      if (dev) accountContext.on_device = dev
    }

    // "Run it on this PC" (pinned: true): no other PC is chosen for it (selfAssign) — the PC whose window started it.
    if (req.body?.pinned === true) { accountContext.placed = 1; if (!accountContext.on_device) accountContext.on_main = true }

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
    res.json({ ok: true, runId, resumed: false, ...s, members: 1 + group.length, skipped, message: runMessage(runId, s, s.state === 'running' ? 'started' : 'queued') + (group.length ? (workflowId === 'tasheer_schedule' ? ` One Tasheer group appointment for ${1 + group.length}.` : ` One certificate for ${1 + group.length}.`) : '') + (accountContext.on_device ? ' It works in Adal Browser on this PC.' : ''), on_device: !!accountContext.on_device })
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
  'awaiting-tasheer-save': 'Tasheer: look it over and press Save',
  'awaiting-visa-save': 'Visa: type the captcha and press Save',
  'awaiting-visa-pay': 'Visa: pay the fees',
  'awaiting-musaned-login': 'Musaned: sign in',
  'awaiting-musaned-captcha': 'Musaned: tick the reCAPTCHA',
  'awaiting-musaned-otp': 'Musaned: type the code',
  'awaiting-musaned-agency-picker': 'Musaned: choose the agency (the run goes on by itself)',
  'awaiting-musaned-precheck': 'Musaned: put her passport in the pre-check and press Continue',
  'awaiting-human-save': 'Look it over and press Save',
  'awaiting-human-submit': 'Look it over and press Submit',
  'awaiting-tasheer-code': 'Tasheer: nobody typed the code in 10 minutes — press Continue',
}
// The notification bar: what needs a person now.
router.get('/automations/attention', async (req, res) => {
  try {
    const db = req.app.locals.db
    const calls = waiting()
    // Paused for a person today, in plain words. Older ones and runs a restart
    // interrupted stay on their profiles: nobody is being called for them now.
    // A task lasts 10 minutes (attention.js TASK_MS); a run paused for no answer is not called again.
    const since = new Date(Date.now() - TASK_MS).toISOString()
    const paused = await db('automation_queue').where('status', 'paused').where('updated_at', '>', since)
      .where('pause_reason', 'not like', 'No answer for %')
      .where('pause_reason', 'not like', 'Interrupted%').where('pause_reason', 'not like', 'with-run-%').orderBy('id', 'desc').limit(10).select('id', 'pause_reason', 'updated_at')
    for (const r of paused) if (!calls.some(c => c.run_id === r.id)) calls.push({ run_id: r.id, title: PLAIN_WAIT[r.pause_reason] || 'Waiting for you', body: '', at: new Date(r.updated_at).getTime(), expires_in_ms: Math.max(0, new Date(r.updated_at).getTime() + TASK_MS - Date.now()), task_id: `${r.id}:p`, step: 1, kind: 'look', image: null, reason: r.pause_reason })
    const runs = await db('automation_queue as q').leftJoin('profiles as p', 'p.id', 'q.profile_id')
      .whereIn('q.id', calls.map(c => c.run_id)).select('q.id', 'q.profile_id', 'q.workflow_id', 'p.full_name', 'q.status as run_status', 'q.pause_reason as reason')
    const of = new Map(runs.map(r => [r.id, r]))
    // The PC's own dangers (disk almost full, database damaged) — services/pcHealth.js.
    let pc = []
    try { pc = (await import('../services/pcHealth.js')).pcCalls() } catch {}
    // The agency's Tasheer sign-in (no run): its code call (services/tasheerSession.js SIGNIN_CALL).
    const site = { [-1]: { full_name: 'Tasheer sign-in', workflow_id: 'tasheer_signin', profile_id: null } }
    // The end-of-day summary, for the hour after its phone push (services/officeHealth.js).
    try { const d = (await import('../services/officeHealth.js')).dayCall(); if (d) pc.push(d) } catch {}
    res.json([...pc, ...calls.filter(c => of.has(c.run_id) || site[c.run_id]).map(c => ({ ...c, ...(of.get(c.run_id) || site[c.run_id]), id: undefined }))].sort((a, b) => b.at - a.at))
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
  try {
    // Tasheer: one sign-in for the agency — "Sign in here" takes it over for this person.
    const accountId = Number(req.body?.account_id) || null   // the account chosen (Morning sign-in asks when there are several)
    if (req.params.key === 'tasheer') return res.json(await (await import('../services/tasheerSession.js')).takeOver(req.app.locals.db, { ...whoAndPc(req), accountId }))
    res.json(await (await import('../services/sessionKeeper.js')).openSite(req.params.key, req.app.locals.db, { accountId }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// Her status, day by day (services/profileDays.js), and FMOL from Musaned's stage.
router.get('/profiles/:profileId/days', async (req, res) => {
  try {
    const db = req.app.locals.db
    const id = Number(req.params.profileId)
    const d = await import('../services/profileDays.js')
    if (!(await db('profile_days').where({ profile_id: id, day: new Date().toLocaleDateString('en-CA') }).first('id').catch(() => null))) await d.snapshotDays(db).catch(() => {})
    const p = await db('profiles').where('id', id).first('musaned_stage', 'contract_checked_at')
    res.json({ fmol: d.fmolOf(p?.musaned_stage), musaned_stage: p?.musaned_stage || '', checked_at: p?.contract_checked_at || null, days: await d.daysOf(db, id) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.get('/tasheer/session', async (req, res) => {
  try { res.json(await (await import('../services/tasheerSession.js')).tasheerNow(req.app.locals.db)) } catch (e) { res.status(500).json({ error: e.message }) }
})
/** The person (the employee chosen on that PC) and the PC a request comes from. */
function whoAndPc(req) {
  let by = ''
  try { by = decodeURIComponent(req.get('x-adal-who') || '') } catch {}
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  const local = ['127.0.0.1', '::1'].includes(ip)
  return { by, pc: local ? 'the main PC' : (req.pcAccess?.name || req.pcAccess?.label || ip) }
}

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
import { chosenNote, isChosen } from '../services/chosen.js'
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
  if (p.status === 'medical_fit') return isChosen(p) ? 'contract_ready' : 'medical_fit'
  if (p.status === 'medical_applied' || live(runs.wafid_book) || runs.wafid_book?.status === 'done') return 'wafid'
  if (isChosen(p)) return 'chosen'
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
  const cv = step('cv', 'CV', hasCv ? 'done' : 'todo', hasCv === 'ready' ? 'all there' : hasCv ? 'made' : '')
  const gone = goneFromMusaned(runs)
  const added = !gone && (runs.musaned_add_candidate?.status === 'done' || !!p.musaned_stage)
  // On Musaned and nobody chose her yet: 'waiting' (its own colour), not done.
  const m = live(runs.musaned_add_candidate) ? fromRun(runs.musaned_add_candidate)
    : /another agency/i.test(p.musaned_stage || '') ? ['failed', 'registered by another agency']
    : added ? (isChosen(p) ? ['done', `chosen ${chosenNote(p)}`] : ['waiting', 'not chosen yet'])
    : gone ? ['todo', 'not on Musaned']
    : runs.musaned_add_candidate?.status === 'failed' ? fromRun(runs.musaned_add_candidate) : ['todo', '']
  const musaned = step('musaned', 'Musaned', m[0], m[1], 'musaned_add_candidate')
  const w = p.status === 'medical_fit' ? ['done', 'FIT'] : p.status === 'medical_rejected' ? ['failed', 'UNFIT']
    : p.status === 'medical_applied' ? ['active', 'booked — waiting for the result'] : fromRun(runs.wafid_book)
  const wafid = step('wafid', 'Wafid', w[0], w[1], 'wafid_book')
  // Chosen by an employer on Musaned (a cancelled or rejected request is not).
  const at = musanedStep(p.musaned_stage)
  // Her employer's contract on her profile counts too (services/chosen.js).
  const chosen = isChosen(p, at)
  const selected = step('selected', 'Selected', chosen ? 'done' : 'todo', chosen ? chosenNote(p) : '', 'musaned_check_chosen')
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
  // Tasheer is behind her when its robot made the appointment, when she has a
  // Tasheer appointment (slip read, or typed), or when Musaned has her at the
  // Saudi Embassy or later — not only after a robot run (every girl past the
  // EPRO stayed on the Tasheer tab, even those already in Saudi Arabia).
  const tasheerState = () => {
    const r = fromRun(runs.tasheer_schedule, 'scheduled')
    if (r[0] === 'done' || r[0] === 'active') return r
    if (String(p.tasheer_ref || '').trim() || String(p.tasheer_date || '').trim()) return ['done', 'appointment made']
    if (past(4)) return ['done', 'behind her (Musaned: at the embassy or later)']
    return r
  }
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
  // Once she is Selected, the steps before it are behind her: done, never open or red.
  if (selected.state === 'done') for (const st of [cv, musaned]) if (st.state !== 'done') { st.state = 'done'; st.note = st.key === 'cv' && !hasCv ? 'passed' : (st.note || 'passed') }
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
    // Tasheer and the police clearance: the Profiles page's tabs after the EPRO.
    extra: [wakala,
      step('tasheer', 'Tasheer', ...tasheerState(), 'tasheer_schedule'),
      step('police', 'Police', ...fromRun(runs.police_certificate, 'certificate done'), 'police_certificate')],
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

// The one step she is at (the profile page shows only what it needs).
router.get('/profiles/:profileId/step', async (req, res) => {
  try {
    const db = req.app.locals.db
    const id = Number(req.params.profileId)
    const p = await db('profiles').where('id', id).first()
    if (!p) return res.status(404).json({ error: 'Profile not found' })
    res.json(stepNow(p, await journeyFor(db, id, p)))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/profiles/:profileId/journey', async (req, res) => {
  try {
    const db = req.app.locals.db
    const id = Number(req.params.profileId)
    const p = await db('profiles').where('id', id).first()
    if (!p) return res.status(404).json({ error: 'Profile not found' })
    const runs = {}
    for (const r of await db('automation_queue').where('profile_id', id).select('id', 'workflow_id', 'status').orderBy('id', 'asc')) runs[r.workflow_id] = r   // id: added again after a delete (goneFromMusaned)
    const cv = await db('generated_cvs').where('profile_id', id).first('id').catch(() => null)   // only whether one exists (its snapshot can be MBs)
    const docs = (await docsOf(db, [id])).get(id) || new Set()
    const lacks = await lacksOf(db, id, p)   // [] = her CV is complete (services/cvComplete.js), null = not asked here
    const hasCv = !!cv || docs.has('CV') || (lacks?.length === 0 && 'ready')
    res.json({ ...journeyOf(p, runs, hasCv, docs, (await agentsOut(db, [id])).get(id) || []), cv_missing: cvMissing(p, docs, hasCv), ...(lacks ? { cv_lacks: lacks } : {}) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

/**
 * Where her work stands, step by step (asked on 2026-11-17: never jump a
 * step): 1 CV → 2 Musaned → 3 chosen → 4 Wafid FIT → 5 EPRO approved; after
 * that, every other robot is a choice. Returns { key, n, of, why }.
 */
export function stepNow(p, journey) {
  const at = Object.fromEntries(journey.embassy.map(x => [x.key, x]))
  const done = (k) => at[k]?.state === 'done'
  const STEPS = [
    ['cv', 'Make her CV', () => done('cv')],
    ['musaned', 'Add her to Musaned', () => ['done', 'waiting'].includes(at.musaned?.state)],
    ['selected', 'Wait until an employer chooses her', () => done('selected')],
    ['wafid', 'Wafid medical: book it, then check until FIT', () => p.status === 'medical_fit' || done('wafid')],
    ['epro', 'Approve the EPRO on Musaned', () => done('epro')],
  ]
  // The furthest step she reached counts: everything before it is behind her
  // (a profile made before this rule, or a CV made outside Adal Keep).
  let reached = -1
  STEPS.forEach(([, , ok], i) => { if (ok()) reached = i })
  const i = reached + 1
  if (i >= STEPS.length) return { key: 'choices', n: STEPS.length + 1, of: STEPS.length, title: 'EPRO approved — choose what is next' }
  const [key, title] = STEPS[i]
  return { key, n: i + 1, of: STEPS.length, title, unfit: key === 'wafid' && p.status === 'medical_rejected' }
}

/**
 * The Profiles page's Waiting tab (asked on 2026-11-19): on Musaned, nobody
 * chose her yet, nothing after it done — and not UNFIT. The only girls whose
 * CVs may go to agents on WhatsApp. steps: { key: state } (journeyOf).
 * (The same rule as phaseOf() in the frontend's ProfilesPage.jsx.)
 */
export function inWaitingPhase(steps = {}, p = {}) {
  return ['done', 'waiting'].includes(steps.musaned) && steps.selected !== 'done'
    && !(p.status === 'medical_fit' || steps.wafid === 'done') && steps.epro !== 'done'
    && p.status !== 'medical_rejected'
}

/** Of these profiles, the ones in the Waiting tab: Set(id). */
export async function waitingIds(db, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))]
  if (!list.length) return new Set()
  const out = new Set()
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500)
    const profiles = await db('profiles').whereIn('id', part).select('*')
    const runs = new Map()
    for (const r of await db('automation_queue').whereIn('profile_id', part).select('profile_id', 'workflow_id', 'status', 'pause_reason').orderBy('id', 'asc')) {
      if (!runs.has(r.profile_id)) runs.set(r.profile_id, {})
      runs.get(r.profile_id)[r.workflow_id] = r
    }
    for (const p of profiles) {
      const steps = Object.fromEntries(journeyOf(p, runs.get(p.id) || {}, true).embassy.map(s => [s.key, s.state]))
      if (inWaitingPhase(steps, p)) out.add(p.id)
    }
  }
  return out
}

/**
 * The Wafid tab: chosen, Wafid booked or being booked (or its booking failed),
 * no result yet (FIT moves her on), EPRO not done — or UNFIT before the EPRO
 * (no Unfit tab since 2026-11-19: she stays on Wafid, marked UNFIT) —
 * the page's phaseOf() === 'wafid' (frontend lib/phase.js).
 */
export function inWafidPhase(steps = {}, p = {}) {
  if (p.status === 'medical_rejected') {
    return steps.wafid !== 'done' && steps.epro !== 'done'
      && (steps.cv === 'done' || ['done', 'waiting'].includes(steps.musaned) || steps.selected === 'done')
  }
  return steps.selected === 'done' && p.status !== 'medical_fit' && p.status !== 'medical_rejected'
    && steps.wafid !== 'done' && steps.epro !== 'done'
    && (p.status === 'medical_applied' || ['active', 'failed'].includes(steps.wafid))
}

/** The girls in the Wafid tab (with a passport number), for the daily result check. */
export async function wafidTabProfiles(db) {
  const profiles = await db('profiles').whereNotNull('passport_number').whereNot('passport_number', '')
    .whereNotIn('status', ['medical_fit', 'medical_rejected']).select('*')
  if (!profiles.length) return []
  const runs = new Map()
  const ids = profiles.map(p => p.id)
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of await db('automation_queue').whereIn('profile_id', ids.slice(i, i + 500)).select('profile_id', 'workflow_id', 'status', 'pause_reason').orderBy('id', 'asc')) {
      if (!runs.has(r.profile_id)) runs.set(r.profile_id, {})
      runs.get(r.profile_id)[r.workflow_id] = r
    }
  }
  return profiles.filter(p => {
    const steps = Object.fromEntries(journeyOf(p, runs.get(p.id) || {}, true).embassy.map(s => [s.key, s.state]))
    return inWafidPhase(steps, p)
  })
}

// The robots each step may start ("Check if chosen" always may: it keeps her stage up to date).
export const STEP_ROBOTS = {
  cv: ['musaned_check_chosen'],
  musaned: ['musaned_add_candidate', 'musaned_check_chosen'],
  selected: ['musaned_check_chosen', 'musaned_delete'],
  wafid: ['wafid_book', 'wafid_check', 'wafid_slip', 'musaned_check_chosen', 'musaned_delete'],
  epro: ['musaned_epro_approve', 'wafid_slip', 'musaned_check_chosen', 'musaned_delete'],
}

async function journeyFor(db, id, p) {
  const runs = {}
  for (const r of await db('automation_queue').where('profile_id', id).select('id', 'workflow_id', 'status').orderBy('id', 'asc')) runs[r.workflow_id] = r
  const cv = await db('generated_cvs').where('profile_id', id).first('id').catch(() => null)   // only whether one exists (its snapshot can be MBs)
  const docs = (await docsOf(db, [id])).get(id) || new Set()
  return journeyOf(p, runs, !!cv || docs.has('CV') || (await isComplete(db, id, p) && 'ready'), docs, [])
}

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

// "Needs action today" (services/needsAction.js): older pages ask it; today's dashboard does not.
router.get('/needs-action', async (req, res) => {
  try {
    const { needsActionToday } = await import('../services/needsAction.js')
    res.json(await needsActionToday(req.app.locals.db))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/automations/stages', async (req, res) => {
  try { res.json(await allStages(req.app.locals.db)) } catch (e) { res.status(500).json({ error: e.message }) }
})

/** Every profile's stage and journey steps (the list's columns; services/profileDays.js keeps them per day). */
export async function allStages(db) {
  {
    const profiles = await db('profiles').select('id', 'status', 'musaned_stage', 'chosen_at', 'visa_stage', 'visa_application_number',
      'musaned_pro', 'employer_name', 'work_city', 'contract_number', 'labor_id', 'visa_number', 'medical_valid_until', 'musaned_payment',
      'tasheer_ref', 'tasheer_date', ...CV_COLUMNS)
    const ready = await completeIds(db, profiles)   // her CV needs nothing more (no PDF needed)
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
      const all = (() => { const j = journeyOf(p, latest.get(p.id) || {}, withCv.has(p.id) || d.has('CV') || (ready.has(p.id) && 'ready'), d, agents.get(p.id) || []); return [...j.embassy, ...j.extra] })()
      return {
        steps: Object.fromEntries(all.map(s => [s.key, s.state])),
        notes: Object.fromEntries(all.filter(s => s.state === 'failed' && s.note).map(s => [s.key, s.note])),
        problem: problemOf(latest.get(p.id), new Set(all.filter(s => s.state === 'done').map(s => s.workflow))),
        who: Object.fromEntries(all.filter(s => s.who).map(s => [s.key, s.who])),
        missing: Object.fromEntries(all.map(s => [s.key, (s.docs || []).filter(x => !x.have).map(x => x.name)]).filter(([, m]) => m.length)),
      }
    }
    return { stages: STAGES, profiles: profiles.map(p => ({ profile_id: p.id, stage: stageOf(p, latest.get(p.id)), musaned_stage: p.musaned_stage || '', ...stepsOf(p) })) }
  }
}

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
  // A site's sign-in tab, not a run's ("site-tasheer"): the same live view.
  // A move's browser (Transitions, "tr-pextran"): the same live view.
  if (/^tab-/.test(String(runId))) return (await import('../services/openTabs.js')).pageOfTab(String(runId))
  if (/^tr-/.test(String(runId))) return (await import('../services/robotBrowsers.js')).liveTabOf(String(runId))
  if (/^site-/.test(String(runId))) return (await import('../services/sessionKeeper.js')).siteTab(String(runId)) || (await import('../services/tasheerSession.js')).siteTab(String(runId))
  const run = await db('automation_queue').where('id', runId).first('id', 'workflow_id', 'status').catch(() => null)
  if (!run) return null
  // Looking at a finished run's tab does not make it that run's again (the site's next run uses it).
  const browser = await openBrowserIfAny()
  const look = async () => findRunTab(browser, run.id, run.workflow_id, { adopt: ['pending', 'running', 'paused'].includes(run.status), lookOnly: true, liveRuns: await activeRunIds(db) })
  let page = await look()
  // A closed tab: forget it and look again. A slow one is NOT forgotten: on a weak PC or a slow line the
  // page is busy (Google's reCAPTCHA loading) and missed the 2.5-s look, the live view dropped the tab the
  // run was working in, and the person's clicks got "no robot browser" (2026-11-24, this PC).
  if (page && page.isClosed?.()) { dropTab(run.id); page = await look() }
  return page && !page.isClosed?.() ? page : null
}
// A browser that does not answer (a tab that never attached, a PC busy starting it) must
// not leave the live view grey for ever (asked on 2026-11-23): after 6 s it says so.
const SLOW = Symbol('slow')
// The tab a live view found for a run, kept: every click, key and picture of the view uses it at once
// (each one used to look for it again — the database, every tab's name, an answer from the page).
const _liveTabs = new Map()   // run id → { page, at }
const KEEP_MS = 60000
const liveTab = async (req) => {
  const id = String(req.params.id)
  const k = _liveTabs.get(id)
  if (k && !k.page.isClosed?.() && Date.now() - k.at < KEEP_MS) return marked(k.page, req)
  // The run's own tab, known here: at once (looking for it asks the database, the browser's port and every tab; on a
  // full PC that took over 6 s and the click was refused, 2026-11-25).
  const own = handsOn() && /^\d+$/.test(id) ? tabOfRun(id) : null
  if (own) return marked(own, req)
  let t
  const page = await Promise.race([runTab(req.app.locals.db, req.params.id).catch(() => null), new Promise(ok => { t = setTimeout(() => ok(SLOW), 6000) })])
  clearTimeout(t)
  if (page === SLOW && handsOn() && k && !k.page.isClosed?.()) return marked(k.page, req)   // the one of a moment ago
  if (page && page !== SLOW) { _liveTabs.set(id, { page, at: Date.now() }); if (_liveTabs.size > 30) _liveTabs.delete(_liveTabs.keys().next().value) }
  return marked(page, req)
}
// When a person looked at the tab and when they last clicked in it (robotCheck.waitForTick: a sign-in waiting
// long is loaded fresh when the person opens it — never just after a click of theirs).
const marked = (page, req) => {
  if (page && page !== SLOW) { if (req.method === 'GET') page.__adalLookedAt = Date.now(); else page.__adalInputAt = Date.now() }
  return page
}
/** One input, 8 s at most: a stuck one never holds the person's next click behind it. */
const bounded = (p, ms = 8000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('The tab did not take it in time (slow PC or line): try again.'), { status: 504 })), ms))])
const noTab = (res, page) => page === SLOW
  ? res.status(504).json({ error: 'The robot browser does not answer just now.', slow: true })
  : res.status(404).json({ error: 'No robot browser is open for this.' })

// One answer that never ends: the tab's pictures and its address, each only when it changed (services/liveStream.js).
router.get('/automations/:id/live', async (req, res) => {
  const L = await import('../services/liveStream.js')
  if (!L.liveOn()) return res.status(404).json({ error: 'off', live2: false })
  const id = req.params.id, db = req.app.locals.db
  let found = 0
  await L.serveLive(req, res, {
    codeBox: codeBoxUp,
    // The tab the run works in, known here: never asked anything first (a busy page answers in seconds).
    tabOf: async () => {
      const known = /^\d+$/.test(id) ? tabOfRun(Number(id)) : null
      if (known) return known
      if (Date.now() - found < 1500) return null      // looked for in the browser at most every 1.5 s
      found = Date.now()
      return Promise.race([runTab(db, id).catch(() => null), new Promise(ok => setTimeout(() => ok(null), 6000))])
    },
    ended: async () => /^tab-/.test(id) ? (await import('../services/openTabs.js')).tabGone(id) : /^\d+$/.test(id) && !['pending', 'running', 'paused'].includes((await db('automation_queue').where('id', id).first('status'))?.status),
    onOpen: async (page) => {
      page.__adalLookedAt = Date.now()
      const { freshForm } = await import('../services/freshForm.js')
      await freshForm(db, id, page)
    },
  }).catch(() => { try { res.end() } catch {} })
})

router.get('/automations/:id/screen', async (req, res) => {
  const page = await liveTab(req)
  if (!page || page === SLOW) return noTab(res, page)
  try {
    const { latestFrame } = await import('../services/liveFrames.js')   // the stream's last picture (a screenshot of its own took 2.4 s on a 2-core PC)
    const shot = await Promise.race([
      latestFrame(page),
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
  if (!page || page === SLOW) return noTab(res, page)
  const { watchFrames } = await import('../services/liveFrames.js')
  let stop = () => {}, stopAgain = () => {}
  let closed = false
  req.on('close', () => { closed = true; stopAgain(); stop() })
  try {
    res.socket?.setNoDelay(true)
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=adalframe', 'Cache-Control': 'no-store', Connection: 'close', 'X-Accel-Buffering': 'no' })
    // A browser draws a picture of such a stream only when the next one comes: on a still page it stayed on
    // "Opening the robot's browser…" (2026-11-25). The last one is sent once more when nothing follows it.
    let newest = null, again = null
    stopAgain = () => clearTimeout(again)
    const part = (img) => res.write(Buffer.concat([Buffer.from(`--adalframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${img.length}\r\n\r\n`), img, Buffer.from('\r\n')]))
    const give = () => {
      if (!newest || res.writableNeedDrain || closed) return
      const img = newest
      newest = null
      part(img)
      clearTimeout(again)
      again = setTimeout(() => { if (!newest && !closed && !res.writableNeedDrain) part(img) }, 200)
    }
    res.on('drain', give)
    stop = await watchFrames(page, (img) => {
      newest = img
      give()
    }, () => res.end())
    if (closed) stop()
  } catch { res.end() }
})

// What goes with the pictures: the address, and whether the page asks for a code.
router.get('/automations/:id/tab', async (req, res) => {
  const page = await liveTab(req)
  if (!page || page === SLOW) return noTab(res, page)
  const slow = (p, d) => Promise.race([p, new Promise(r => setTimeout(() => r(d), 2500))])
  const size = await slow(page.evaluate(() => [innerWidth, innerHeight]).catch(() => null), null)
  res.set('Cache-Control', 'no-store').json({ url: page.url(), title: await slow(page.title().catch(() => ''), ''), codeBox: await slow(codeBoxUp(page), false), size })
})

export const LIVE_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Delete', 'PageDown', 'PageUp', 'Home', 'End', 'Space']
/** Scrolls the page, or the box inside it that scrolls (a long form often sits
 *  in one, a dialog too): the first of them that can still move that way. */
function scrollPage(dx, dy) {
  const can = (e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll|overlay/.test(getComputedStyle(e).overflowY)
  const room = (e) => dy > 0 ? e.scrollHeight - e.clientHeight - e.scrollTop > 1 : dy < 0 ? e.scrollTop > 0 : true
  const page = document.scrollingElement || document.documentElement
  // To the end: the page and every box in it.
  if (dy >= 1e6) {
    page.scrollTo({ top: page.scrollHeight, behavior: 'instant' })
    document.querySelectorAll('*').forEach(e => { if (can(e)) e.scrollTop = e.scrollHeight })
    return
  }
  const boxes = [...document.querySelectorAll('*')].filter(e => can(e) && e.getClientRects().length)
    .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)
  // A dialog on top first, then the page, then the biggest box that still has room.
  const dialog = boxes.find(e => e.closest('[role="dialog"], .modal, .MuiDialog-root, .cdk-overlay-pane') && room(e))
  const target = dialog || (room(page) && page.scrollHeight > page.clientHeight + 4 ? page : boxes.find(room)) || page
  target.scrollBy({ left: dx, top: dy, behavior: 'instant' })
}

// The live view as a real browser (2026-11-21): the person's own mouse (move,
// press, release: hover, drag, select), wheel, keys with Ctrl/Shift/Alt, and
// paste, straight into the tab over CDP — one message each, no page script.
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const modsOf = (b) => Object.entries(MODS).reduce((m, [k, v]) => m | (b[k] ? v : 0), 0)
const BUTTONS = ['left', 'middle', 'right']
const cdpOf = (page) => page.__adalInputCdp || (page.__adalInputCdp = page.createCDPSession().catch(e => { page.__adalInputCdp = null; throw e }))
async function viewSize(page) {
  if (page.__adalSize && Date.now() - page.__adalSize.at < 2000) return page.__adalSize
  const [w, h] = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  return (page.__adalSize = { w, h, at: Date.now() })
}
const NAMED_KEY = /^(F\d{1,2}|Insert|Shift|Control|Alt|Meta|CapsLock|ContextMenu)$/
async function rawInput(page, b) {
  const cdp = await cdpOf(page)
  const { w, h } = await viewSize(page)
  const x = Math.max(0, Math.min(1, Number(b.x) || 0)) * w, y = Math.max(0, Math.min(1, Number(b.y) || 0)) * h
  const modifiers = modsOf(b)
  if (b.kind === 'mouse') {
    const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[b.type]
    if (!type) throw Object.assign(new Error('Unknown mouse input'), { status: 400 })
    const button = type === 'mouseMoved' ? (b.buttons ? 'left' : 'none') : (BUTTONS[Number(b.button) || 0] || 'left')
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: Number(b.buttons) || 0, clickCount: type === 'mouseMoved' ? 0 : Math.max(1, Math.min(3, Number(b.clickCount) || 1)), modifiers })
  } else if (b.kind === 'wheel') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Math.max(-3000, Math.min(3000, Number(b.dx) || 0)), deltaY: Math.max(-3000, Math.min(3000, Number(b.dy) || 0)), modifiers })
  } else if (b.kind === 'paste') {
    await cdp.send('Input.insertText', { text: String(b.text || '').slice(0, 20000) })
  }
}

/** One tap, key, scroll or move in a run's tab (the phone's / Admin's live view). */
export async function liveInput(page, b = {}) {
  if (['mouse', 'wheel', 'paste'].includes(b.kind)) return rawInput(page, b)
  if (b.kind === 'key' && (modsOf(b) || (String(b.key || '').length === 1) || NAMED_KEY.test(String(b.key || '')))) {
    // A key with Ctrl/Alt/Shift (Ctrl+A, Ctrl+C, Shift+Tab …), any character, F1–F12.
    const key = String(b.key || '')
    if (!key || key.length > 12) throw Object.assign(new Error('Unknown key'), { status: 400 })
    const held = ['Control', 'Shift', 'Alt', 'Meta'].filter(m => b[{ Control: 'ctrl', Shift: 'shift', Alt: 'alt', Meta: 'meta' }[m]])
    for (const m of held) await page.keyboard.down(m)
    try { await page.keyboard.press(key === 'Space' ? ' ' : key) } finally { for (const m of held.reverse()) await page.keyboard.up(m).catch(() => {}) }
    return
  }
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
  if (b.kind === 'click' || (b.kind === 'mouse' && b.type === 'up')) return page.evaluate(`(${isSignIn})(document.elementFromPoint(${Number(b.x)} * innerWidth, ${Number(b.y)} * innerHeight))`)
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
  // (Is it Sign In? 1 s at most: the click itself never waits for a busy page to say.)
  const signIn = await Promise.race([pressesSignIn(page, b).catch(() => false), new Promise(r => setTimeout(() => r(false), 1000))])
  await liveInput(page, b)
  return signIn ? codeOfRun(db, runId).catch(() => null) : null
}

// The tab as a light page for the phone (services/pageMirror.js).
const mirrorShots = new Map()
router.get('/automations/:id/mirror', async (req, res) => {
  const page = await liveTab(req)
  if (!page || page === SLOW) return noTab(res, page)
  try {
    const { mirrorOf } = await import('../services/pageMirror.js')
    if (!mirrorShots.has(req.params.id)) mirrorShots.set(req.params.id, new Map())
    if (mirrorShots.size > 20) mirrorShots.delete(mirrorShots.keys().next().value)
    res.set('Cache-Control', 'no-store').json(await mirrorOf(page, mirrorShots.get(req.params.id)))
  } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

// Every person input (not the mouse moves) in the log with how it went (2026-11-24: "I can't click it").
const inputLog = (id, what, t0, err) => console.log(`[live] run ${id} ${what} → ${err ? `failed: ${String(err.message || err).slice(0, 80)}` : 'ok'} (${Date.now() - t0} ms)`)
const what = (x) => [x.kind, x.type, x.key, x.x != null ? `${Number(x.x).toFixed(2)},${Number(x.y).toFixed(2)}` : ''].filter(Boolean).join(' ')
router.post('/automations/:id/input', async (req, res) => {
  const t0 = Date.now()
  const page = await liveTab(req)
  if (!page || page === SLOW) { console.log(`[live] run ${req.params.id} input → ${page === SLOW ? 'the tab did not answer in 6 s' : 'no tab'}`); return noTab(res, page) }
  const b = req.body || {}
  // Straight to the browser, in order, never behind a picture, never given up (services/liveHands.js).
  if (handsOn()) {
    try {
      const db = req.app.locals.db, list = Array.isArray(b.batch) ? b.batch.slice(0, 200) : [b]
      const signIn = [...list].reverse().find(x => x.kind === 'click' || (x.kind === 'mouse' && x.type === 'up') || (x.kind === 'key' && x.key === 'Enter'))
      const asked = signIn ? bounded(pressesSignIn(page, signIn), 1000).catch(() => false) : false   // asked beside, the click does not wait for it
      const move = list.every(x => (x.kind === 'mouse' && x.type === 'move') || x.kind === 'wheel')
      const r = await hands(page, list, { waitMs: move ? 0 : 1200, other: (x) => personInput(db, req.params.id, page, x),
        log: (x, ms, err) => { if (!err || x.kind !== 'mouse' || x.type !== 'move') console.log(`[live] run ${req.params.id} ${what(x)} → ${err ? `failed: ${String(err.message || err).slice(0, 80)}` : 'taken'} (${ms} ms)`) } })
      const code = r.code || (signIn && await asked ? await codeOfRun(db, req.params.id).catch(() => null) : null)
      if (list.some(x => x.kind === 'reload')) import('../services/freshForm.js').then(f => f.refillAfterReload(db, req.params.id, page)).catch(() => {})
      return res.json({ ok: true, code, sent: r.sent, taken: r.taken, ...(r.error ? { error: r.error.message } : {}) })
    } catch (e) { return res.status(e.status || 500).json({ error: e.message }) }
  }
  // A burst of mouse moves, wheel turns and keys from the browser view: done in order, answered at once.
  if (Array.isArray(b.batch)) {
    let code = null
    const run = async () => { for (const x of b.batch.slice(0, 200)) { const t1 = Date.now(); try { code = (await bounded(personInput(req.app.locals.db, req.params.id, page, x))) || code; if (!(x.kind === 'mouse' && x.type === 'move')) inputLog(req.params.id, what(x), t1) } catch (e) { inputLog(req.params.id, what(x), t1, e) } } }
    page.__adalInputChain = (page.__adalInputChain || Promise.resolve()).then(run, run)
    await page.__adalInputChain
    return res.json({ ok: true, code })
  }
  // Mouse moves and the wheel: answered at once, done in order behind (a drag stays smooth).
  if ((b.kind === 'mouse' && b.type === 'move') || b.kind === 'wheel') {
    page.__adalInputChain = (page.__adalInputChain || Promise.resolve()).then(() => bounded(liveInput(page, b), 3000)).catch(() => {})
    return res.json({ ok: true })
  }
  try { await bounded(page.__adalInputChain || Promise.resolve(), 3000).catch(() => {}); const code = await bounded(personInput(req.app.locals.db, req.params.id, page, b), b.kind === 'nav' || b.kind === 'reload' ? 50000 : 8000); inputLog(req.params.id, what(b), t0); res.json({ ok: true, code }) }
  catch (e) { inputLog(req.params.id, what(b), t0, e); res.status(e.status || 500).json({ error: e.message }) }
})


/**
 * A person's button on a run (Cancel, a "done" button, Continue) goes into her
 * notes too, under the run's portal — so the notes never still say "waiting
 * for a person" after the person answered.
 */
const PORTAL_OF = [[/^musaned/, 'Musaned'], [/^wafid/, 'Wafid medical'], [/^insurance/, 'Insurance'], [/^tasheer/, 'Tasheer'], [/^mofa/, 'Visa'], [/^police/, 'Police'], [/^(lmis|contract|delete)/, 'LMIS']]
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
    if (row.status !== 'paused' && row.status !== 'pending') {
      return res.status(409).json({ error: `Run #${runId} is ${row.status} — nothing to continue. Start it again from its card.` })
    }
    if (/^with-run-/.test(row.pause_reason || '')) {
      return res.status(409).json({ error: `She is on the certificate of run #${row.pause_reason.slice(9)} — it finishes with that run.` })
    }
    // Running the visa form again would make a second application.
    if (row.pause_reason === 'awaiting-tasheer-save') {
      return res.status(409).json({ error: `Run #${runId} uploaded the Excel on Tasheer already. Press Save in its tab, then "✔️ Tasheer saved" — or Cancel it to start over.` })
    }
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
    await personAsked(db, row)   // from now on a run somebody asked for: the robot browser opens for it (personPress.js)
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

// "Mark as done" moves her to the next stage (services/markDone.js — one
// function for every "✔️ … saved" / "done" control; its answer carries an
// undo token for the 5 s Undo).
// A paused run's "✔️ … saved" (the person pressed Submit / SAVE in its tab): the run is done. Its tab stays open.
router.post('/automations/:id/complete', async (req, res) => {
  try {
    const { markStepDone } = await import('../services/markDone.js')
    const r = await markStepDone(req.app.locals.db, { runId: Number(req.params.id) })
    res.json({ ...r, tabClosed: false, message: `Run #${r.run_id} marked complete.${r.message.replace(/^Marked done\./, '')}` })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/**
 * A step done by hand (the checkbox on its card): the step counts as done —
 * its open run (waiting, held) ends done, or a done entry is written — and
 * what it starts next is started, as if the robot had done it.
 * { done: false } takes back a tick made by hand.
 */
router.post('/profiles/:id/automations/:workflowId/mark-done', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.id)
    const { workflowId } = req.params
    if (req.body?.done === false) {
      const { untickByHand } = await import('../services/markDone.js')
      return res.json(await untickByHand(db, { profileId, workflowId }))
    }
    const { markStepDone } = await import('../services/markDone.js')
    res.json(await markStepDone(db, { profileId, workflowId, note: 'done — ticked by hand' }))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// A journey step marked done (wafid = Medical done, epro, visa = Visa issued, …).
router.post('/profiles/:id/steps/:step/done', async (req, res) => {
  try {
    const { markStepDone } = await import('../services/markDone.js')
    res.json(await markStepDone(req.app.locals.db, { profileId: Number(req.params.id), step: req.params.step, note: 'marked done by a person' }))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// A done step unchecked: she goes back to it, later steps open again (services/markDone.js markStepUndone; same 5 s Undo).
router.post('/profiles/:id/steps/:step/undone', async (req, res) => {
  try {
    const db = req.app.locals.db
    const { markStepUndone } = await import('../services/markDone.js')
    // Named in her notes: who asked (signed in, or the PC's default employee), else the PC's active one.
    let employee = null
    try { employee = (await (await import('../services/staffRoles.js')).permsFor(db, req)).user || null } catch {}
    if (!employee) try { employee = await (await import('../services/activeEmployee.js')).getActiveEmployee(db) } catch {}
    res.json(await markStepUndone(db, { profileId: Number(req.params.id), step: req.params.step, employee }))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// The Undo of a "mark as done" (its token).
router.post('/automations/undo-done', async (req, res) => {
  try {
    const { undoMarkDone } = await import('../services/markDone.js')
    res.json(await undoMarkDone(req.app.locals.db, req.body?.undo))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
