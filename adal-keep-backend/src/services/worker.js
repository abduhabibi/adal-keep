/**
 * worker.js — runs queued automation jobs, each in its own browser tab.
 *
 * v10 — no agent pool. Every run gets its own tab (tabManager.openRunTab) and
 *       only ever touches that tab, so two runs at once never share a tab or
 *       steer each other's. Up to AUTOMATION_MAX_RUNS (default 3) work at the
 *       same time; the rest wait in line and start by themselves, oldest
 *       first, when a slot frees (runQueue.js).
 *
 * v9 — real backoff. A retry's deadline is stored in `updated_at` (a future
 *      ISO timestamp) and readyJobsQuery refuses retry-* jobs until that
 *      deadline passes. BASE is env-configurable and defaults to 2 min.
 *      Permanent errors (LMIS "not in pool" and the like) are not retried.
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { getBrowser } from './browser.js'
import { runFullWorkflow } from './lmisWorkflow.js'
import { decideAgencyActions } from './jev/agencyManager.js'
import { getActiveEmployee } from './activeEmployee.js'
import { isAppLocked } from './subscription.js'
import { openRunTab, forgetRunTab, tabOfRun, handTabToPerson } from './tabManager.js'
import { registerTab, unregisterTab, noteLink } from './bandwidth.js'
import { createRunQueue } from './runQueue.js'
import { reportRuns } from './busy.js'
import { isCancelled, clearCancelled } from './cancellation.js'
import { assertPoliceReady } from './verification.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')

// How many runs may work at the same time, each in its own tab.
const MAX_RUNS           = Math.max(1, Number(process.env.AUTOMATION_MAX_RUNS || 4))
const POLL_MS            = 5000
const MAX_ATTEMPTS       = 3
// Retry backoff: attempt 1 waits this long, attempt 2 waits 4× this.
// Minimum 2 minutes per the operator's request; override with RETRY_BACKOFF_MS.
const BACKOFF_BASE_MS    = Number(process.env.RETRY_BACKOFF_MS || 120000)
const AGENCY_INTERVAL_MS = 30 * 60 * 1000   // 30 min
const AGENCY_PROFILE_LIMIT = Number(process.env.AGENCY_PROFILE_LIMIT || 200)

// Errors retrying can never fix. Add LMIS/companion-specific permanent
// reasons here so they don't burn attempts on a 2-minute loop.
const PERMANENT_ERROR =
  /refused the login|not found|Not Found|not in the|placed pool|different labor|could not be verified|already_in_other_agency|already attached|already exists|Profile is missing|LMIS portal error|LMIS blocks|Musaned not started|No visa platform account|No insurance account|Nobody signed in/i

let _interval      = null
let _agencyTimer   = null
let _agencyRunning = false

// --------------------------------------------------------------------------
// Notifications
// --------------------------------------------------------------------------
// Each kind of run rings with its own sound, so a person hears which task
// calls them without looking (Windows: C:\Windows\Media, then beeps).
const SOUNDS = {
  // linux: [file, times] — loud enough to hear across the room (short ones repeat).
  police:  { win: 'chimes.wav',  beeps: [[880, 180], [660, 180]],                         linux: ['complete', 1],               mac: 'Glass' },
  musaned: { win: 'notify.wav',  beeps: [[660, 150], [880, 150], [1100, 200]],           linux: ['message', 2],                mac: 'Ping' },
  lmis:    { win: 'tada.wav',    beeps: [[523, 160], [523, 160], [784, 300]],            linux: ['bell', 3],                   mac: 'Hero' },
  wafid:   { win: 'Ring02.wav',  beeps: [[1000, 120], [0, 80], [1000, 120]],             linux: ['phone-incoming-call', 1],    mac: 'Submarine' },
  insurance: { win: 'Ring05.wav', beeps: [[440, 250], [554, 250], [659, 400]],          linux: ['service-login', 1],          mac: 'Blow' },
  tasheer: { win: 'Ring06.wav',  beeps: [[1200, 90], [900, 90], [1200, 90], [900, 90]], linux: ['phone-outgoing-calling', 1], mac: 'Pop' },
  visa:    { win: 'Alarm02.wav', beeps: [[784, 140], [988, 140], [1175, 140], [1568, 320]], linux: ['alarm-clock-elapsed', 1], mac: 'Funk' },
}

/** Which sound a workflow rings with. */
export function soundKind(workflowId = '') {
  const w = String(workflowId)
  if (w.startsWith('mofa') || w.startsWith('visa')) return 'visa'
  if (w.startsWith('insurance')) return 'insurance'
  if (w.startsWith('tasheer')) return 'tasheer'
  if (w.startsWith('wafid')) return 'wafid'
  if (w.startsWith('musaned')) return 'musaned'
  if (w === 'lmis_contract') return 'lmis'
  return 'police'
}

