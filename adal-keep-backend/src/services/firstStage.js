/**
 * firstStage.js — "when ever any profile is on the 1st stage, the system will
 * do everything it can to make her go to the next as fast as possible"
 * (asked on 2026-11-19). Every scan (2 minutes):
 *
 *   1. CV stage, everything a CV needs is there (broker, photo and full body
 *      photo on this PC, religion, marital status) and she has no CV yet →
 *      her CV is made with the agency's first CV template, by itself.
 *   2. She has a CV and is not on Musaned yet, Musaned has all it needs
 *      (photo, mobile, passport…) and there is a Musaned account →
 *      "Musaned: Add candidate" is queued once (it waits while Adal Browser
 *      is closed, like the other robots nobody pressed).
 *
 * Never twice: a girl whose CV could not be made is left for an hour; a girl
 * with any Musaned run before (done, failed, cancelled, stopped) is not queued
 * again by itself: a person presses the button. Only girls added from 3 days before it first ran (first_stage_since).
 * Settings key first_stage_auto = '0' turns it off.
 */
import { seal } from './accountVault.js'
import { goneFromMusaned } from './runOutcome.js'
import { isChosen } from './chosen.js'

const PER_SCAN = 3                 // CVs made per scan (a PDF each: keep the PC free)
const CV_RETRY_MS = 60 * 60 * 1000
const triedCv = new Map()          // profile id → when her CV could not be made

/** Is everything her CV needs there? (the same list as the CV page's readiness) */
export function cvBlockers(p, { hasPhoto, hasFullBody }) {
  const out = []
  if (!p.broker_id) out.push('Broker not assigned')
  if (!hasPhoto) out.push('Photo missing')
  if (!hasFullBody) out.push('Full body photo missing')
  if (!String(p.religion || '').trim()) out.push('Religion missing')
  if (!String(p.marital_status || '').trim()) out.push('Marital status missing')
  return out
}

/** Should Musaned: Add candidate be queued for her? (runs: latest run per workflow) */
export function wantsMusaned(p, runs = {}, hasCv = false) {
  if (!hasCv) return false
  // Chosen already (Musaned's date, or her employer's contract on her profile): never back to Musaned.
  if (p.musaned_stage || isChosen(p)) return false
  const r = runs.musaned_add_candidate
  if (r) {
    // One agent, one try: in line, working, waiting, done, failed, cancelled or stopped by the 10-minute
    // limit — never put in line again by itself (a stopped run came back 2 minutes later, for ever). A person presses it.
    return false
  }
  if (goneFromMusaned(runs)) return false
  return true
}

async function enabled(db) {
  const row = await db('settings').where('key', 'first_stage_auto').first().catch(() => null)
  return String(row?.value ?? '1') !== '0'
}

/**
 * From when: girls added since 3 days before this first ran on the PC (kept in
 * settings first_stage_since). The old ones (hundreds, many long gone) are
 * never sent to Musaned by themselves — only by a button.
 */
export async function sinceOf(db, now = Date.now()) {
  const row = await db('settings').where('key', 'first_stage_since').first().catch(() => null)
  if (row?.value) return row.value
  const since = new Date(now - 3 * 24 * 3600e3).toISOString().slice(0, 10)   // a day: both date formats compare
  try { await db('settings').insert({ key: 'first_stage_since', value: since }) } catch {}
  return since
}

async function latestRuns(db, ids) {
  const out = new Map()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db('automation_queue').whereIn('profile_id', ids.slice(i, i + 500))
      .orderBy('id', 'asc').select('id', 'profile_id', 'workflow_id', 'status', 'pause_reason', 'updated_at')
    for (const r of rows) {
      if (!out.has(r.profile_id)) out.set(r.profile_id, {})
      out.get(r.profile_id)[r.workflow_id] = r
    }
  }
  return out
}

