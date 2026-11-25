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

import { robotsInApp, IN_LINE } from './robotsInApp.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { getBrowser, openBrowserIfAny } from './browser.js'
import { needPerson, askCaptcha, doneWith, waiting, isWaiting, onWait, onTaskExpired, keepWhile, forgetRun } from './attention.js'
import { runFullWorkflow } from './lmisWorkflow.js'
import { decideAgencyActions } from './jev/agencyManager.js'
import { getActiveEmployee } from './activeEmployee.js'
import { isAppLocked } from './subscription.js'
import { towerHeld } from './tower.js'
import { plainReason, workflowName, withInternetCheck } from './runOutcome.js'
import { openRunTab, forgetRunTab, tabOfRun, handTabToPerson, findRunTab, activeRunIds, keepingRunIds, tidySiteTabs, hostOf, codeBoxUp, spaceForRun, peerOf, tabAnswers } from './tabManager.js'
import { registerTab, unregisterTab, noteLink } from './bandwidth.js'
import { createRunQueue } from './runQueue.js'
import { reportRuns } from './busy.js'
import { isCancelled, clearCancelled, markCancelled } from './cancellation.js'
import { assertPoliceReady } from './verification.js'
import { startRunClock, LIMIT_NOTE, RUN_LIMIT_MS } from './runLimit.js'
import { begin as beginHistory, finishRun as finishHistory, prune as pruneHistory, closeStale as closeStaleHistory } from './runHistory.js'

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
  if (Date.now() - _lastBeep < 3000 || process.env.ADAL_NO_SOUND === '1') return     // several calls at once: one beep
  _lastBeep = Date.now()
  try {
    let cmd, args
    // Windows' own soft notification sound; the plain beep only where it is missing.
    if (process.platform === 'win32') { cmd = 'powershell'; args = ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', "$f=\"$env:WINDIR\\Media\\Windows Notify System Generic.wav\"; if (Test-Path $f) { (New-Object Media.SoundPlayer $f).PlaySync() } else { [console]::beep(880,120) }"] }
    else if (process.platform === 'darwin') { cmd = 'afplay'; args = ['/System/Library/Sounds/Tink.aiff'] }
    else { cmd = 'paplay'; args = ['/usr/share/sounds/freedesktop/stereo/message.oga'] }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

/** One gentle sound per run, not per step (asked on 2026-11-21): its next human steps are quiet tasks. */
const _beeped = new Set()
export function beepFor(runId) {
  const id = Number(runId)
  if (_beeped.has(id)) return false
  _beeped.add(id)
  beep()
  return true
}
export const _forgetBeep = (runId) => _beeped.delete(Number(runId))

// A human step nobody answered in 10 minutes (attention.js): the run stops
// before its next step — nothing half-sent — and waits, paused, for a person
// to press Continue. Its tab stays as it is.
const _expired = new Set()
export const pausedForNoAnswer = (runId) => _expired.has(Number(runId))
export const NO_ANSWER = 'No answer for 10 minutes: paused before anything was sent. Press Continue when someone is there.'
let _expiryHooked = false
function hookTaskExpiry(db) {
  if (_expiryHooked) return
  _expiryHooked = true
  // A person is at its tab now (the live view, a click): the call stays, never paused under their hand.
  keepWhile((id) => { const p = tabOfRun(id); return !!p && Date.now() - Math.max(p.__adalLookedAt || 0, p.__adalInputAt || 0) < 60000 })
  onTaskExpired(async (runId, task) => {
    const row = await db('automation_queue').where('id', runId).first('status').catch(() => null)
    if (row?.status !== 'running') return          // paused already: only its task goes
    _expired.add(Number(runId))
    markCancelled(runId)
    console.log(`[worker] run #${runId}: "${task?.title}" had no answer for 10 minutes — pausing`)
  })
}

export const _hookTaskExpiryForTest = (db) => { _expiryHooked = false; hookTaskExpiry(db) }

// --------------------------------------------------------------------------
// File resolution
// --------------------------------------------------------------------------
async function resolveFilePaths(db, profileId) {
  // The newest file of that field that is really on disk. Files are kept as a
  // path under the program, in SafeStorage, or (moved in from another system,
  // attached by a run) with their full address — storedFilePath knows them all.
  const { storedFilePath } = await import('./musanedPreflight.js')
  const pick = async (fieldName, only) => {
    const q = db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.name', fieldName)
    if (only) q.where(only)
    const rows = await q.select('files.path').orderBy('files.id', 'desc').limit(20)
    for (const r of rows) { const abs = r.path && storedFilePath(r.path); if (abs) return abs }
    return null
  }
  const get = (fieldName) => pick(fieldName)
  const getPassportImage = () => pick('Passport', function () {
    this.where('files.mimetype', 'like', 'image/%')
      .orWhere('files.path', 'like', '%.jpg')
      .orWhere('files.path', 'like', '%.jpeg')
      .orWhere('files.path', 'like', '%.png')
      .orWhere('files.path', 'like', '%.webp')
  })
  // The LMIS passport field takes a PDF. Use the newest passport PDF; fall back to
  // the newest passport file when the profile has no PDF (the job makes one).
  const getPassportPdf = () => pick('Passport', function () {
    this.where('files.mimetype', 'application/pdf').orWhere('files.path', 'like', '%.pdf')
  })

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
  if (['insurance_certificate', 'tasheer_schedule'].includes(job.workflow_id)) await import('./insuranceCertificate.js').then(m => m.settleMembers(db, job.id, 'failed', `the shared certificate (run #${job.id}) failed`)).catch(() => {})
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
    // Stopped because a human step had no answer for 10 minutes: paused, not cancelled.
    if (_expired.delete(Number(runId))) {
      try {
        await db('automation_queue').where('id', runId).update({ status: 'paused', pause_reason: NO_ANSWER, updated_at: new Date().toISOString() })
        await onLog('warn', `⏸ ${NO_ANSWER}`)
      } catch {}
      return true
    }
    try {
      await db('automation_queue').where('id', runId).update({
        status: 'cancelled',
        pause_reason: _limited.has(runId) ? LIMIT_NOTE : 'Cancelled by user',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await onLog('warn', _limited.has(runId) ? `⛔ ${LIMIT_NOTE[0].toUpperCase()}${LIMIT_NOTE.slice(1)} — run stopped` : '⛔ Cancelled by user — run stopped')
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
  const isTasheer = job.workflow_id.startsWith('tasheer')
  // The visa platform's, insurance's and Tasheer's sign-in captcha is a picture on their own site: pictures on.
  // Musaned and Wafid have Google's reCAPTCHA, whose pictures always come (tabManager: Google's captcha hosts);
  // their own pages' pictures stay off — on a slow line they were most of each page (2026-11-24). Steps that
  // need a picture (a contract PDF, Wafid's slip) switch them on themselves.
  void isMusaned; void isWafid
  page.__adalAllowImages = isVisa || isInsurance || isTasheer
  console.log(
    `[worker] run #${runId} image policy: ` +
    (page.__adalAllowImages
      ? `ALLOW (${job.workflow_id} — its captcha is a picture)`
      : isMusaned || isWafid ? "BLOCK except Google's reCAPTCHA (bandwidth saver)" : 'BLOCK (bandwidth saver)')
  )

  const notify = async (title, body, level = 'info', opts = {}) => {
    try {
      // A human step (sign-in, code, captcha, Save) is a task of the run (attention.js),
      // gone when answered or after 10 minutes: no lasting notice for it.
      const human = !!(opts.login || opts.confirm)
      const [taskId] = human ? [Date.now()] : await db('tasks').insert({
        type: 'automation', title, description: body || '',
        status: 'pending', profile_id: job.profile_id, assigned_to: 1,
        is_ai_created: true, created_at: new Date().toISOString(), payload: JSON.stringify({ run: runId }),
      })
      console.log(`[notify] ${level.toUpperCase()} ${title}`)
      // The phones hear it at once (live link), not at their next look —
      // except an Enjaz captcha: that goes to the phones only after 30 s on the PC (askCaptcha).
      if (!(opts.login && /^mofa/.test(String(job.workflow_id || '')))) import('./liveChannel.js').then(L => L.broadcast({ t: 'ring', id: Number(taskId?.id ?? taskId) || 0, title, description: String(body || '').slice(0, 300), profile_id: job.profile_id, run: runId, at: Date.now() })).catch(() => {})
      if (onLog) await onLog(level, `🔔 ${title}`)
      // A sign-in, code or reCAPTCHA waits for a person: it stays in the bar
      // until the run goes on (its next "✓"). Paused runs show from the queue.
      const raised = opts.login ? await import('./browser.js').then(b => b.raiseForPerson(opts.login?.target ? opts.login : page)) : false
      if (human) needPerson(runId, title, raised ? `In the Adal Robots window on this PC. ${body || ''}` : body, { confirm: !!opts.confirm })
      beepFor(runId)
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
    account_name:      savedCtx.account_name || '',   // (an LMIS code from the phone names its account)
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
    tasheer_username:  savedCtx.tasheer_username || '',
    tasheer_password:  savedCtx.tasheer_password || '',
    tasheer_name:      savedCtx.tasheer_name || '',
    tasheer: isTasheer ? await import('./tasheer.js').then(m => m.tasheerSettings(db)) : null,
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
    // Make insurance for several: everyone on one certificate (this profile first).
    group: (isInsurance || isTasheer) && Array.isArray(savedCtx.group_ids) && savedCtx.group_ids.length > 1
      ? (await db('profiles').whereIn('id', savedCtx.group_ids)).sort((a, b) => savedCtx.group_ids.indexOf(a.id) - savedCtx.group_ids.indexOf(b.id))
      : null,
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
  // Enjaz (the visa platform): the captcha goes to this PC first (a Windows
  // notification with its picture); nobody in 30 s → to the phones. Nobody in
  // 10 minutes → its task goes and the run is paused (attention.js, hookTaskExpiry).
  const enjaz = /^mofa/.test(String(job.workflow_id || ''))
  const ringPhones = (opts) => import('./liveChannel.js').then(L => L.broadcast({ t: 'ring', id: Date.now(), title: opts?.title || 'Type the captcha', profile_id: job.profile_id, run: runId, at: Date.now() })).catch(() => {})
  const stillAsked = () => waiting().some(w => w.run_id === Number(runId) && w.asks)
  ctx.askCaptcha = (image, answer, opts) => {
    askCaptcha(runId, image, answer, enjaz ? { ...opts, phoneAfterMs: 30_000 } : opts)
    const first = beepFor(runId)
    if (!enjaz) { if (first) ringPhones(opts); return }
    clearTimeout(ctx._toPhones)
    ctx._toPhones = setTimeout(() => {
      if (!stillAsked()) return
      console.log(`[worker] run #${runId}: the captcha was not typed on the PC in 30 s — to the phones`)
      ringPhones(opts)
    }, 30_000)
  }
  // A code asked by notification and not answered in time (Tasheer, 10 minutes):
  // the call goes from the bar and the phones, and its task is closed.
  ctx.forgetCaptcha = () => {
    doneWith(runId, { force: true })
    db('tasks').where({ status: 'pending', payload: JSON.stringify({ run: runId }) }).where('title', 'like', '%code%')
      .update({ status: 'done', updated_at: new Date().toISOString() }).catch(() => {})
  }
  // A field the run cannot do without: asked as a task, kept on the profile,
  // and the run goes on. No answer in 10 minutes: the run is paused (it stops here).
  ctx.askField = (column, title, choices) => new Promise((resolve, reject) => {
    const watch = setInterval(() => { if (isCancelled(runId)) { clearInterval(watch); reject(Object.assign(new Error('Stopped'), { cancelled: true })) } }, 1000)
    watch.unref?.()
    needPerson(runId, title)
    ctx.askCaptcha(null, async (text) => {
      clearInterval(watch)
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

    // Stopped at 10 minutes meanwhile: its end is written already and stays (a late answer never puts it back).
    if (_limited.has(runId)) return false
    if (isCancelled(runId)) {
      await handleCancelled()
      return false
    }
    // The PC it worked on went away: it ends here, said plainly (one try; nothing is sent again by itself).
    const went = !(result.ok && result.done) && await pcGone(db, job)
    if (went) { await recordFailure(db, job, went); return false }

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
    if (_limited.has(runId)) return false
    if (e?.cancelled || isCancelled(runId)) {
      await handleCancelled()
      return false
    }
    await recordFailure(db, job, (await pcGone(db, job)) || e.message)
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
/** A run nobody pressed goes to a free, strong Companion (its context says so from now on). */
// Robots run on the PC itself, never handed to another PC over the office network (the owner,
// 2026-11-24; by themselves since 2026-11-25: selfAssign.js). ADAL_LAN_ROBOTS=0 is the emergency off switch.
const LAN_ROBOTS = process.env.ADAL_LAN_ROBOTS !== '0'

async function sendToFreeCompanion(db, job) {
  try {
    const rb = await import('./remoteBrowsers.js')
    const busy = new Set()
    for (const r of await db('automation_queue').where('status', 'running').whereNot('id', job.id).select('context')) {
      try { const d = JSON.parse(r.context || '{}').on_device; if (d) busy.add(d) } catch {}
    }
    const dev = rb.freeStrongDevice(busy, Date.now(), (await import('./officeHealth.js')).ownVersion())
    if (!dev) return
    let ctx = {}
    try { ctx = JSON.parse(job.context || '{}') } catch {}
    ctx.on_device = dev
    job.context = JSON.stringify(ctx)
    const { seal } = await import('./accountVault.js')
    await db('automation_queue').where('id', job.id).update({ context: seal(job.context) })
    console.log(`[worker] run #${job.id}: this PC's browser is closed — a free Companion does it`)
  } catch (e) { console.warn('[worker] no Companion for it:', e.message) }
}

/** A run another PC does for the one it came from (sharePower.js): out of sight there. */
function helpedRun(job) {
  try { return !!JSON.parse(job.context || '{}').quiet } catch { return false }
}

/** The Adal Companion this run was started on (its robot works there), or ''. */
function onDevice(job) {
  try { return String(JSON.parse(job.context || '{}').on_device || '') } catch { return '' }
}

/**
 * The browser this run works in: the Companion's it was started on when that
 * PC is on the office network (services/remoteBrowsers.js), else this PC's.
 */
async function browserForJob(db, job, { quiet = false } = {}) {
  const dev = onDevice(job)
  if (dev) {
    const rb = await import('./remoteBrowsers.js')
    const sp = await import('./sharePower.js')
    let next = []
    try { next = JSON.parse(job.context || '{}').place_order || [] } catch {}
    // The chosen PC, then the next best ones (a run that starts; one that goes on stays where its tab is), then this one.
    for (const id of quiet ? [dev] : [dev, ...next.filter(x => x !== dev)]) {
      try {
        // Never a Companion installing an update or restarting (sharePower.ready).
        const d = rb.liveDevices().find(x => x.id === id)
        if (d && !sp.ready(d, sp.ownPower())) throw new Error(d.updating ? `${d.name} is installing an update` : `${d.name} does not answer now or is on another release (${d.version || '?'})`)
        const b = await rb.browserForDevice(id, { quiet: true })
        if (id !== dev) await movedTo(db, job, id)
        if (!quiet) await appendLog(db, job.id, `Working in ${rb.deviceOf(b)?.name || 'the other PC'}'s robot browser (out of sight there)`)
        return b
      } catch (e) {
        if (!quiet) await appendLog(db, job.id, `Not on ${rb.nameOf(id) || 'that PC'} (${e.message}) — ${next.length && id === dev ? 'the next best PC' : 'on this PC instead'}`, 'warn')
      }
    }
    if (!quiet) await movedTo(db, job, '')
  }
  return getBrowser()
}

/** The PC this run worked on went away while it did (remoteBrowsers.watchOver): the words for it, or ''. */
async function pcGone(db, job) {
  const dev = onDevice(job)
  if (!dev) return ''
  try {
    const rb = await import('./remoteBrowsers.js')
    if (!rb.lostLately(dev)) return ''
    const name = rb.nameOf(dev) || 'The other PC'
    // Started again by a person, it chooses anew.
    let ctx = {}
    try { ctx = JSON.parse(job.context || '{}') } catch {}
    delete ctx.placed; delete ctx.place_order; delete ctx.on_device; delete ctx.helped_by; delete ctx.helped_for
    job.context = JSON.stringify(ctx)
    const { seal } = await import('./accountVault.js')
    await db('automation_queue').where('id', job.id).update({ context: seal(job.context) }).catch(() => {})
    return `${name} went away (switched off, or off the network) while it worked. Nothing is sent again by itself: look whether it is saved on the site, then start it again`
  } catch { return '' }
}

/** The run works on another PC than first chosen ('' = this one). */
async function movedTo(db, job, id) {
  let ctx = {}
  try { ctx = JSON.parse(job.context || '{}') } catch {}
  if (id) ctx.on_device = id; else { delete ctx.on_device; delete ctx.helped_by }
  job.context = JSON.stringify(ctx)
  const { seal } = await import('./accountVault.js')
  await db('automation_queue').where('id', job.id).update({ context: seal(job.context) }).catch(() => {})
}

async function appendLog(db, id, msg, level = 'info') {
  try {
    const row = await db('automation_queue').where('id', id).first('log')
    let log = []
    try { log = JSON.parse(row?.log || '[]') } catch {}
    if (!Array.isArray(log)) log = []
    log.push({ ts: Date.now(), level, msg })
    await db('automation_queue').where('id', id).update({ log: JSON.stringify(log) })
  } catch {}
}

export const _limited = new Set()   // runs stopped by the 10-minute limit
/** The run is stopped: cooperatively first (its next step ends it), and for good here when it is stuck. */
export async function stopAtLimit(db, job, page) {
  _limited.add(job.id)
  markCancelled(job.id)
  console.log(`[worker] run #${job.id} (${job.workflow_id}) ${LIMIT_NOTE} — stopped, its tab released`)
  const now = new Date().toISOString()
  try {
    await db('automation_queue').where('id', job.id).whereIn('status', ['running', 'pending', 'paused']).update({ status: 'cancelled', pause_reason: LIMIT_NOTE, finished_at: now, updated_at: now })
    await appendLog(db, job.id, `⛔ ${LIMIT_NOTE[0].toUpperCase()}${LIMIT_NOTE.slice(1)} (${Math.round(RUN_LIMIT_MS / 60000)} min is the most a robot works at one task) — the tab is released`, 'warn')
  } catch (e) { console.warn(`[worker] run #${job.id}: could not write the stop: ${e.message}`) }
  try { await page?.close?.() } catch {}
}

async function runJob(db, job) {
  _limited.delete(job.id)
  let page = null, historyId = null
  try {
    // A run the scanner queued (nobody pressed a button now):
    // never opens Brave itself. While Brave is closed it waits, and it goes
    // on once Brave is open again. Brave that a person closed (or quit Adal
    // Keep) stays closed.
    // (A person's press on it counts from then on: "asked_at" in its context, POST /automations/:id/resume.)
    const nobodyAsked = !/"asked_at"/.test(String(job.context || ''))
      && (/^(Retry |Waiting for Adal Browser)/.test(job.pause_reason || '') || /Auto-discovered by scanner/.test(String(job.log || '')))
    // Nobody pressed it and this PC's browser is closed: a free, strong Companion does it.
    if (LAN_ROBOTS && nobodyAsked && !onDevice(job) && !(await openBrowserIfAny())) await sendToFreeCompanion(db, job)
    if (nobodyAsked && !onDevice(job) && !(await openBrowserIfAny())) {
      const at = new Date(Date.now() + 2 * 60000).toISOString()
      await db('automation_queue').where('id', job.id).update({
        status: 'pending',
        pause_reason: 'Waiting for Adal Browser to be open',
        updated_at: at,
      })
      return
    }
    // The best PC of the office, chosen by itself at the start (services/selfAssign.js, under a second). Any trouble: here.
    let alone = true
    try {
      const { selfAssign } = await import('./selfAssign.js')
      const line = await selfAssign(db, job, { log: (m) => { alone = m === 'one PC' } })
      if (line) { alone = false; await appendLog(db, job.id, line); console.log(`[share] run #${job.id}: ${line}`) }
    } catch (e) { console.warn(`[share] run #${job.id} stays where it is:`, e.message) }
    // Under 4 cores and no other PC can take it: it runs here, said in its log (never stopped silently, never waiting).
    try {
      const H = await import('./hardware.js')
      const hw = H.hardwareNow()
      if (!onDevice(job) && hw.cores < H.MIN_CORES && process.env.ADAL_HW_GATE !== '0') {
        const note = `This PC has ${hw.cores} core${hw.cores === 1 ? '' : 's'} and no stronger office PC ${alone ? 'answers' : 'is free'} now: it runs here, slower`
        await appendLog(db, job.id, note)
        console.warn(`[hardware] run #${job.id}: ${note}`)
      }
    } catch (e) { console.warn(`[hardware] run #${job.id}: core check skipped (${e.message})`) }
    // One LMIS per account (services/lmisOne.js): where this account's LMIS is
    // open already, the run works there — never a second sign-in on another PC.
    if (peerOf(job.workflow_id) === 'lmis') {
      try {
        let acct = job.account_id
        let ctx = {}
        try { ctx = JSON.parse(job.context || '{}') } catch {}
        if (!acct) acct = ctx.account_id
        const home = await (await import('./lmisOne.js')).lmisHome(db, acct)
        if (home && home.device !== onDevice(job)) {
          if (home.device) ctx.on_device = home.device
          else { delete ctx.on_device; delete ctx.quiet }
          job.context = JSON.stringify(ctx)
          const { seal } = await import('./accountVault.js')
          await db('automation_queue').where('id', job.id).update({ context: seal(job.context) })
          await appendLog(db, job.id, `LMIS for this account is open on ${home.name} — working there (one LMIS per account)`)
        }
      } catch (e) { console.warn(`[worker] run #${job.id}: where LMIS is open could not be checked (${e.message})`) }
    }
    // The robot history (services/runHistory.js): who started it, where, and (in finally) how it ended.
    historyId = await beginHistory(db, {
      run_id: job.id, workflow_id: job.workflow_id, profile_id: job.profile_id,
      profile_name: (await db('profiles').where('id', job.profile_id).first('full_name').catch(() => null))?.full_name,
      employee: (await getActiveEmployee(db).catch(() => null))?.name,
    })
    const browser = await browserForJob(db, job)
    if (historyId) {
      const dev = (await import('./remoteBrowsers.js')).deviceOf(browser)
      if (dev?.name) await db('run_history').where('id', historyId).update({ pc: String(dev.name).slice(0, 80) }).catch(() => {})
    }
    // After a server restart the run finds the tab it worked in again.
    await findRunTab(browser, job.id, job.workflow_id, { bySite: false }).catch(() => null)
    // Otherwise a free tab already on the site (signed in), else a new one.
    // A portal account other than the main one works in its own browser space (its own sign-in).
    const space = await spaceForRun(db, browser, job).catch(e => { console.warn(`[worker] run #${job.id}: no space of its own (${e.message})`); return null })
    page = await openRunTab(browser, job.id, { workflowId: job.workflow_id, busyRuns: await activeRunIds(db), keepRuns: await keepingRunIds(db), space, quiet: helpedRun(job) })
    // A Companion's tab that does not answer in 5 s (its browser's CDP is stuck): the run works on this PC
    // instead, at once — not 5 minutes on a blank page and "detached Frame" at the end (2026-11-23).
    if (onDevice(job) && !(await tabAnswers(page, 5000))) {
      const rb = await import('./remoteBrowsers.js')
      await appendLog(db, job.id, `${rb.deviceOf(browser)?.name || 'The Companion'}'s Adal Browser tab does not answer — working on the main PC instead`, 'warn')
      forgetRunTab(job.id)
      page.close().catch(() => {})
      let ctx = {}
      try { ctx = JSON.parse(job.context || '{}') } catch {}
      delete ctx.on_device; delete ctx.helped_by
      job.context = JSON.stringify(ctx)
      const { seal } = await import('./accountVault.js')
      await db('automation_queue').where('id', job.id).update({ context: seal(job.context) }).catch(() => {})
      const here = await getBrowser()
      const space2 = await spaceForRun(db, here, job).catch(() => null)
      page = await openRunTab(here, job.id, { workflowId: job.workflow_id, busyRuns: await activeRunIds(db), keepRuns: await keepingRunIds(db), space: space2, quiet: true })
    }
    // Which account the tab is: its title starts with the account's name.
    try {
      const { labelTab, accountLabel } = await import('./robotCheck.js')
      let acct = job.account_id
      if (!acct) { try { acct = JSON.parse(job.context || '{}').account_id } catch {} }
      const peer = peerOf(job.workflow_id)
      if (peer) {
        const label = await accountLabel(db, peer, acct)
        await labelTab(page, label)
        if (historyId && label) await db('run_history').where('id', historyId).update({ account: label.slice(0, 80) }).catch(() => {})
      }
    } catch {}
    // Never longer than 10 minutes of the robot's own work (services/runLimit.js): past it the run is stopped
    // for good, its tab released, and the queue goes on — even when the workflow itself is stuck.
    const clock = startRunClock({ waiting: () => isWaiting(job.id) })
    const work = executeRun(db, page, job).then(() => 'done', (e) => { if (!_limited.has(job.id)) throw e; return 'limit' })
    work.catch(() => {}).finally(() => { if (_limited.has(job.id)) setTimeout(() => _limited.delete(job.id), 1000).unref?.() })
    try {
      const first = await Promise.race([work, clock.hit.then(() => 'limit')])
      if (first === 'limit') await stopAtLimit(db, job, page)
    } finally { clock.stop() }
  } catch (e) {
    // Could not start at all: no browser, profile deleted, ...
    console.error(`[worker] run #${job.id} could not start: ${e.message}`)
    try { await recordFailure(db, job, e.message) } catch {}
  } finally {
    // The row's end, with the picture of the tab while it is still open.
    await finishHistory(db, job.id, page)
    const row = await db('automation_queue').where('id', job.id).first().catch(() => null)
    // Where this account is signed in now: its next runs go there (services/signInHome.js).
    try {
      if (row && (row.status === 'done' || (row.status === 'paused' && /-human-|epro-save/.test(String(row.pause_reason || ''))))) {
        const { rememberHome } = await import('./signInHome.js')
        let acct = job.account_id
        if (!acct) { try { acct = JSON.parse(job.context || '{}').account_id } catch {} }
        rememberHome(peerOf(job.workflow_id), acct, onDevice(job))
      }
    } catch {}
    try {
      // Done, failed or cancelled: the tab stays open for the person.
      doneWith(job.id, { keepCaptcha: row?.status === 'paused' })
      if (['cancelled', 'failed', 'done'].includes(row?.status)) {
        forgetRunTab(job.id)
        // One tab for the site: the extra ones runs opened there close.
        const b = onDevice(job) ? await browserForJob(db, job, { quiet: true }).catch(() => null) : await openBrowserIfAny().catch(() => null)
        if (b) await tidySiteTabs(b, job.workflow_id, await keepingRunIds(db)).catch(() => {})
      }
      // paused / pending (retry): the tab stays with the run; while a
      // person works in it, file dialogs open normally again.
      else { const t = tabOfRun(job.id); if (t) handTabToPerson(t) }
    } catch {}
    try { await unregisterTab(job.id) } catch {}
    clearCancelled(job.id)
    _expired.delete(Number(job.id))
    if (row?.status !== "paused") { forgetRun(job.id); _forgetBeep(job.id) }
  }
}

// --------------------------------------------------------------------------
// Run queue — which waiting run starts next
// --------------------------------------------------------------------------
/** pause_reason patterns of pending runs that wait until `updated_at`. */
export const WAIT_REASONS = ['Retry %', 'Waiting for %']

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
      // Runs with no wait → always ready.
      this.where(function () {
        this.whereNull('pause_reason')
          .orWhere(function () { for (const p of WAIT_REASONS) this.andWhere('pause_reason', 'not like', p) })
      })
      // Retries and runs sent back to wait (e.g. "Waiting for Adal Browser
      // to be open") → ready only once their wait time (`updated_at`) is
      // reached. Without this a waiting run was claimed again at once and
      // logged "started" over a thousand times.
      .orWhere(function () {
        this.where(function () { for (const p of WAIT_REASONS) this.orWhere('pause_reason', 'like', p) })
          .andWhere('updated_at', '<=', now)
      })
    })
}

const _hasPriority = new WeakMap()
async function queueHasPriority(db) {
  if (_hasPriority.get(db) !== true) _hasPriority.set(db, await db.schema.hasColumn('automation_queue', 'priority').catch(() => false))
  return _hasPriority.get(db)
}

/** A run's lane: its site and account ('musaned:3'); runs of one lane share one tab, one after another. '' = none. */
export function laneOf(job) {
  const peer = peerOf(job?.workflow_id)
  if (!peer) return ''
  let acct = job.account_id
  if (!acct) { try { acct = JSON.parse(job.context || '{}').account_id } catch {} }
  return `${peer}:${acct ? Number(acct) || String(acct) : 'main'}`
}

/**
 * Claim the oldest ready run, skipping runs this process is still finishing
 * and runs of a lane (site + account) another run holds now (`lanes`).
 */
/** A run waits in its site's tab for a person to sign in (a captcha, a code, a tick): not for a Save. */
export const SIGN_IN_WAIT = /^awaiting-[a-z]+-(login|captcha|otp|code|robot|precheck)$/
const SIGN_IN_FRESH_MS = 30 * 60e3

/**
 * Lanes held by a run paused for a sign-in in the last 30 minutes: the next run of that site and
 * account would only need the same sign-in (2026-11-23: 20 Musaned runs one after another, each
 * paused at the same reCAPTCHA, each one more beep and one more notice). It waits; once the person
 * signs in, the paused run goes on, ends, and the next one starts in the signed-in tab.
 */
export async function signInLanes(db, now = Date.now(), { tabLive = _tabLive } = {}) {
  const since = new Date(now - SIGN_IN_FRESH_MS).toISOString()
  const rows = await db('automation_queue').where('status', 'paused').where('updated_at', '>', since)
    .select('id', 'workflow_id', 'account_id', 'context', 'pause_reason').catch(() => [])
  // Only while its tab is really there: a run whose browser is gone (closed, restarted) holds nothing
  // (2026-11-24: the robot browser died, 4 runs stayed "waiting for the sign-in" and held 25 others).
  // (Also a sign-in nobody answered in 10 minutes, NO_ANSWER: its tab still waits at the box — the next run
  // would only open a second sign-in tab beside it and call again.)
  const lanes = new Set(rows.filter(r => (SIGN_IN_WAIT.test(String(r.pause_reason || '')) || /^No answer for /.test(String(r.pause_reason || ''))) && tabLive(r.id)).map(laneOf).filter(Boolean))
  // Forms waiting for a person's Save: each holds a tab with its filled form (8 Musaned tabs on this PC,
  // 2026-11-24, gigabytes on a weak PC). At most a few per site and account; the next run waits in line
  // until a person saves one (nothing is lost, nothing is filled twice).
  const saves = await db('automation_queue').where('status', 'paused').where('pause_reason', 'like', 'awaiting-%-save')
    .select('id', 'workflow_id', 'account_id', 'context').catch(() => [])
  const count = {}
  for (const r of saves) if (tabLive(r.id)) { const l = laneOf(r); if (l) count[l] = (count[l] || 0) + 1 }
  for (const [l, n] of Object.entries(count)) if (n >= maxSaveWaiting()) lanes.add(l)
  return lanes
}
/** How many forms may wait for Save per site and account: 3, 2 on a PC of 4 cores or fewer (ADAL_MAX_SAVE_WAITING). */
export const maxSaveWaiting = () => Number(process.env.ADAL_MAX_SAVE_WAITING) || ((os.cpus()?.length || 2) <= 4 ? 2 : 3)

/** The run's tab is open in a browser this PC is connected to. */
export function runTabLive(runId) {
  const t = tabOfRun(runId)
  try { return !!t && t.browser?.()?.connected !== false } catch { return false }
}

/**
 * After a restart: each paused run's tab (its form waiting for Save, its sign-in) is found again in the robot
 * browser (the tab carries the run's name), so the limits above count it and the run goes on in it.
 */
export async function adoptWaitingTabs(db) {
  const browser = await openBrowserIfAny().catch(() => null)
  if (!browser) return 0
  let n = 0
  for (const r of await db('automation_queue').where('status', 'paused').select('id', 'workflow_id').catch(() => [])) {
    if (await findRunTab(browser, r.id, r.workflow_id, { bySite: false }).catch(() => null)) n++
  }
  if (n) console.log(`[worker] ${n} waiting run(s) found their tab again after the restart`)
  return n
}

let _tabLive = (id) => runTabLive(id)
export const _setTabLiveForTest = (fn) => { _tabLive = fn || ((id) => runTabLive(id)) }
const SIGN_IN_GIVE_UP_MS = 6 * 3600e3
/**
 * A run paused for a sign-in whose tab is gone (its browser closed or died, the server restarted) never stays
 * paused for ever: it goes back in line at its step, opens the browser and the site's sign-in again, and calls
 * the person once more. Past 6 hours nobody expects it: it ends, saying why. At start and every minute.
 */
export async function reviveSignIns(db, now = Date.now(), { tabLive = _tabLive } = {}) {
  const rows = await db('automation_queue').where('status', 'paused').select('id', 'pause_reason', 'updated_at').catch(() => [])
  let back = 0, ended = 0
  for (const r of rows) {
    if (!SIGN_IN_WAIT.test(String(r.pause_reason || '')) || tabLive(r.id)) continue
    const at = Date.parse(r.updated_at || '') || 0
    const iso = new Date(now).toISOString()
    if (now - at > SIGN_IN_GIVE_UP_MS) {
      ended += await db('automation_queue').where({ id: r.id, status: 'paused' }).update({ status: 'cancelled', pause_reason: 'Nobody signed in within 6 hours (its browser was closed meanwhile): start it again', finished_at: iso, updated_at: iso }).catch(() => 0)
    } else {
      // Pending with its step kept (pause_reason): it goes on from the sign-in.
      back += await db('automation_queue').where({ id: r.id, status: 'paused' }).update({ status: 'pending', updated_at: iso }).catch(() => 0)
    }
  }
  if (back) console.log(`[worker] ${back} run(s) waiting for a sign-in had lost their browser — back in line, the sign-in opens again`)
  if (ended) console.log(`[worker] ${ended} run(s) waiting for a sign-in for over 6 hours without a browser — ended`)
  return { back, ended }
}

export async function claimNextJob(db, exclude = [], lanes = new Set()) {
  if (isAppLocked()) return null // trial over and not unlocked: no runs start
  if (towerHeld()) return null   // Adal support held the robots on this PC (Admin → Fleet → Suspend)
  lanes = new Set([...lanes, ...(await signInLanes(db))])
  for (let i = 0; i < 5; i++) {
    const q = readyJobsQuery(db)
    if (exclude.length) q.whereNotIn('id', exclude)
    // The highest priority first (a person moved it up, Robot history → Waiting), then the oldest.
    if (await queueHasPriority(db)) q.orderBy('priority', 'desc')
    const rows = await q.orderBy('id', 'asc').limit(lanes.size ? 50 : 1)
    const row = rows.find(r => !lanes.has(laneOf(r)))
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

// Adal Robots (robots/adal-robots.mjs) on a weak PC: no new run starts while the processor is over 80 % busy
// (the run waits in line; the PC's person comes first). Set by the program that runs the robots; none = always.
let _claimGate = null, _gateAt = 0, _gateOk = true
export function setClaimGate(fn) { _claimGate = fn; _gateAt = 0 }
async function mayClaim() {
  if (!_claimGate) return true
  if (Date.now() - _gateAt < 4000) return _gateOk          // looked at a moment ago
  _gateAt = Date.now()
  try { _gateOk = !!(await _claimGate()) } catch { _gateOk = true }
  return _gateOk
}

let _runs = null
function runs(db) {
  if (!_runs) {
    _runs = createRunQueue({
      max: MAX_RUNS,
      isIdle: (id) => isWaiting(id),
      claimNext: async (exclude, lanes) => ((await mayClaim()) ? claimNextJob(db, exclude, lanes) : null),
      laneOf,
      runJob: (job) => runJob(db, job),
    })
    reportRuns(() => _runs.snapshot().running.length)
    onWait(() => setTimeout(() => _runs?.drain(), 50))
    hookTaskExpiry(db)
    // This PC's internet, measured while no robot works (services/sharePower.js picks the PC by it).
    import('./netQuality.js').then(n => n.startNetProbe({ busy: () => (_runs?.snapshot().running.length || 0) > 0 })).catch(() => {})
  }
  return _runs
}

/** Start as many waiting runs as there are free slots. */
export function drainQueue(db) {
  if (!robotsInApp()) return Promise.resolve()   // Adal Robots runs the queue (services/robotsInApp.js)
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
  const me = await db('automation_queue').where('id', Number(runId)).first('priority')
  const mine = Number(me?.priority || 0)
  const q = readyJobsQuery(db)
  // Ahead of it: a higher priority, or the same and older.
  if (await queueHasPriority(db)) q.where(function () { this.where('priority', '>', mine).orWhere(function () { this.whereRaw('coalesce(priority, 0) = ?', [mine]).andWhere('id', '<', Number(runId)) }) })
  else q.where('id', '<', Number(runId))
  const r = await q.count({ c: '*' }).first()
  return { state: 'queued', ahead: Number(r?.c || 0), ...base }
}

/** Start a run now if a slot is free, then report where it stands. */
export async function dispatchRun(db, runId) {
  // A Companion with its own copy: the run waits in the queue, which goes to the
  // main PC with the rest of the data; the main PC's worker runs it (one PC runs robots).
  const { notMainPC } = await import('./mainPC.js')
  if (notMainPC()) return { ...(await runStatus(db, runId)), on_main: true }
  if (!robotsInApp()) {
    await db('automation_queue').where({ id: Number(runId?.id ?? runId), status: 'pending' }).whereNull('pause_reason').update({ pause_reason: IN_LINE }).catch(() => {})
    return { ...(await runStatus(db, runId)), in_line: true, message: IN_LINE }
  }
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
          // Never a second police run by itself, however the first ended (one try; a person presses it again).
          const existing = await db('automation_queue').where({ profile_id: d.profileId, workflow_id: 'police_certificate' }).first('id')
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
    // A blank Musaned page is not signed in: going on there paused the run again every 15 s.
    if (hostOf(page.url()) === 'tawtheeq.musaned.com.sa' && await page.evaluate(() => !(document.body?.innerText || '').trim()).catch(() => true)) continue
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
  if (!robotsInApp()) { console.log('[worker] robots run in Adal Robots: this app runs no robot job (ADAL_ROBOTS_IN_APP=1 to run them here)'); return }

  console.log(
    `[worker] polling every ${POLL_MS}ms — one run at a time, in its own tab`
  )
  closeStaleHistory(db).then(() => pruneHistory(db))
  setInterval(() => pruneHistory(db), 6 * 3600_000).unref?.()
  parkInterruptedRuns(db).then(() => adoptWaitingTabs(db)).then(() => reviveSignIns(db)).catch(() => {}).finally(() => drainQueue(db))
  setInterval(() => reviveSignIns(db).then(r => { if (r.back) drainQueue(db) }).catch(e => console.warn('[worker] sign-in revive:', e.message)), 60000).unref?.()
  // The poll only matters for retries whose backoff has run out and for runs
  // queued by the scanner: a click or a finished run starts the next one at once.
  _interval = setInterval(() => {
    drainQueue(db).catch(e => console.error('[worker] poll error:', e))
  }, POLL_MS)
  // No robot tab holds this PC: one that uses the processor without end is stopped (services/robotGuard.js).
  import('./robotGuard.js').then(g => g.startRobotGuard(db)).catch(e => console.warn('[guard] not started:', e.message))
  setInterval(() => continueSignedIn(db).catch(e => console.warn('[worker] sign-in look:', e.message)), 15000).unref?.()
  setInterval(() => closeSavedRuns(db).catch(e => console.warn('[worker] saved look:', e.message)), 3000).unref?.()

  // ADAL_AGENCY_MANAGER=0: no runs put in line by the agency manager (Adal Robots' first start on a PC: only the runs a person queues).
  if (process.env.ADAL_AGENCY_MANAGER === '0') { console.log('[worker] agency manager off (ADAL_AGENCY_MANAGER=0)'); return }
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
