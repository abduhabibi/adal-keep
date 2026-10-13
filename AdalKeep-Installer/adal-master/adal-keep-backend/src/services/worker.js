/**
 * worker.js — Lane-based parallel job runner with retry + backoff.
 *
 * v7 — Agency manager loop.
 *
 *   Alongside the existing 5-second queue drain, startWorker now also
 *   spins up a 30-minute agency-manager loop that:
 *
 *     1. Loads active profiles (+ their file-name summary)
 *     2. Asks Jev (decideAgencyActions) what each profile needs next
 *     3. Enqueues automation jobs / tasks accordingly
 *
 *   The two loops are independent:
 *     - drainQueue      → runs every 5s,   drains automation_queue
 *     - agencyManager   → runs every 30m,  refills automation_queue
 *
 *   Per-workflow image policy is unchanged: musaned* gets images ON
 *   (reCAPTCHA), everything else images OFF.
 *
 * v7.1 — resolveFilePaths now also returns passportImagePath: an
 *        image-typed Passport file (jpg/jpeg/png/webp) preferred over
 *        any PDF the profile may have attached. Used by Musaned's
 *        Candidate pre-check, which rejects PDFs at the dropzone.
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { getBrowser } from './browser.js'
import { runFullWorkflow } from './lmisWorkflow.js'
import { decideAgencyActions } from './jev/agencyManager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')

const LANES              = Number(process.env.AUTOMATION_LANES || 3)
const POLL_MS            = 5000
const MAX_ATTEMPTS       = 3
const BACKOFF_BASE_MS    = 60000   // 1 min, 4 min, 16 min
const AGENCY_INTERVAL_MS = 30 * 60 * 1000   // 30 min
const AGENCY_PROFILE_LIMIT = Number(process.env.AGENCY_PROFILE_LIMIT || 200)

let _running       = false
let _interval      = null
let _agencyTimer   = null
let _agencyRunning = false

// Per-lane page cache. Key = laneId, value = puppeteer Page.
// Kept across drainQueue invocations so sequential jobs reuse their lane's tab.
const _lanePages = new Map()

// --------------------------------------------------------------------------
// Notifications
// --------------------------------------------------------------------------
/**
 * Play the OS notification sound. Runs detached so it never blocks the
 * worker loop. Failures are silent — the notification still lands in the
 * bell even if the OS has no sound card or the player is missing.
 */
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
    child.on('error', () => {})   // swallow ENOENT etc.
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

  // New: prefer an image-typed Passport file (Musaned rejects PDFs)
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
/**
 * Get (or create) this lane's dedicated tab. Idempotent per lane.
 *
 * On first creation the tab is:
 *   - muted via CDP (Page.setAudioMuted)
 *   - focus-emulated via CDP (Emulation.setFocusEmulationEnabled) so the
 *     renderer never throttles timers / network when the user switches away
 *   - request interception attached (see handler below — the actual
 *     image-block decision is made per-request via page.__adalAllowImages,
 *     which runJobInLane sets fresh for every job)
 */