async function withCvIds(db, ids) {
  const out = new Set()
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500)
    for (const r of await db('generated_cvs').whereIn('profile_id', part).distinct('profile_id')) out.add(r.profile_id)
    const files = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .whereIn('profile_fields.profile_id', part).andWhere('profile_fields.name', 'CV').distinct('profile_fields.profile_id as id')
    for (const r of files) out.add(r.id)
  }
  return out
}

/** One pass. Returns { cvs, musaned } — how many CVs were made and Musaned runs queued. */
export async function pushFirstStage(db, { log = console.log } = {}) {
  const done = { cvs: 0, musaned: 0 }
  if (!(await enabled(db))) return done
  // The first stage: not chosen and not on Musaned yet.
  const since = await sinceOf(db)
  const profiles = await db('profiles').whereNull('chosen_at').where('created_at', '>=', since)
    .where(q => q.whereNull('musaned_stage').orWhere('musaned_stage', ''))
    .select('id', 'full_name', 'broker_id', 'religion', 'marital_status', 'musaned_stage', 'chosen_at', 'photo_path',
      'passport_number', 'phone_number', 'date_of_birth', 'nationality', 'gender', 'contract_number', 'visa_number', 'employer_id')
  if (!profiles.length) return done
  const ids = profiles.map(p => p.id)
  const hasCv = await withCvIds(db, ids)
  const runs = await latestRuns(db, ids)

  // 1. Her CV, by itself.
  const template = await db('cv_templates').where('is_active', 1).orderBy('id').first().catch(() => null)
  if (template) {
    const { hasProfilePicture, resolveStoredPath } = await import('./cvRender.js')
    for (const p of profiles) {
      if (done.cvs >= PER_SCAN) break
      if (hasCv.has(p.id)) continue
      if (Date.now() - (triedCv.get(p.id) || 0) < CV_RETRY_MS) continue
      const hasPhoto = (await hasProfilePicture(db, p.id, 'Photo')) || (!!p.photo_path && !!resolveStoredPath(p.photo_path))
      const hasFullBody = await hasProfilePicture(db, p.id, 'Full Body Photo')
      if (cvBlockers(p, { hasPhoto, hasFullBody }).length) continue
      try {
        const { generateCvFile } = await import('../routes/cv.js')
        const made = await generateCvFile(db, await db('profiles').where('id', p.id).first(), template, {}, 'auto')
        hasCv.add(p.id)
        done.cvs++
        log(`[first-stage] ✓ CV made for ${p.full_name} (#${p.id}): ${made.original_name}`)
      } catch (e) {
        triedCv.set(p.id, Date.now())
        log(`[first-stage] CV for ${p.full_name} (#${p.id}) not made: ${e.message}`)
      }
    }
  }

  // 2. Musaned: Add candidate, by itself.
  const acct = await db('musaned_accounts').orderBy('is_default', 'desc').first().catch(() => null)
  if (!acct) return done
  const { musanedMissing, photoOnFile } = await import('./musanedPreflight.js')
  for (const p of profiles) {
    if (!wantsMusaned(p, runs.get(p.id) || {}, hasCv.has(p.id))) continue
    const full = await db('profiles').where('id', p.id).first()
    const missing = musanedMissing(full, await photoOnFile(db, p.id)).filter(m => !/^(marital status|religion)$/.test(m))
    if (missing.length) continue
    const now = new Date().toISOString()
    await db('automation_queue').insert({
      profile_id: p.id, workflow_id: 'musaned_add_candidate', account_id: acct.id,
      status: 'pending', current_step: 0,
      context: seal(JSON.stringify({ musaned_username: acct.username, musaned_password: acct.password, musaned_name: acct.name, account_id: acct.id })),
      log: JSON.stringify([{ ts: Date.now(), level: 'info', msg: 'Auto-discovered by scanner — first stage: her CV is made, so she goes on Musaned' }]),
      created_at: now, updated_at: now,
    })
    done.musaned++
    log(`[first-stage] ✓ Musaned: Add candidate queued for ${p.full_name} (#${p.id})`)
  }
  return done
}
