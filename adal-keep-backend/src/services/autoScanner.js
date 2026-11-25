/**
 * autoScanner.js — the "works all day" piece.
 *
 * Every 2 minutes, scans every profile. For each one that satisfies
 * the police-clearance trigger conditions, it enqueues a job — but only
 * if she never had such a job (one try: a person starts it again). This means the system keeps discovering new work as files
 * arrive, without any user action.
 *
 * LMIS contract (lmis_contract): chosen by an employer on Musaned
 * (profiles.chosen_at) + Wafid FIT (status medical_fit) + labor_id.
 *
 * Trigger conditions for a Kuwait police clearance:
 *   - profiles.destination_country === 'Kuwait'
 *   - profiles.labor_id present
 *   - profiles.order_id present
 *   - Files exist for: Passport, Photo, Full Body Photo, Slip
 *   - No active/completed police_certificate job
 */

import { isAppLocked } from './subscription.js'
import { seal } from './accountVault.js'

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

  // All four required files exist: one query per 500 profiles, not one per
  // profile every 2 minutes (hundreds of joins on a slow disk).
  const needed = ['Passport', 'Photo', 'Full Body Photo', 'Slip']
  const full = new Set()
  for (let i = 0; i < profiles.length; i += 500) {
    const rows = await db('files')
      .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .whereIn('profile_fields.profile_id', profiles.slice(i, i + 500).map(p => p.id))
      .whereIn('profile_fields.name', needed)
      .groupBy('profile_fields.profile_id')
      .havingRaw('count(distinct profile_fields.name) = ?', [needed.length])
      .select('profile_fields.profile_id as id')
    for (const r of rows) full.add(r.id)
  }
  return profiles.filter(p => full.has(p.id))
}

async function isAlreadyQueued(db, profileId, workflowId = WORKFLOW_ID) {
  // One try: any run of hers, however it ended (a run stopped at 10 minutes is
  // 'cancelled'), and none is queued by itself again — a person presses it.
  const row = await db('automation_queue').where({ profile_id: profileId, workflow_id: workflowId }).first('id')
  return !!row
}

/**
 * LMIS contract: an employer chose her on Musaned (chosen_at, set by the
 * contract check) and Wafid says FIT (status medical_fit), and she has a
 * Labor ID → "Create LMIS contract" is queued once.
 */
async function findContractReady(db) {
  return db('profiles')
    .whereNotNull('chosen_at')
    .where('status', 'medical_fit')
    .whereNotNull('labor_id').whereNot('labor_id', '')
    .select('id', 'full_name', 'labor_id')
}

async function getDefaultAccount(db) {
  return await db('lmis_accounts').orderBy('is_default', 'desc').first()
}

/**
 * Insurance certificate back from FetaP (asked on 2026-11-19): a day after her
 * insurance was requested and while no certificate is on her profile, "Get
 * insurance certificate" is queued — at most every 6 hours, for 10 days.
 */
export async function queueInsuranceFetch(db, now = Date.now()) {
  const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString()
  const tenDays = new Date(now - 10 * 24 * 3600 * 1000).toISOString()
  const sixHours = new Date(now - 6 * 3600 * 1000).toISOString()
  const asked = await db('automation_queue').where('workflow_id', 'insurance_certificate')
    .where(function () { this.where('status', 'done').orWhere('status', 'paused') })
    .where('created_at', '<=', dayAgo).where('created_at', '>=', tenDays)
    .distinct('profile_id').pluck('profile_id').catch(() => [])
  if (!asked.length) return 0
  const acct = await db('insurance_accounts').orderBy('is_default', 'desc').first().catch(() => null)
  if (!acct) return 0
  let queued = 0
  for (const profileId of asked) {
    const hasCert = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
      .where({ 'profile_fields.profile_id': profileId, 'profile_fields.name': 'Insurance' }).first('files.id').catch(() => null)
    if (hasCert) continue
    const recent = await db('automation_queue').where({ profile_id: profileId, workflow_id: 'insurance_fetch' })
      .where(function () { this.whereIn('status', ['pending', 'running', 'paused']).orWhere('updated_at', '>', sixHours) })
      .first().catch(() => null)
    if (recent) continue
    const ts = new Date(now).toISOString()
    await db('automation_queue').insert({
      profile_id: profileId, workflow_id: 'insurance_fetch', account_id: acct.id, status: 'pending', current_step: 0,
      context: seal(JSON.stringify({ insurance_username: acct.username, insurance_password: acct.password, insurance_name: acct.name, account_id: acct.id })),
      log: JSON.stringify([{ ts: now, level: 'info', msg: 'Auto: her insurance was requested a day ago — fetching the certificate from FetaP' }]),
      created_at: ts, updated_at: ts,
    })
    queued++
  }
  return queued
}

async function scanOnce(db) {
  if (isAppLocked()) return
  try {
    if (await queueInsuranceFetch(db).catch(e => { console.warn('[scanner] insurance fetch:', e.message); return 0 })) {
      import('./worker.js').then(({ drainQueue }) => drainQueue(db).catch(() => {}))
    }
    // The first stage moves by itself: her CV, then Musaned (firstStage.js).
    try {
      const { pushFirstStage } = await import('./firstStage.js')
      const moved = await pushFirstStage(db)
      if (moved.musaned) import('./worker.js').then(({ drainQueue }) => drainQueue(db).catch(() => {}))
    } catch (e) { console.warn('[scanner] first stage:', e.message) }
    const ready = (await findReadyProfiles(db)).map(p => ({ ...p, wf: WORKFLOW_ID, why: 'Kuwait + labor_id + order_id + all 4 files present' }))
    if (ready.length === 0) return

    const account = await getDefaultAccount(db)
    if (!account) {
      console.log('[scanner] profiles are ready but no LMIS account configured')
      return
    }

    let enqueued = 0
    for (const p of ready) {
      if (await isAlreadyQueued(db, p.id, p.wf)) continue

      const accountContext = {
        login_value: account.login_value || account.phone || '',
        login_password: account.password || '',
        account_name: account.name,
        account_id: account.id,
      }

      await db('automation_queue').insert({
        profile_id: p.id,
        workflow_id: p.wf,
        account_id: account.id,
        status: 'pending',
        current_step: 0,
        context: seal(JSON.stringify(accountContext)),
        log: JSON.stringify([{
          ts: Date.now(),
          level: 'info',
          msg: `Auto-discovered by scanner — ${p.why}`,
        }]),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      enqueued++
      console.log(`[scanner] ✓ enqueued ${p.wf} for profile ${p.id} (${p.full_name})`)
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