/**
 * worker.js — runs queued automation jobs, each in its own browser tab.
 *
 * v10 — no agent pool. Every run gets its own tab (tabManager.openRunTab) and
 *       only ever touches that tab, so two runs at once never share a tab or
 *       steer each other's. One run works at the
 *       same time; the rest wait in line and start by themselves, oldest
 *       first, when a slot frees (runQueue.js).
 *
 * v9 — real backoff. A retry's deadline is stored in `updated_at` (a future
 *      ISO timestamp) and readyJobsQuery refuses retry-* jobs until that
 *      deadline passes. BASE is env-configurable and defaults to 2 min.
 *      Permanent errors (LMIS "not in pool" and the like) are not retried.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { getBrowser, openBrowserIfAny } from './browser.js'
import { needPerson, askCaptcha, doneWith } from './attention.js'
import { runFullWorkflow } from './lmisWorkflow.js'
import { decideAgencyActions } from './jev/agencyManager.js'
import { getActiveEmployee } from './activeEmployee.js'
import { isAppLocked } from './subscription.js'
import { plainReason, workflowName, withInternetCheck } from './runOutcome.js'
import { openRunTab, forgetRunTab, tabOfRun, handTabToPerson, findRunTab, activeRunIds, hostOf, codeBoxUp } from './tabManager.js'
import { registerTab, unregisterTab, noteLink } from './bandwidth.js'
import { createRunQueue } from './runQueue.js'
import { reportRuns } from './busy.js'
import { isCancelled, clearCancelled } from './cancellation.js'
import { assertPoliceReady } from './verification.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')

// How many runs may work at the same time, each in its own tab.
// One agent at a time: it gets the whole internet, and nothing else competes with it.
const MAX_RUNS           = 1
const POLL_MS            = 5000
// Retry backoff: attempt 1 waits this long, attempt 2 waits 4× this.
const AGENCY_INTERVAL_MS = 30 * 60 * 1000   // 30 min
const AGENCY_PROFILE_LIMIT = Number(process.env.AGENCY_PROFILE_LIMIT || 200)

// Errors retrying can never fix. Add LMIS/companion-specific permanent
// reasons here so they don't burn attempts on a 2-minute loop.

let _interval      = null
let _agencyTimer   = null
let _agencyRunning = false

// --------------------------------------------------------------------------
// One small beep for every call, and nothing more: no voice, no alarm, no
// window. What the call is about shows in the notification bar.
// --------------------------------------------------------------------------
let _lastBeep = 0
export function beep() {
  if (Date.now() - _lastBeep < 3000) return     // several calls at once: one beep
  _lastBeep = Date.now()
  try {
    let cmd, args
    if (process.platform === 'win32') { cmd = 'powershell'; args = ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', '[console]::beep(1000,180)'] }
    else if (process.platform === 'darwin') { cmd = 'afplay'; args = ['/System/Library/Sounds/Tink.aiff'] }
    else { cmd = 'paplay'; args = ['/usr/share/sounds/freedesktop/stereo/message.oga'] }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

// --------------------------------------------------------------------------
// File resolution
// --------------------------------------------------------------------------
async function resolveFilePaths(db, profileId) {
  const get = async (fieldName) => {
    const row = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.name', fieldName)
      .select('files.path')
      .orderBy('files.id', 'desc')
      .first()
    if (!row) return null
    const abs = path.join(SAFE_STORAGE_DIR, path.basename(row.path))
    return fs.existsSync(abs) ? abs : path.join(process.cwd(), row.path)
  }

  const getPassportImage = async () => {
    const row = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.name', 'Passport')
      .where(function () {
        this.where('files.mimetype', 'like', 'image/%')
          .orWhere('files.path', 'like', '%.jpg')
          .orWhere('files.path', 'like', '%.jpeg')
          .orWhere('files.path', 'like', '%.png')
          .orWhere('files.path', 'like', '%.webp')
      })
      .select('files.path')
      .orderBy('files.id', 'desc')
      .first()
    if (!row) return null
    const abs = path.join(SAFE_STORAGE_DIR, path.basename(row.path))
    return fs.existsSync(abs) ? abs : path.join(process.cwd(), row.path)
  }

  // The LMIS passport field takes a PDF. Use the newest passport PDF; fall back to
  // the newest passport file when the profile has no PDF (the job makes one).
  const getPassportPdf = async () => {
    const row = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.name', 'Passport')
      .where(function () {
        this.where('files.mimetype', 'application/pdf').orWhere('files.path', 'like', '%.pdf')
      })
      .select('files.path')
      .orderBy('files.id', 'desc')
      .first()
    if (!row) return null
    const abs = path.join(SAFE_STORAGE_DIR, path.basename(row.path))
    return fs.existsSync(abs) ? abs : path.join(process.cwd(), row.path)
  }

  return {
    photoPath: await get('Photo'),
    passportPath: (await getPassportPdf()) || (await get('Passport')),
    passportImagePath: await getPassportImage(),
    fullBodyPath: await get('Full Body Photo'),
    slipPath: await get('Slip'),
    // LMIS contract documents (lmisContract.js).
    contractPath: (await get('Contract (EPRO + Candidate signed)')) || (await get('Contract (PRO + Employer signed)')) || (await get('Contract')),
    insurancePath: await get('Insurance'),
    governmentIdPath: await get('Government ID'),
    visaPath: await get('Visa'),
  }
}

/** Agency choices the Wafid form uses (Settings → Wafid). */
async function wafidSettings(db) {
  const rows = await db('settings').whereIn('key', ['agency_email', 'wafid_city', 'wafid_issue_place', 'wafid_position']).catch(() => [])
  const get = (k) => String(rows.find(r => r.key === k)?.value || '').trim()
  return { email: get('agency_email'), city: get('wafid_city') || 'Addis Ababa', issuePlace: get('wafid_issue_place') || 'ADDIS ABABA', position: get('wafid_position') || 'House Maid' }
}

