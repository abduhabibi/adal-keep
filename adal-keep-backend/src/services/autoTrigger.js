/**
 * autoTrigger.js
 *
 * Watches profiles for the exact conditions that mean "this profile is
 * ready for a police-clearance submission", and enqueues the workflow
 * automatically — no button clicks required.
 *
 * Conditions for Kuwait police clearance:
 *   1. profiles.destination_country === 'Kuwait'
 *   2. profiles.labor_id is non-empty
 *   3. profiles.order_id is non-empty (auto-extracted from the slip)
 *   4. Files present for: Passport, Photo, Full Body Photo, Slip
 *   5. No existing police_certificate run for this profile
 *
 * Called from:
 *   - PUT /api/profiles/:id              (fields changed)
 *   - POST /profiles/:id/fields/:fid/files  (multi-file upload)
 *   - POST /profiles/:id/fields/:fid/upload (single-file upload)
 */

import path from 'path'
import fs from 'fs'
import { analyzeDocumentSmart } from './mineruAnalyzer.js'
import { assertPoliceReady } from './verification.js'

const POLICE_WORKFLOW = 'police_certificate'
const KUWAIIT_COUNTRY = 'kuwait'

// The four files required before police clearance can start
const REQUIRED_FILES = ['Passport', 'Photo', 'Full Body Photo', 'Slip']

// ============================================================================
// Called after any file upload. If the field is "Slip", runs vision to pull
// out the Order ID. Then checks the whole profile for auto-trigger readiness.
// ============================================================================
export async function onFilesUploaded(db, profileId, fieldName, filePaths = []) {
  try {
    if (/slip/i.test(fieldName)) {
      await extractOrderIdFromSlip(db, profileId, filePaths)
    }
    return await checkAutoTrigger(db, profileId, `upload:${fieldName}`)
  } catch (e) {
    console.error('[autoTrigger] hook error:', e.message)
    return { triggered: false, reason: e.message }
  }
}

// ============================================================================
// Called after any profile field edit (labor_id, destination_country, etc.)
// ============================================================================
export async function onProfileUpdated(db, profileId) {
  try {
    return await checkAutoTrigger(db, profileId, 'profile-update')
  } catch (e) {
    console.error('[autoTrigger] profile hook error:', e.message)
    return { triggered: false, reason: e.message }
  }
}

// ============================================================================
// Extract Order ID + Reference Name from a slip using DeepSeek vision.
// Only runs if the profile doesn't already have an order_id.
// ============================================================================
async function extractOrderIdFromSlip(db, profileId, filePaths) {
  const profile = await db('profiles').where('id', profileId).first()
  if (!profile) return

  // Skip if we already have an order_id — don't overwrite it with a re-upload
  if (profile.order_id && String(profile.order_id).trim()) {
    console.log('[autoTrigger] order_id already present on profile', profileId, '— skipping vision')
    return
  }

  // Pick the first file that vision can read
  const candidate = filePaths.find(p => /\.(jpe?g|png|webp|pdf)$/i.test(p))
  if (!candidate || !fs.existsSync(candidate)) {
    console.warn('[autoTrigger] no readable slip file found')
    return
  }

  let mime = 'image/jpeg'
  if (/\.png$/i.test(candidate)) mime = 'image/png'
  else if (/\.pdf$/i.test(candidate)) mime = 'application/pdf'

  console.log('[autoTrigger] extracting Order ID from slip:', path.basename(candidate))

  let result
  try {
    result = await analyzeDocumentSmart(candidate, path.basename(candidate), mime)
  } catch (e) {
    console.warn('[autoTrigger] vision failed:', e.message)
    return
  }

  const fields = result?.fields || {}
  const orderId = String(fields.order_id || '').trim()
  const refName = String(fields.reference_name || '').trim()

  if (orderId) {
    await db('profiles').where('id', profileId).update({
      order_id: orderId,
      updated_at: new Date().toISOString(),
    })
    console.log(`[autoTrigger] ✓ stored order_id "${orderId}" on profile ${profileId}`)
  } else {
    console.warn('[autoTrigger] vision did not return an order_id — check the slip OCR')
  }

  if (refName) {
    console.log(`[autoTrigger] slip reference_name: "${refName}" (current profile: "${profile.full_name}")`)
  }
}

