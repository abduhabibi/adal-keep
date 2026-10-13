/**
 * worker.js — Lane-based parallel job runner with retry + backoff.
 *
 * v9 — real backoff. Previously the retry branch set pause_reason to
 *      "Retry N/M at <timestamp>" but readyJobsQuery's check was
 *      `created_at <= now`, which is trivially true — so retries fired on
 *      the very next 5s poll and looked like a page reload mid-workflow.
 *      Now the retry deadline is stored in `updated_at` (a future ISO
 *      timestamp) and readyJobsQuery refuses retry-* jobs until that
 *      deadline passes. BASE is now env-configurable and defaults to 2 min.
 *      Also broadened the non-retryable pattern list so LMIS "not in pool"
 *      style permanent errors stop looping.
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { getBrowser } from './browser.js'
import { runFullWorkflow } from './lmisWorkflow.js'
import { decideAgencyActions } from './jev/agencyManager.js'
import { getActiveEmployee } from './activeEmployee.js'
import { setupTab, ensurePeerTab, endJobTab, peerForWorkflow, closeIfBlank } from './tabManager.js'
import { registerTab, unregisterTab, noteLink } from './bandwidth.js'
import { ensureAgent, updateAgent, removeAgent, getAgent } from './agentRegistry.js'
import { isCancelled, clearCancelled } from './cancellation.js'
import { assertPoliceReady } from './verification.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')

const LANES              = Number(process.env.AUTOMATION_LANES || 3)
const POLL_MS            = 5000
const MAX_ATTEMPTS       = 3
// Retry backoff: attempt 1 waits this long, attempt 2 waits 4× this.
// Minimum 2 minutes per the operator's request; override with RETRY_BACKOFF_MS.
const BACKOFF_BASE_MS    = Number(process.env.RETRY_BACKOFF_MS || 120000)
const AGENCY_INTERVAL_MS = 30 * 60 * 1000   // 30 min
const AGENCY_PROFILE_LIMIT = Number(process.env.AGENCY_PROFILE_LIMIT || 200)

let _running       = false
let _interval      = null
let _agencyTimer   = null
let _agencyRunning = false

// Per-lane page cache. Key = laneId, value = puppeteer Page.
const _lanePages = new Map()

// --------------------------------------------------------------------------
// Notifications
// --------------------------------------------------------------------------
function playNotificationSound() {
  try {
    const platform = process.platform
    let cmd, args
    if (platform === 'darwin') {
      cmd = 'afplay'
      args = ['/System/Library/Sounds/Glass.aiff']
    } else if (platform === 'win32') {
      cmd = 'powershell'
      args = ['-NoProfile', '-Command', '[console]::beep(880,180); [console]::beep(660,180)']
    } else {
      cmd = 'paplay'
      args = ['/usr/share/sounds/freedesktop/stereo/complete.oga']
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
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

  return {
    photoPath: await get('Photo'),
    passportPath: await get('Passport'),
    passportImagePath: await getPassportImage(),
    fullBodyPath: await get('Full Body Photo'),
    slipPath: await get('Slip'),
  }
}

// --------------------------------------------------------------------------
// Lane tab management
// --------------------------------------------------------------------------
async function getLanePage(browser, laneId) {
  let page = _lanePages.get(laneId)

  if (page) {
    try {
      if (page.isClosed && page.isClosed()) {
        page = null
        _lanePages.delete(laneId)
      }
    } catch {
      page = null
      _lanePages.delete(laneId)
    }
  }

  if (!page) {
    page = await browser.newPage()
    console.log(`[worker] lane ${laneId} opened dedicated tab`)
    await setupTab(page, { laneId })
    _lanePages.set(laneId, page)
  } else {
    await setupTab(page, { laneId })
  }

  return page
}

// --------------------------------------------------------------------------
// Job execution
// --------------------------------------------------------------------------
async function runJobInLane(db, page, laneId, job) {
  const profile = await db('profiles').where('id', job.profile_id).first()
  if (!profile) throw new Error('Profile not found')

  const files    = await resolveFilePaths(db, job.profile_id)
  const savedCtx = JSON.parse(job.context || '{}')
  const attempt  = (job.current_step || 0) + 1

  const musanedStage = (() => {
    if (!job.workflow_id.startsWith('musaned')) return 'start'
    if (savedCtx.musanedStage) return savedCtx.musanedStage
    if (job.status !== 'paused')               return 'start'
    if (!job.pause_reason)                     return 'start'
    if (job.pause_reason.startsWith('awaiting-musaned-')) return job.pause_reason
    return 'start'
  })()

  const peer = peerForWorkflow(job.workflow_id)
  const peerSel = await ensurePeerTab({ browser: page.browser(), page, laneId, peer })
  if (peerSel.page && peerSel.page !== page) {
    const oldPage = page
    page = peerSel.page
    _lanePages.set(laneId, page)
    closeIfBlank(oldPage).catch(() => {})
  }

  const isMusaned = job.workflow_id.startsWith('musaned')
  page.__adalAllowImages = isMusaned
  console.log(
    `[worker] lane ${laneId} job #${job.id} image policy: ` +
    (isMusaned
      ? `ALLOW (${job.workflow_id} — reCAPTCHA needs images)`
      : 'BLOCK (bandwidth saver)')
  )

  const onLog = async (level, msg) => {
    const row = await db('automation_queue').where('id', job.id).first()
    let log = []
    try { log = JSON.parse(row?.log || '[]') } catch {}
    log.push({ ts: Date.now(), level, msg })
    if (log.length > 200) log = log.slice(-200)
    await db('automation_queue').where('id', job.id).update({ log: JSON.stringify(log) })
  }

  const notify = async (title, body, level = 'info') => {
    try {
      await db('tasks').insert({
        type: 'automation', title, description: body || '',
        status: 'pending', profile_id: job.profile_id, assigned_to: 1,
        is_ai_created: true, created_at: new Date().toISOString(),
      })
      console.log(`[notify] ${level.toUpperCase()} ${title}`)
      if (onLog) await onLog(level, `🔔 ${title}`)
      playNotificationSound()
    } catch (e) {
      console.error('[notify] failed:', e.message)
    }
  }

  let activeEmployee = null
  try { activeEmployee = await getActiveEmployee(db) } catch {}

  const ctx = {
    laneId,
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
    musanedStage,
    labor_id:          profile.labor_id || '',
    destination_country: profile.destination_country || '',
    photoPath:    files.photoPath,
    passportPath: files.passportPath,
    passportImagePath: files.passportImagePath,
    fullBodyPath: files.fullBodyPath,
    slipPath:     files.slipPath,
    onLog,
    notify,
  }

  ctx.__peerTab = peerSel
  ctx.page = page
  ctx.isCancelled = () => isCancelled(job.id)

  updateAgent(laneId, {
    state: 'working',
    current: {
      runId: job.id,
      workflowId: job.workflow_id,
      profileId: job.profile_id,
      profileName: ctx.profileName,
      startedAt: new Date().toISOString(),
    },
  })

  const handleCancelled = async () => {
    try {
      await db('automation_queue').where('id', job.id).update({
        status: 'cancelled',
        pause_reason: 'Cancelled by user',
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await onLog('warn', '⛔ Cancelled by user — agent stopped')
    } catch {}
  }

  const keepTab = !!job.preferred_lane || !!getAgent(laneId)?.assignment
  try {
    await page.evaluateOnNewDocument((jid, keep) => {
      try {
        localStorage.setItem('adal_job_id', String(jid))
        if (keep) localStorage.setItem('adal_keep_tab', '1')
        else localStorage.removeItem('adal_keep_tab')
      } catch {}
    }, job.id, keepTab)
    await page.evaluate((jid, keep) => {
      try {
        localStorage.setItem('adal_job_id', String(jid))
        if (keep) localStorage.setItem('adal_keep_tab', '1')
        else localStorage.removeItem('adal_keep_tab')
      } catch {}
    }, job.id, keepTab).catch(() => {})
  } catch (e) {
    console.log('[worker] could not set job tag:', e.message)
  }

  try { await noteLink(page) } catch {}
  try { await registerTab(laneId, page) } catch {}

  try {
    await db('automation_queue').where('id', job.id).update({
      status: 'running',
      started_at: new Date().toISOString(),
    })

    const result = await runFullWorkflow(page, ctx)

    if (isCancelled(job.id)) {
      await handleCancelled()
      return { keepAlive: false }
    }

    if (result.ok) {
      const pauseReason = result.pauseReason || 'awaiting-human-submit'
      await db('automation_queue').where('id', job.id).update({
        status: 'paused',
        pause_reason: pauseReason,
        updated_at: new Date().toISOString(),
      })
      console.log(`[worker] job #${job.id} paused: ${pauseReason}`)
      return { keepAlive: true }
    }

    // ---- Failure: retry vs permanent ----
    const errText = result.error || result.reason || ''
    // Permanent errors: retrying will never help. Add LMIS/companion-specific
    // permanent reasons here so they don't burn attempts on a 2-minute loop.
    const isRetryable = !(
      /Session lost|not found|Not Found|not in the|placed pool|different labor|could not be verified|already_in_other_agency|already attached|already exists|Profile is missing/i
        .test(errText)
    )
    const underLimit  = attempt < MAX_ATTEMPTS

    if (isRetryable && underLimit) {
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
      console.log(`[worker] lane ${laneId} job #${job.id} retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(delayMs / 60000)}min`)
    } else {
      await db('automation_queue').where('id', job.id).update({
        status: 'failed',
        pause_reason: `${errText} (after ${attempt} attempts)`,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      console.log(`[worker] lane ${laneId} job #${job.id} FAILED permanently`)
    }

    return { keepAlive: true }
  } catch (e) {
    if (e?.cancelled || isCancelled(job.id)) {
      await handleCancelled()
      return { keepAlive: false }
    }
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = BACKOFF_BASE_MS * Math.pow(4, attempt - 1)
      const retryAt = new Date(Date.now() + delayMs).toISOString()
      await db('automation_queue').where('id', job.id).update({
        status: 'pending',
        current_step: attempt,
        pause_reason: `Retry ${attempt}/${MAX_ATTEMPTS} at ${retryAt} — ${e.message}`,
        updated_at: retryAt,
      })
      console.log(`[worker] lane ${laneId} job #${job.id} retry ${attempt}/${MAX_ATTEMPTS} in ${Math.round(delayMs / 60000)}min (exception path)`)
    } else {
      await db('automation_queue').where('id', job.id).update({
        status: 'failed',
        pause_reason: e.message,
        updated_at: new Date().toISOString(),
      })
    }
    return { keepAlive: true }
  } finally {
    try { endJobTab(page) } catch {}
    try { await unregisterTab(laneId) } catch {}
    try { clearCancelled(job.id) } catch {}
  }
}

// --------------------------------------------------------------------------
// Agent pool
// --------------------------------------------------------------------------
const MIN_AGENTS = Math.max(1, Number(process.env.AUTOMATION_MIN_AGENTS || 10))
const MAX_AGENTS = Math.max(MIN_AGENTS, Number(process.env.AUTOMATION_MAX_AGENTS || MIN_AGENTS))
void LANES

const _pool = new Map()

/**
 * Ready jobs for a given agent.
 *
 *   laneId === null  → only UNASSIGNED jobs (preferred_lane IS NULL) whose
 *                      portal matches `peer`. Used for counting.
 *   laneId  is set   → jobs pinned to THIS lane PLUS unassigned jobs matching
 *                      `peer`.
 *
 * v9: retry jobs are only handed out AFTER their backoff deadline.
 * The deadline is stored in `updated_at` (a future timestamp set by the retry
 * branches in runJobInLane). Without this check, retries fired on the very
 * next poll and the browser looked like it was reloading mid-workflow.
 */