async function getLanePage(browser, laneId) {
  let page = _lanePages.get(laneId)

  // Drop the cached page if it died
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

    // Mute audio
    try {
      const cdp = await page.target().createCDPSession()
      await cdp.send('Page.setAudioMuted', { muted: true })
    } catch (e) {
      console.log(`[worker] lane ${laneId} could not mute tab:`, e.message)
    }

    // Tell Chromium this tab is always focused — prevents timer throttling
    // and network backoff when the user switches tabs mid-upload.
    if (!page.__adalFocused) {
      try {
        const cdp = await page.target().createCDPSession()
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        page.__adalFocused = true
        console.log(`[worker] lane ${laneId} focus emulation ON`)
      } catch (e) {
        console.log('[worker] could not enable focus emulation:', e.message)
      }
    }

    // Request interception — the image-block decision is made dynamically
    // per request by consulting page.__adalAllowImages. That flag is set
    // fresh in runJobInLane for every job, so a single shared tab can be
    // image-blocking for one job and image-allowing for the next.
    try {
      await page.setRequestInterception(true)
      page.on('request', req => {
        const allowImages = page.__adalAllowImages === true
        if (!allowImages && req.resourceType() === 'image') {
          req.abort()
        } else {
          req.continue()
        }
      })
      console.log(`[worker] lane ${laneId} request interception attached (dynamic image policy)`)
    } catch (e) {
      console.log(`[worker] lane ${laneId} could not attach request interception:`, e.message)
    }

    _lanePages.set(laneId, page)
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

  // Track which stage of a multi-pause workflow we're resuming from.
  // Prefer a context-persisted stage (set by /complete) over pause_reason,
  // since /complete clears pause_reason when it re-queues the job.
  const musanedStage = (() => {
    if (!job.workflow_id.startsWith('musaned')) return 'start'
    if (savedCtx.musanedStage) return savedCtx.musanedStage
    if (job.status !== 'paused')               return 'start'
    if (!job.pause_reason)                     return 'start'
    if (job.pause_reason.startsWith('awaiting-musaned-')) return job.pause_reason
    return 'start'
  })()

  // ─── PER-WORKFLOW IMAGE POLICY ───────────────────────────────────────────
  // Every musaned* workflow (login, add_candidate, ...) routes through
  // runMusanedWorkflow, which can hit reCAPTCHA image challenges during its
  // login step. Those need real images so the human can solve them.
  // All other workflows keep images off to save bandwidth/RAM.
  const isMusaned = job.workflow_id.startsWith('musaned')
  page.__adalAllowImages = isMusaned
  console.log(
    `[worker] lane ${laneId} job #${job.id} image policy: ` +
    (isMusaned
      ? `ALLOW (${job.workflow_id} — reCAPTCHA needs images)`
      : 'BLOCK (bandwidth saver)')
  )
  // ─────────────────────────────────────────────────────────────────────────

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

  const ctx = {
    laneId,
    profileId: job.profile_id,
    workflowId: job.workflow_id,
    profileName: profile.full_name || `Profile #${job.profile_id}`,
    profile,
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

  // Tag this tab with the current job id so /complete can find it later.
  try {
    await page.evaluateOnNewDocument((jid) => {
      try { localStorage.setItem('adal_job_id', String(jid)) } catch {}
    }, job.id)
    await page.evaluate((jid) => {
      try { localStorage.setItem('adal_job_id', String(jid)) } catch {}
    }, job.id).catch(() => {})
  } catch (e) {
    console.log('[worker] could not set job tag:', e.message)
  }

  try {
    await db('automation_queue').where('id', job.id).update({
      status: 'running',
      started_at: new Date().toISOString(),
    })

    const result = await runFullWorkflow(page, ctx)

    // ---- Success (paused awaiting human) ----
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
    const isRetryable = !/Session lost|not found|Not Found|already_in_other_agency|already attached|already exists|Profile is missing/i.test(errText)
    const underLimit  = attempt < MAX_ATTEMPTS

    if (isRetryable && underLimit) {
      const delayMs = BACKOFF_BASE_MS * Math.pow(4, attempt - 1)
      const retryAt = new Date(Date.now() + delayMs).toISOString()
      await db('automation_queue').where('id', job.id).update({
        status: 'pending',
        current_step: attempt,
        pause_reason: `Retry ${attempt}/${MAX_ATTEMPTS} at ${retryAt} — ${errText}`,
        updated_at: new Date().toISOString(),
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

    // Tab stays open — even on retryable failure the human may want to inspect.
    return { keepAlive: true }
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await db('automation_queue').where('id', job.id).update({
        status: 'pending',
        current_step: attempt,
        pause_reason: `Retry ${attempt}/${MAX_ATTEMPTS} — ${e.message}`,
        updated_at: new Date().toISOString(),
      })
    } else {
      await db('automation_queue').where('id', job.id).update({
        status: 'failed',
        pause_reason: e.message,
        updated_at: new Date().toISOString(),
      })
    }
    // Do NOT close the page — keep it for inspection.
    return { keepAlive: true }
  }
}

// --------------------------------------------------------------------------
// Lane runner
// --------------------------------------------------------------------------
async function runLane(db, laneId, jobs) {
  if (jobs.length === 0) return

  const browser = await getBrowser()
  const page    = await getLanePage(browser, laneId)

  for (const job of jobs) {
    console.log(`[worker] lane ${laneId} starting job #${job.id} (profile ${job.profile_id})`)
    try {
      await runJobInLane(db, page, laneId, job)
    } catch (e) {
      console.error(`[worker] lane ${laneId} job #${job.id} crashed:`, e.message)
    }
  }

  // Do not close the tab — leave it for human review or the next poll.
}

// --------------------------------------------------------------------------
// Queue drain
// --------------------------------------------------------------------------
export async function drainQueue(db) {
  if (_running) return
  _running = true
  try {
    // Only pick up jobs that are ready (pending, and backoff time has passed).
    const now = new Date().toISOString()
    const jobs = await db('automation_queue')
      .where('status', 'pending')
      .where(function () {
        this.whereNull('pause_reason')
          .orWhere('pause_reason', 'not like', 'Retry %')
          .orWhereRaw('created_at <= ?', [now])
      })
      .orderBy('id', 'asc')
      .limit(LANES * 5)

    if (jobs.length === 0) { _running = false; return }
    console.log(`[worker] drained ${jobs.length} jobs across ${LANES} lanes`)

    const lanes = Array.from({ length: LANES }, () => [])
    jobs.forEach((job, i) => lanes[i % LANES].push(job))

    await getBrowser()
    await Promise.all(lanes.map((jobs, i) => runLane(db, i + 1, jobs)))
  } catch (e) {
    console.error('[worker] drain error:', e)
  } finally {
    _running = false
  }
}

// --------------------------------------------------------------------------
// Agency manager loop (every 30 min)
// --------------------------------------------------------------------------
/**
 * Ask Jev what each active profile needs next, then enqueue the
 * corresponding automation job or task.
 *
 * Re-entrancy is guarded — if a previous run is still in flight when the
 * timer fires, we skip rather than stack up API calls against Jev.
 *
 * Idempotency is NOT enforced here: if the same profile still needs the same
 * next_action at the next 30-min tick, a second job will be queued. The
 * downstream workflows are expected to no-op when the work is already done
 * (e.g. police_certificate preflight will refuse a profile that already has
 * an in-flight job — see automations.js).
 */
export async function runAgencyManager(db) {
  if (_agencyRunning) {
    console.log('[agency] previous run still in flight — skipping')
    return
  }
  _agencyRunning = true
  const t0 = Date.now()

  try {
    // 1. Fetch active profiles with a file-name summary
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

    // 2. Ask Jev what each one needs
    const { decisions } = await decideAgencyActions(profiles)
    if (!Array.isArray(decisions)) {
      console.warn('[agency] decideAgencyActions returned no decisions array')
      return
    }

    // 3. Enqueue the right workflow / task for each decision
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

  console.log(`[worker] polling every ${POLL_MS}ms with ${LANES} lanes`)
  _interval = setInterval(() => {
    drainQueue(db).catch(e => console.error('[worker] poll error:', e))
  }, POLL_MS)

  console.log(`[worker] agency manager every ${AGENCY_INTERVAL_MS / 60000}min`)
  _agencyTimer = setInterval(() => {
    runAgencyManager(db).catch(e => console.error('[agency]', e))
  }, AGENCY_INTERVAL_MS)

  // Kick off once shortly after boot so we don't wait 30 min for the first pass.
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