/** Agency choices the visa and insurance forms use (Settings, keys visa_* / insurance_*). */
async function visaSettings(db) {
  const rows = await db('settings').where('key', 'like', 'visa_%').orWhere('key', 'like', 'insurance_%').orWhere('key', 'agency_email').catch(() => [])
  return Object.fromEntries(rows.map(r => [r.key, String(r.value ?? '').trim()]))
}

// --------------------------------------------------------------------------
// Run execution — one run, one tab
// --------------------------------------------------------------------------
/** A run gets one try: it fails here and says why. A person presses it again. */
async function recordFailure(db, job, errText) {
  const why = await withInternetCheck(errText)
  await db('automation_queue').where('id', job.id).update({
    status: 'failed',
    pause_reason: why,
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  console.log(`[worker] run #${job.id} failed: ${why}`)
  await noteFailure(db, job, why).catch(e => console.warn('[worker] note failed:', e.message))
}

/** Her profile says what went wrong, once (the same failure again adds nothing). */
async function noteFailure(db, job, errText) {
  const line = `${workflowName(job.workflow_id)}: ${plainReason(errText)}`
  const row = await db('profiles').where('id', job.profile_id).first('notes')
  if (String(row?.notes || '').split('\n').pop().endsWith(line)) return
  const dated = `[${new Date().toISOString().slice(0, 10)}] ${line}`
  await db('profiles').where('id', job.profile_id).update({ notes: row?.notes ? `${row.notes}\n${dated}` : dated, updated_at: new Date().toISOString() })
}

/**
 * Run one claimed job in the tab it owns. Returns true when the run paused
 * for a person (sign-in, OTP, Submit, SAVE): its tab then stays open for them.
 */
async function executeRun(db, page, job) {
  const runId = job.id

  // One write at a time: steps log without waiting, and two read-modify-writes
  // at once used to drop lines.
  let logChain = Promise.resolve()
  const onLog = (level, msg) => { if (/^✓/.test(msg)) doneWith(runId); const ts = Date.now(); return (logChain = logChain.then(() => writeLog(level, msg, ts)).catch(() => {})) }
  const writeLog = async (level, msg, ts) => {
    const row = await db('automation_queue').where('id', runId).first()
    let log = []
    try { log = JSON.parse(row?.log || '[]') } catch {}
    log.push({ ts, level, msg })
    if (log.length > 200) log = log.slice(-200)
    await db('automation_queue').where('id', runId).update({ log: JSON.stringify(log) })
  }

  const handleCancelled = async () => {
    try {
      await db('automation_queue').where('id', runId).update({
        status: 'cancelled',
        pause_reason: 'Cancelled by user',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await onLog('warn', '⛔ Cancelled by user — run stopped')
    } catch {}
  }

  // Cancelled while it was waiting for the browser: never start it.
  if (isCancelled(runId)) { await handleCancelled(); return false }

  const profile = await db('profiles').where('id', job.profile_id).first()
  if (!profile) throw new Error('Profile not found')

  const files    = await resolveFilePaths(db, job.profile_id)
  const savedCtx = JSON.parse(job.context || '{}')

  const musanedStage = (() => {
    if (!job.workflow_id.startsWith('musaned')) return 'start'
    if (savedCtx.musanedStage) return savedCtx.musanedStage
    if (job.status !== 'paused')               return 'start'
    if (!job.pause_reason)                     return 'start'
    if (job.pause_reason.startsWith('awaiting-musaned-')) return job.pause_reason
    return 'start'
  })()

  const isMusaned = job.workflow_id.startsWith('musaned')
  const isWafid = job.workflow_id.startsWith('wafid')
  const isVisa = job.workflow_id.startsWith('mofa')
  const isInsurance = job.workflow_id.startsWith('insurance')
  // The visa platform's sign-in captcha is a picture a person reads.
  page.__adalAllowImages = isMusaned || isWafid || isVisa || isInsurance
  console.log(
    `[worker] run #${runId} image policy: ` +
    (isMusaned || isWafid || isVisa || isInsurance
      ? `ALLOW (${job.workflow_id} — the captcha needs images)`
      : 'BLOCK (bandwidth saver)')
  )

  const notify = async (title, body, level = 'info', opts = {}) => {
    try {
      const [taskId] = await db('tasks').insert({
        type: 'automation', title, description: body || '',
        status: 'pending', profile_id: job.profile_id, assigned_to: 1,
        is_ai_created: true, created_at: new Date().toISOString(), payload: JSON.stringify({ run: runId }),
      })
      console.log(`[notify] ${level.toUpperCase()} ${title}`)
      // The phones hear it at once (live link), not at their next look.
      import('./liveChannel.js').then(L => L.broadcast({ t: 'ring', id: Number(taskId?.id ?? taskId) || 0, title, description: String(body || '').slice(0, 300), profile_id: job.profile_id, run: runId, at: Date.now() })).catch(() => {})
      if (onLog) await onLog(level, `🔔 ${title}`)
      // A sign-in, code or reCAPTCHA waits for a person: it stays in the bar
      // until the run goes on (its next "✓"). Paused runs show from the queue.
      if (opts.login || opts.confirm) needPerson(runId, title, body, { confirm: !!opts.confirm })
      beep()
    } catch (e) {
      console.error('[notify] failed:', e.message)
    }
  }

  let activeEmployee = null
  try { activeEmployee = await getActiveEmployee(db) } catch {}

  const ctx = {
    runId,
    profileId: job.profile_id,
    workflowId: job.workflow_id,
    profileName: profile.full_name || `Profile #${job.profile_id}`,
    profile,
    employeeName: activeEmployee?.name || '',
    activeEmployee,
    login_value:       savedCtx.login_value || '',
    login_password:    savedCtx.login_password || '',
    account_id:        savedCtx.account_id || job.account_id || null,
    musaned_username:  savedCtx.musaned_username || '',
    musaned_password:  savedCtx.musaned_password || '',
    musaned_name:      savedCtx.musaned_name || '',
    cv_template_id:    savedCtx.cv_template_id || null,
    visa_username:     savedCtx.visa_username || '',
    visa_password:     savedCtx.visa_password || '',
    visa_name:         savedCtx.visa_name || '',
    insurance_username: savedCtx.insurance_username || '',
    insurance_password: savedCtx.insurance_password || '',
    insurance_name:    savedCtx.insurance_name || '',
    musanedStage,
    labor_id:          profile.labor_id || '',
    destination_country: profile.destination_country || '',
    photoPath:    files.photoPath,
    passportPath: files.passportPath,
    passportImagePath: files.passportImagePath,
    fullBodyPath: files.fullBodyPath,
    slipPath:     files.slipPath,
    contractPath: files.contractPath,
    insurancePath: files.insurancePath,
    governmentIdPath: files.governmentIdPath,
    visaPath:     files.visaPath,
    onLog,
    notify,
    wafid: isWafid ? await wafidSettings(db) : null,
    visa: isVisa ? await visaSettings(db) : null,
    insurance: isInsurance ? await visaSettings(db) : null,
  }

  ctx.page = page
  ctx.db = db
  // A follow-up task for a person (no sound: notify rings).
  ctx.addTask = async (title, description = '') => {
    try {
      await db('tasks').insert({
        type: 'automation', title, description, status: 'pending', profile_id: job.profile_id,
        assigned_to: 1, is_ai_created: true, created_at: new Date().toISOString(),
      })
    } catch (e) { console.error('[worker] task failed:', e.message) }
  }
  ctx.isCancelled = () => isCancelled(runId)
  ctx.askCaptcha = (image, answer, opts) => {
    askCaptcha(runId, image, answer, opts)
    beep()
    // The phones look now: the question is answered from there too.
    import('./liveChannel.js').then(L => L.broadcast({ t: 'ring', id: Date.now(), title: opts?.title || 'Type the captcha', profile_id: job.profile_id, run: runId, at: Date.now() })).catch(() => {})
  }
  // A field the run cannot do without: asked in the notification, kept on the
  // profile, and the run goes on. Null when nobody answers in 30 minutes.
  ctx.askField = (column, title, choices) => new Promise((resolve) => {
    const giveUp = setTimeout(() => { doneWith(runId); resolve(null) }, 30 * 60_000)
    needPerson(runId, title)
    ctx.askCaptcha(null, async (text) => {
      clearTimeout(giveUp)
      await db('profiles').where('id', job.profile_id).update({ [column]: text, updated_at: new Date().toISOString() })
      ctx.profile = { ...ctx.profile, [column]: text }
      doneWith(runId)
      resolve(text)
    }, { title, choices, label: 'Answer' })
  })
  // A run writes what it found into the profile's notes (dated), and may set
  // a few profile fields with it.
  ctx.noteProfile = async (text, fields = {}) => {
    try {
      const row = await db('profiles').where('id', job.profile_id).first('notes')
      const line = `[${new Date().toISOString().slice(0, 10)}] ${text}`
      const notes = row?.notes ? `${row.notes}\n${line}` : line
      await db('profiles').where('id', job.profile_id).update({ ...fields, notes, updated_at: new Date().toISOString() })
    } catch (e) { console.error('[worker] note failed:', e.message) }
  }

  try { await noteLink(page) } catch {}
  try { await registerTab(runId, page) } catch {}

  try {
    await db('automation_queue').where('id', runId).update({
      status: 'running',
      started_at: new Date().toISOString(),
    })
    await onLog('info', page.__adalReused
      ? `▶ Run #${runId} took the free tab already open on ${hostOf(page.__adalReused)} (no other run uses it) and goes to its page`
      : `▶ Run #${runId} working in its own browser tab (no other run uses it)`)
    page.__adalReused = null

    const result = await runFullWorkflow(page, ctx)

    if (isCancelled(runId)) {
      await handleCancelled()
      return false
    }

    // The person finished the last step themselves and the run saw it.
    if (result.ok && result.done) {
      await db('automation_queue').where('id', runId).update({
        status: 'done',
        pause_reason: null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      console.log(`[worker] run #${runId} done`)
      return false
    }

    if (result.ok) {
      const pauseReason = result.pauseReason || 'awaiting-human-submit'
      await db('automation_queue').where('id', runId).update({
        status: 'paused',
        pause_reason: pauseReason,
        updated_at: new Date().toISOString(),
      })
      console.log(`[worker] run #${runId} paused: ${pauseReason}`)
      return true
    }

    // ---- Failure: retry vs permanent ----
    const errText = result.error || result.reason || ''
    await recordFailure(db, job, errText)
    return false
  } catch (e) {
    if (e?.cancelled || isCancelled(runId)) {
      await handleCancelled()
      return false
    }
    await recordFailure(db, job, e.message)
    return false
  }
}

/**
 * Claim → own tab → run. What happens to the tab afterwards depends on how
 * the run ended:
 *   paused (a person is needed)  → stays, still owned by the run
 *   waiting to retry             → stays, the retry continues in it
 *   failed                       → stays OPEN so the operator can see what
 *                                  LMIS/Musaned showed, but is released
 *   cancelled                    → closed
 * Never throws: whatever happens is written to the run's row.
 */
async function runJob(db, job) {
  try {
    // A run the scanner queued (nobody pressed a button now):
    // never opens Brave itself. While Brave is closed it waits, and it goes
    // on once Brave is open again. Brave that a person closed (or quit Adal
    // Keep) stays closed.
    const nobodyAsked = /^(Retry |Waiting for Adal Browser)/.test(job.pause_reason || '') || /Auto-discovered by scanner/.test(String(job.log || ''))
    if (nobodyAsked && !(await openBrowserIfAny())) {
      const at = new Date(Date.now() + 2 * 60000).toISOString()
      await db('automation_queue').where('id', job.id).update({
        status: 'pending',
        pause_reason: 'Waiting for Adal Browser to be open',
        updated_at: at,
      })
      return
    }
    const browser = await getBrowser()
    // After a server restart the run finds the tab it worked in again.
    await findRunTab(browser, job.id, job.workflow_id, { bySite: false }).catch(() => null)
    // Otherwise a free tab already on the site (signed in), else a new one.
    const page = await openRunTab(browser, job.id, { workflowId: job.workflow_id, busyRuns: await activeRunIds(db) })
    await executeRun(db, page, job)
  } catch (e) {
    // Could not start at all: no browser, profile deleted, ...
    console.error(`[worker] run #${job.id} could not start: ${e.message}`)
    try { await recordFailure(db, job, e.message) } catch {}
  } finally {
    const row = await db('automation_queue').where('id', job.id).first().catch(() => null)
    try {
      // Done, failed or cancelled: the tab stays open for the person.
      doneWith(job.id, { keepCaptcha: row?.status === 'paused' })
      if (['cancelled', 'failed', 'done'].includes(row?.status)) forgetRunTab(job.id)
      // paused / pending (retry): the tab stays with the run; while a
      // person works in it, file dialogs open normally again.
      else { const t = tabOfRun(job.id); if (t) handTabToPerson(t) }
    } catch {}
    try { await unregisterTab(job.id) } catch {}
    clearCancelled(job.id)
  }
}

// --------------------------------------------------------------------------
// Run queue — which waiting run starts next
// --------------------------------------------------------------------------
/**
 * Pending runs that may start now. A retry is only handed out after its
 * backoff deadline (stored in `updated_at` by recordFailure). Without this
 * check, retries fired on the very next poll and the browser looked like it
 * was reloading mid-workflow.
 */
export function readyJobsQuery(db) {
  const now = new Date().toISOString()
  return db('automation_queue')
    .where('status', 'pending')
    .where(function () {
      // Non-retry jobs → always ready.
      this.where(function () {
        this.whereNull('pause_reason')
          .orWhere('pause_reason', 'not like', 'Retry %')
      })
      // Retry jobs → ready only after the backoff window has elapsed.
      .orWhere(function () {
        this.where('pause_reason', 'like', 'Retry %')
          .andWhere('updated_at', '<=', now)
      })
    })
}

/** Claim the oldest ready run, skipping runs this process is still finishing. */
export async function claimNextJob(db, exclude = []) {
  if (isAppLocked()) return null // trial over and not unlocked: no runs start
  for (let i = 0; i < 5; i++) {
    const q = readyJobsQuery(db)
    if (exclude.length) q.whereNotIn('id', exclude)
    const row = await q.orderBy('id', 'asc').first()
    if (!row) return null
    const now = new Date().toISOString()
    const updated = await db('automation_queue')
      .where('id', row.id)
      .andWhere('status', 'pending')
      .update({ status: 'running', started_at: now, updated_at: now })
    if (updated === 1) return { ...row, status: 'running' }
  }
  return null
}

let _runs = null
function runs(db) {
  if (!_runs) {
    _runs = createRunQueue({
      max: MAX_RUNS,
      claimNext: (exclude) => claimNextJob(db, exclude),
      runJob: (job) => runJob(db, job),
    })
    reportRuns(() => _runs.snapshot().running.length)
  }
  return _runs
}

/** Start as many waiting runs as there are free slots. */
export function drainQueue(db) {
  return runs(db).drain()
}

/** The runs working right now, and how many may work at once. */
export function queueSnapshot() {
  return _runs ? _runs.snapshot() : { max: MAX_RUNS, running: [] }
}

/** Where a run stands: working now, or how many runs wait ahead of it. */
export async function runStatus(db, runId) {
  const snap = queueSnapshot()
  const base = { running: snap.running.length, max: snap.max }
  if (_runs && _runs.isRunning(runId)) return { state: 'running', ahead: 0, ...base }
  const r = await readyJobsQuery(db).where('id', '<', Number(runId)).count({ c: '*' }).first()
  return { state: 'queued', ahead: Number(r?.c || 0), ...base }
}

/** Start a run now if a slot is free, then report where it stands. */
export async function dispatchRun(db, runId) {
  await drainQueue(db)
  return runStatus(db, runId)
}

/**
 * A run that was working when the server stopped goes on by itself, out of
 * sight: nothing it does is final, since Save stays a person's. One from long
 * ago is parked: nobody expects it now.
 */
async function parkInterruptedRuns(db) {
  try {
    const recent = new Date(Date.now() - 6 * 3600_000).toISOString()
    const back = await db('automation_queue').where('status', 'running').where('updated_at', '>', recent)
      .update({ status: 'pending', updated_at: new Date().toISOString() })
    if (back) console.log(`[worker] ${back} run(s) interrupted by a restart — going on`)
    const n = await db('automation_queue').where('status', 'running').update({
      status: 'paused',
      pause_reason: 'Interrupted: the server restarted while this run was working. Press Continue to run it again.',
      updated_at: new Date().toISOString(),
    })
    if (n) console.log(`[worker] ${n} run(s) interrupted by a restart — parked as paused`)
  } catch (e) {
    console.error('[worker] could not park interrupted runs:', e.message)
  }
}

// --------------------------------------------------------------------------
// Agency manager loop
// --------------------------------------------------------------------------
/** Is a pending task of this type already open for the profile? */
async function openTaskExists(db, type, profileId) {
  const row = await db('tasks').where({ type, profile_id: profileId, status: 'pending' }).first().catch(() => null)
  return !!row
}

export async function runAgencyManager(db) {
  if (isAppLocked()) return
  if (_agencyRunning) {
    console.log('[agency] previous run still in flight — skipping')
    return
  }
  _agencyRunning = true
  const t0 = Date.now()

  try {
    const profiles = await db('profiles')
      .select('profiles.*')
      .limit(AGENCY_PROFILE_LIMIT)

    for (const p of profiles) {
      const files = await db('files')
        .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
        .where('profile_fields.profile_id', p.id)
        .select('profile_fields.name as name')
      p.files_present = files.map(f => f.name)
      // JEV's rule "police only when there was no prior run" needs this.
      const lastPolice = await db('automation_queue')
        .where({ profile_id: p.id, workflow_id: 'police_certificate' })
        .orderBy('id', 'desc').first()
      p.last_status = lastPolice ? lastPolice.status : 'never'
    }

    if (profiles.length === 0) {
      console.log('[agency] no profiles to evaluate')
      return
    }

    const { decisions } = await decideAgencyActions(profiles)
    if (!Array.isArray(decisions)) {
      console.warn('[agency] decideAgencyActions returned no decisions array')
      return
    }

    let queued = 0, skipped = 0, tasks = 0

    for (const d of decisions) {
      if (!d || !d.next_action || d.next_action === 'wait') { skipped++; continue }

      switch (d.next_action) {
        case 'make_cv': {
          // The manager runs every 30 min: never pile up the same open task.
          if (await openTaskExists(db, 'cv', d.profileId)) { skipped++; break }
          await db('tasks').insert({
            type: 'cv',
            title: `Generate CV for profile #${d.profileId}`,
            description: d.reason || '',
            status: 'pending',
            profile_id: d.profileId,
            assigned_to: 1,
            payload: JSON.stringify({ source: 'agency_manager', decision: d }),
            is_ai_created: true,
            created_at: new Date().toISOString(),
          })
          tasks++
          break
        }

        case 'submit_police_certificate': {
          // Never a second police run: one already queued/running/waiting/done,
          // or one that failed in the last 12 hours (same rule as autoTrigger).
          const existing = await db('automation_queue')
            .where({ profile_id: d.profileId, workflow_id: 'police_certificate' })
            .where(function () {
              this.whereIn('status', ['pending', 'running', 'paused', 'done'])
                .orWhere(function () {
                  this.where('status', 'failed')
                    .andWhere('updated_at', '>', new Date(Date.now() - 12 * 3600 * 1000).toISOString())
                })
            })
            .first()
          if (existing) { skipped++; break }
          const gate = await assertPoliceReady(d.profileId, { handle: db })
          if (!gate.ok) {
            console.log(
              `[agency] skip police_certificate for profile ${d.profileId}: ${gate.blockers.join('; ')}`
            )
            skipped++
            break
          }
          await db('automation_queue').insert({
            profile_id: d.profileId,
            workflow_id: 'police_certificate',
            status: 'pending',
            current_step: 0,
            context: JSON.stringify({}),
            log: JSON.stringify([{ ts: Date.now(), level: 'info', msg: `queued by agency_manager: ${d.reason || ''}` }]),
            pause_reason: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          queued++
          break
        }

        case 'send_message': {
          if (await openTaskExists(db, 'message', d.profileId)) { skipped++; break }
          await db('tasks').insert({
            type: 'message',
            title: d.title || `Message for profile #${d.profileId}`,
            description: d.message || d.reason || '',
            status: 'pending',
            profile_id: d.profileId,
            assigned_to: 1,
            payload: JSON.stringify({ channel: d.channel || 'whatsapp', source: 'agency_manager', decision: d }),
            is_ai_created: true,
            created_at: new Date().toISOString(),
          })
          tasks++
          break
        }

        default: {
          console.warn(`[agency] unknown next_action "${d.next_action}" for profile #${d.profileId} — skipping`)
          skipped++
        }
      }
    }

    const secs = Math.round((Date.now() - t0) / 1000)
    console.log(
      `[agency] evaluated ${profiles.length} profiles in ${secs}s — ` +
      `${queued} automation job(s), ${tasks} task(s), ${skipped} skipped`
    )
  } catch (e) {
    console.error('[agency] manager failed:', e.message)
  } finally {
    _agencyRunning = false
  }
}

/** A person pressed Save in the live view and Musaned said SAVED: Musaned is done. */
export async function closeSavedRuns(db) {
  const rows = await db('automation_queue').where({ status: 'paused', workflow_id: 'musaned_add_candidate', pause_reason: 'awaiting-human-save' })
    .where('updated_at', '>', new Date(Date.now() - 48 * 3600_000).toISOString()).select('id', 'profile_id', 'workflow_id', 'log')
  if (!rows.length) return
  const browser = await openBrowserIfAny()
  if (!browser) return
  const { savedOnPage } = await import('./musanedWorkflow.js')
  for (const r of rows) {
    const page = await findRunTab(browser, r.id, r.workflow_id)
    if (!page || !(await savedOnPage(page))) continue
    const now = new Date().toISOString()
    let log = []
    try { log = JSON.parse(r.log || '[]') } catch {}
    log.push({ ts: Date.now(), level: 'info', msg: '✅ Musaned said SAVED — done' })
    await db('automation_queue').where('id', r.id).where('status', 'paused').update({ status: 'done', pause_reason: null, finished_at: now, updated_at: now, log: JSON.stringify(log) })
    doneWith(r.id, { force: true })
    forgetRunTab(r.id)
    console.log(`[worker] run #${r.id}: Musaned said SAVED — done`)
  }
}

/** A run paused at Musaned's sign-in goes on by itself once its tab is signed in. */
async function hasAuthenticator(run) {
  let saved = {}
  try { saved = JSON.parse(run.context || '{}') } catch {}
  return !!(await import('./musanedTotp.js')).authenticatorInfo(saved.account_id || run.account_id)
}

async function continueSignedIn(db) {
  const rows = await db('automation_queue').where('status', 'paused')
    .whereIn('pause_reason', ['awaiting-musaned-login', 'awaiting-musaned-otp', 'awaiting-musaned-captcha'])
    .where('updated_at', '>', new Date(Date.now() - 12 * 3600_000).toISOString()).select('id', 'workflow_id', 'account_id', 'context')
  if (!rows.length) return
  const browser = await openBrowserIfAny()
  if (!browser) return
  for (const r of rows) {
    const page = await findRunTab(browser, r.id, r.workflow_id)
    if (!page) continue
    // A person pressed Sign in on a waiting run: its code box is up and Adal Keep has the code.
    if (hostOf(page.url()) !== 'tawtheeq.musaned.com.sa' && !(await codeBoxUp(page) && await hasAuthenticator(r))) continue
    await db('automation_queue').where('id', r.id).where('status', 'paused').update({ status: 'pending', updated_at: new Date().toISOString() })
    console.log(`[worker] run #${r.id} is signed in — going on`)
    drainQueue(db).catch(() => {})
  }
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------
export function startWorker(db) {
  if (_interval) return

  console.log(
    `[worker] polling every ${POLL_MS}ms — one run at a time, in its own tab`
  )
  parkInterruptedRuns(db).finally(() => drainQueue(db))
  // The poll only matters for retries whose backoff has run out and for runs
  // queued by the scanner: a click or a finished run starts the next one at once.
  _interval = setInterval(() => {
    drainQueue(db).catch(e => console.error('[worker] poll error:', e))
  }, POLL_MS)
  setInterval(() => continueSignedIn(db).catch(e => console.warn('[worker] sign-in look:', e.message)), 15000).unref?.()
  setInterval(() => closeSavedRuns(db).catch(e => console.warn('[worker] saved look:', e.message)), 3000).unref?.()

  console.log(`[worker] agency manager every ${AGENCY_INTERVAL_MS / 60000}min`)
  _agencyTimer = setInterval(() => {
    runAgencyManager(db).catch(e => console.error('[agency]', e))
  }, AGENCY_INTERVAL_MS)

  setTimeout(() => {
    runAgencyManager(db).catch(e => console.error('[agency]', e))
  }, 10_000)
}

export function stopWorker() {
  if (_interval)    clearInterval(_interval)
  if (_agencyTimer) clearInterval(_agencyTimer)
  _interval    = null
  _agencyTimer = null
}