export function readyJobsQuery(db, peer = null, laneId = null) {
  const now = new Date().toISOString()
  const base = db('automation_queue')
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

  const portal = (b) => {
    if (peer === 'musaned') b.andWhere('workflow_id', 'like', 'musaned%')
    else if (peer === 'lmis') b.andWhere('workflow_id', 'not like', 'musaned%')
  }

  if (laneId != null) {
    base.andWhere(function () {
      this.where('preferred_lane', laneId)
        .orWhere(function () {
          this.whereNull('preferred_lane')
          portal(this)
        })
    })
  } else {
    base.whereNull('preferred_lane')
    portal(base)
  }
  return base
}

export async function claimNextJob(db, peer = null, laneId = null) {
  for (let i = 0; i < 5; i++) {
    const row = await readyJobsQuery(db, peer, laneId).orderBy('id', 'asc').first()
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

function allocLaneId() {
  let i = 1
  while (_pool.has(i)) i++
  return i
}

function requeueJob(db, jobId) {
  return db('automation_queue')
    .where('id', jobId).andWhere('status', 'running')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .catch(() => {})
}

function spawnAgent(db) {
  const laneId = allocLaneId()
  const agent = ensureAgent(laneId)
  const rt = { laneId, alive: true, busy: false, currentId: null, _wake: null }
  rt.wait = () => new Promise(res => { rt._wake = res })
  rt.wake = () => { if (rt._wake) { const r = rt._wake; rt._wake = null; r() } }
  _pool.set(laneId, rt)
  console.log(`[worker] ${agent.label} (${agent.color.name}) ready`)

  rt.loop = (async () => {
    while (rt.alive) {
      let job = null
      try {
        const assignment = getAgent(laneId)?.assignment || null
        job = await claimNextJob(db, assignment, laneId)
      } catch (e) { console.error('[worker] claim error:', e.message) }

      if (!rt.alive) { if (job) await requeueJob(db, job.id); break }
      if (!job) { await rt.wait(); continue }

      rt.busy = true
      rt.currentId = job.id
      updateAgent(laneId, {
        state: 'working',
        startedAt: new Date().toISOString(),
        current: {
          runId: job.id,
          workflowId: job.workflow_id,
          profileId: job.profile_id,
          profileName: null,
          startedAt: new Date().toISOString(),
        },
      })
      try {
        const browser = await getBrowser()
        const page = await getLanePage(browser, laneId)
        console.log(`[worker] ${agent.label} starting job #${job.id} (profile ${job.profile_id})`)
        await runJobInLane(db, page, laneId, job)
      } catch (e) {
        console.error(`[worker] ${agent.label} job #${job.id} crashed:`, e.message)
      } finally {
        rt.busy = false
        rt.currentId = null
        updateAgent(laneId, { state: 'idle', current: null, startedAt: null })
      }
    }
  })().catch(e => console.error('[worker] agent loop crashed:', e))

  return rt
}

function retireAgent(rt) {
  rt.alive = false
  rt.wake()
  _pool.delete(rt.laneId)
  removeAgent(rt.laneId)
  try {
    const p = _lanePages.get(rt.laneId)
    if (p) { closeIfBlank(p).catch(() => {}); _lanePages.delete(rt.laneId) }
  } catch {}
  console.log(`[worker] agent #${rt.laneId} retired`)
}

async function sizePool(db) {
  let pending = 0
  try {
    const r = await db('automation_queue').where('status', 'pending').count({ c: '*' }).first()
    pending = Number(r?.c || 0)
  } catch {}
  const busy = [..._pool.values()].filter(r => r.busy).length
  const desired = Math.max(MIN_AGENTS, Math.min(MAX_AGENTS, busy + pending))

  let guard = 0
  while (_pool.size < desired && guard++ <= MAX_AGENTS) spawnAgent(db)

  if (_pool.size > desired) {
    for (const rt of [..._pool.values()].reverse()) {
      if (_pool.size <= desired) break
      if (!rt.busy) retireAgent(rt)
    }
  }
}

// --------------------------------------------------------------------------
// Pool pump
// --------------------------------------------------------------------------
export async function drainQueue(db) {
  try {
    if (_pool.size === 0) for (let i = 0; i < MIN_AGENTS; i++) spawnAgent(db)
    await sizePool(db)
    for (const rt of _pool.values()) if (!rt.busy) rt.wake()
  } catch (e) {
    console.error('[worker] pump error:', e)
  }
}

export function wakeIdleAgents() {
  for (const rt of _pool.values()) if (!rt.busy) rt.wake()
}

// --------------------------------------------------------------------------
// Agency manager loop
// --------------------------------------------------------------------------
export async function runAgencyManager(db) {
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

  console.log(`[worker] polling every ${POLL_MS}ms — elastic pool ${MIN_AGENTS}..${MAX_AGENTS} agents — backoff base ${BACKOFF_BASE_MS / 1000}s`)
  drainQueue(db).catch(e => console.error('[worker] initial pump error:', e))
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