// ============================================================================
// The main check. Returns { ready, triggered, reason, runId? }.
// Idempotent — safe to call 100 times per minute.
// ============================================================================
export async function checkAutoTrigger(db, profileId, trigger = 'unknown') {
  const profile = await db('profiles').where('id', profileId).first()
  if (!profile) return { ready: false, triggered: false, reason: 'profile not found' }

  const dest = String(profile.destination_country || '').trim().toLowerCase()
  if (dest !== KUWAIIT_COUNTRY) {
    return { ready: false, triggered: false, reason: `destination_country is "${profile.destination_country || '(empty)'}" — only Kuwait auto-triggers` }
  }

  if (!profile.labor_id || !String(profile.labor_id).trim()) {
    return { ready: false, triggered: false, reason: 'labor_id missing' }
  }

  if (!profile.order_id || !String(profile.order_id).trim()) {
    return { ready: false, triggered: false, reason: 'order_id not yet extracted from slip' }
  }

  // Check required files
  const missing = []
  for (const name of REQUIRED_FILES) {
    const row = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .andWhere('profile_fields.name', name)
      .first()
    if (!row) missing.push(name)
  }
  if (missing.length) {
    return { ready: false, triggered: false, reason: `missing files: ${missing.join(', ')}` }
  }

  // ── HARD GATE: the passport must be 3/3 green ticks ───────────────────
  // A file merely *existing* proves nothing — the employee could have
  // photographed a blank page. Verification (MinerU/pdf-text/tesseract read
  // + all TD3 fields + MRZ check digits) is what unlocks police clearance,
  // so the automation never starts on a document we could not prove.
  const gate = await assertPoliceReady(profileId, { handle: db })
  if (!gate.ok) {
    return {
      ready: false,
      triggered: false,
      ticks: gate.ticks,
      reason: `verification gate ${gate.ticks}/3: ${gate.blockers.join('; ')}`,
    }
  }

  // Already queued?
  const existing = await db('automation_queue')
    .where({ profile_id: profileId, workflow_id: POLICE_WORKFLOW })
    .whereIn('status', ['pending', 'running', 'paused', 'done'])
    .orderBy('id', 'desc')
    .first()
  if (existing) {
    return { ready: true, triggered: false, reason: 'already queued', runId: existing.id, status: existing.status }
  }

  // A run that just failed (LMIS blocked it, or the portal erred) is not retried
  // automatically: every try logs into the government portal again.
  const recentFailure = await db('automation_queue')
    .where({ profile_id: profileId, workflow_id: POLICE_WORKFLOW, status: 'failed' })
    .where('updated_at', '>', new Date(Date.now() - 12 * 3600 * 1000).toISOString())
    .first()
  if (recentFailure) {
    return { ready: true, triggered: false, reason: 'last police run failed within 12 hours — not auto-retried', runId: recentFailure.id }
  }

  // Need an LMIS account
  const account = await db('lmis_accounts').orderBy('is_default', 'desc').first()
  if (!account) {
    return { ready: false, triggered: false, reason: 'no LMIS account configured' }
  }

  const accountContext = {
    login_value: account.login_value || account.phone || '',
    login_password: account.password || '',
    account_name: account.name,
    account_id: account.id,
  }

  const [runId] = await db('automation_queue').insert({
    profile_id: profileId,
    workflow_id: POLICE_WORKFLOW,
    account_id: account.id,
    status: 'pending',
    current_step: 0,
    context: JSON.stringify(accountContext),
    log: JSON.stringify([{
      ts: Date.now(),
      level: 'info',
      msg: `Auto-triggered by ${trigger} — Kuwait police clearance ready`,
    }]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })

  console.log(`[autoTrigger] ✓✓ ENQUEUED ${POLICE_WORKFLOW} for profile ${profileId} (run #${runId}) via ${trigger}`)

  // Kick the worker immediately
  try {
    const { drainQueue } = await import('./worker.js')
    drainQueue(db).catch(() => {})
  } catch {}

  return { ready: true, triggered: true, reason: 'queued', runId }
}