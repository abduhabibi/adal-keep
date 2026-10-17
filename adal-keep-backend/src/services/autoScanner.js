/**
 * autoScanner.js — the "works all day" piece.
 *
 * Every 2 minutes, scans every profile. For each one that satisfies
 * the police-clearance trigger conditions, it enqueues a job — but only
 * if there isn't already a pending/running/paused/done job for that
 * profile. This means the system keeps discovering new work as files
 * arrive, without any user action.
 *
 * Trigger conditions for a Kuwait police clearance:
 *   - profiles.destination_country === 'Kuwait'
 *   - profiles.labor_id present
 *   - profiles.order_id present
 *   - Files exist for: Passport, Photo, Full Body Photo, Slip
 *   - No active/completed police_certificate job
 */

const SCAN_INTERVAL_MS = 2 * 60 * 1000        // 2 minutes
const WORKFLOW_ID = 'police_certificate'

let _interval = null

async function findReadyProfiles(db) {
  // Candidates: Kuwait + labor_id + order_id present
  const profiles = await db('profiles')
    .where('destination_country', 'Kuwait')
    .whereNotNull('labor_id')
    .whereNotNull('order_id')
    .whereNot('labor_id', '')
    .whereNot('order_id', '')
    .select('id', 'full_name', 'labor_id', 'order_id')

  const ready = []
  for (const p of profiles) {
    // Check all four required files exist
    const needed = ['Passport', 'Photo', 'Full Body Photo', 'Slip']
    const have = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', p.id)
      .whereIn('profile_fields.name', needed)
      .groupBy('profile_fields.name')
      .select('profile_fields.name')
    const haveSet = new Set(have.map(r => r.name))
    if (needed.every(n => haveSet.has(n))) ready.push(p)
  }
  return ready
}

async function isAlreadyQueued(db, profileId) {
  // Block re-enqueue if there is any active OR recently-failed OR done run.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const row = await db('automation_queue')
    .where({ profile_id: profileId, workflow_id: WORKFLOW_ID })
    .andWhere(function () {
      this.whereIn('status', ['pending', 'running', 'paused', 'done'])
        .orWhere(function () {
          this.where('status', 'failed').andWhere('updated_at', '>', twoHoursAgo)
        })
    })
    .first()
  return !!row
}

async function getDefaultAccount(db) {
  return await db('lmis_accounts').orderBy('is_default', 'desc').first()
}

async function scanOnce(db) {
  try {
    const ready = await findReadyProfiles(db)
    if (ready.length === 0) return

    const account = await getDefaultAccount(db)
    if (!account) {
      console.log('[scanner] profiles are ready but no LMIS account configured')
      return
    }

    let enqueued = 0
    for (const p of ready) {
      if (await isAlreadyQueued(db, p.id)) continue

      const accountContext = {
        login_value: account.login_value || account.phone || '',
        login_password: account.password || '',
        account_name: account.name,
        account_id: account.id,
      }

      await db('automation_queue').insert({
        profile_id: p.id,
        workflow_id: WORKFLOW_ID,
        account_id: account.id,
        status: 'pending',
        current_step: 0,
        context: JSON.stringify(accountContext),
        log: JSON.stringify([{
          ts: Date.now(),
          level: 'info',
          msg: `Auto-discovered by scanner — Kuwait + labor_id + order_id + all 4 files present`,
        }]),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      enqueued++
      console.log(`[scanner] ✓ enqueued ${WORKFLOW_ID} for profile ${p.id} (${p.full_name})`)
    }

    if (enqueued > 0) {
      // wake worker immediately
      const { drainQueue } = await import('./worker.js')
      drainQueue(db).catch(() => {})
    }
  } catch (e) {
    console.error('[scanner] scan error:', e.message)
  }
}

export function startScanner(db) {
  if (_interval) return
  console.log(`[scanner] starting, scanning every ${SCAN_INTERVAL_MS / 1000}s`)
  // Initial scan 30s after boot, then every SCAN_INTERVAL_MS
  setTimeout(() => scanOnce(db), 30 * 1000)
  _interval = setInterval(() => scanOnce(db), SCAN_INTERVAL_MS)
}

export function stopScanner() {
  if (_interval) clearInterval(_interval)
  _interval = null
}

export { scanOnce }