const _lastSound = {}
export function playNotificationSound(workflowId = '') {
  const kind = soundKind(workflowId)
  const s = SOUNDS[kind]
  // Several notices of one kind at the same moment ring once.
  if (Date.now() - (_lastSound[kind] || 0) < 10000) return
  _lastSound[kind] = Date.now()
  try {
    const platform = process.platform
    let cmd, args
    if (platform === 'darwin') {
      cmd = 'afplay'
      args = [`/System/Library/Sounds/${s.mac}.aiff`]
    } else if (platform === 'win32') {
      const beeps = s.beeps.map(([f, ms]) => f ? `[console]::beep(${f},${ms})` : `Start-Sleep -Milliseconds ${ms}`).join('; ')
      const wav = `$env:WINDIR\\Media\\${s.win}`
      cmd = 'powershell'
      args = ['-NoProfile', '-Command', `$f="${wav}"; if (Test-Path $f) { (New-Object Media.SoundPlayer $f).PlaySync() } else { ${beeps} }`]
    } else {
      const [file, times] = s.linux
      const one = `paplay /usr/share/sounds/freedesktop/stereo/${file}.oga`
      cmd = 'sh'
      args = ['-c', Array(times).fill(one).join('; ')]
    }
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
/** Put a failed attempt back in line after a backoff, or fail it for good. */
async function recordFailure(db, job, errText, retryable) {
  const attempt = (job.current_step || 0) + 1
  if (retryable && attempt < MAX_ATTEMPTS) {
    const delayMs = BACKOFF_BASE_MS * Math.pow(4, attempt - 1)
    const retryAt = new Date(Date.now() + delayMs).toISOString()
    // NOTE: `updated_at` is deliberately set to a FUTURE timestamp. This is
    // what readyJobsQuery reads to know the backoff window hasn't elapsed.
    await db('automation_queue').where('id', job.id).update({
      status: 'pending',
      current_step: attempt,
      pause_reason: `Retry ${attempt}/${MAX_ATTEMPTS} at ${retryAt} — ${errText}`,
      updated_at: retryAt,
    })
    console.log(`[worker] run #${job.id} retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(delayMs / 60000)}min`)
  } else {
    await db('automation_queue').where('id', job.id).update({
      status: 'failed',
      pause_reason: `${errText} (after ${attempt} attempts)`,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    console.log(`[worker] run #${job.id} FAILED permanently`)
  }
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
  const onLog = (level, msg) => { const ts = Date.now(); return (logChain = logChain.then(() => writeLog(level, msg, ts)).catch(() => {})) }
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

  const notify = async (title, body, level = 'info') => {
    try {
      await db('tasks').insert({
        type: 'automation', title, description: body || '',
        status: 'pending', profile_id: job.profile_id, assigned_to: 1,
        is_ai_created: true, created_at: new Date().toISOString(),
      })
      console.log(`[notify] ${level.toUpperCase()} ${title}`)
      if (onLog) await onLog(level, `🔔 ${title}`)
      playNotificationSound(job.workflow_id)
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
    musaned_username:  savedCtx.musaned_username || '',
    musaned_password:  savedCtx.musaned_password || '',
    musaned_name:      savedCtx.musaned_name || '',
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
    await onLog('info', `▶ Run #${runId} working in its own browser tab (no other run uses it)`)

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
    await recordFailure(db, job, errText, !PERMANENT_ERROR.test(errText))
    return false
  } catch (e) {
    if (e?.cancelled || isCancelled(runId)) {
      await handleCancelled()
      return false
    }
    await recordFailure(db, job, e.message, true)
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
    const browser = await getBrowser()
    const page = await openRunTab(browser, job.id)
    await executeRun(db, page, job)
  } catch (e) {
    // Could not start at all: no browser, profile deleted, ...
    console.error(`[worker] run #${job.id} could not start: ${e.message}`)
    try { await recordFailure(db, job, e.message, !PERMANENT_ERROR.test(e.message)) } catch {}
  } finally {
    const row = await db('automation_queue').where('id', job.id).first().catch(() => null)
    try {
      // Done, failed or cancelled: the tab stays open for the person.
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
 * A run that was working when the server stopped has no browser tab any more.
 * Park it as paused so running it again is a deliberate click: a restart
 * never re-opens a government form on its own.
 */
async function parkInterruptedRuns(db) {
  try {
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

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------
export function startWorker(db) {
  if (_interval) return

  console.log(
    `[worker] polling every ${POLL_MS}ms — up to ${MAX_RUNS} runs at once, each in its own tab — ` +
    `backoff base ${BACKOFF_BASE_MS / 1000}s`
  )
  parkInterruptedRuns(db).finally(() => drainQueue(db))
  // The poll only matters for retries whose backoff has run out and for runs
  // queued by the scanner: a click or a finished run starts the next one at once.
  _interval = setInterval(() => {
    drainQueue(db).catch(e => console.error('[worker] poll error:', e))
  }, POLL_MS)

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
