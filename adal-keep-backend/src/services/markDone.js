/**
 * markDone.js — "mark as done" moves her to the next stage (asked on
 * 2026-11-21). One function for every "✔️ … saved" / "done" control: the
 * notification pop-ups, a paused run's button, a step's tick and a journey
 * step. The step is marked done at once (its run ends done, or a done entry is
 * written) and the profile fields her stage is read from are set, so the
 * stage and counts move on every PC and phone (each write is a "changed"
 * event, services/changes.js). Undone within a few minutes by its token (the
 * frontend's 5 s Undo).
 */
import { randomBytes } from 'crypto'
import { forgetRunTab } from './tabManager.js'
import { seal } from './accountVault.js'
import { musanedStep, newerStage } from './musanedStages.js'

// The journey steps (routes/automations.js journeyOf) and the run that makes each done.
export const STEP_WORKFLOW = {
  musaned: 'musaned_add_candidate', selected: 'musaned_check_chosen', wafid: 'wafid_check',
  epro: 'musaned_epro_approve', fmol: 'lmis_contract', insurance: 'insurance_certificate',
  tasheer: 'tasheer_schedule', embassy: 'mofa_visa', police: 'police_certificate',
  visa: null, arrived: null,
}
// Steps read from Musaned's contract stage: the stage that makes them done.
const STEP_STAGE = { epro: 'EPRO APPROVED', visa: 'VISA ISSUED', arrived: 'ARRIVED KSA' }
const GROUP = new Set(['insurance_certificate', 'tasheer_schedule'])
const FIELDS = ['status', 'visa_stage', 'visa_applied_at', 'musaned_stage', 'chosen_at']

const undos = new Map()         // token → { at, snap }
const KEEP_MS = 10 * 60000

/** The profile fields a done step sets (her stage is read from them). */
function effects(workflowId, step, p, now) {
  const set = {}
  const stage = (s) => { const n = newerStage(p.musaned_stage, s); if (n && musanedStep(n) > musanedStep(p.musaned_stage)) set.musaned_stage = n }
  switch (workflowId) {
    case 'wafid_book': if (!['medical_fit', 'medical_rejected'].includes(p.status)) set.status = 'medical_applied'; break
    case 'wafid_check': set.status = 'medical_fit'; break                       // "Medical done": FIT
    case 'mofa_visa': if (!/applied|paid|printed/i.test(p.visa_stage || '')) { set.visa_stage = 'Visa applied'; set.visa_applied_at = now } break
    case 'mofa_pay': if (!/paid|printed/i.test(p.visa_stage || '')) set.visa_stage = 'Visa paid'; break
    case 'musaned_epro_approve': stage(STEP_STAGE.epro); break
    case 'musaned_check_chosen': if (!p.chosen_at) set.chosen_at = now; break
  }
  if (STEP_STAGE[step]) stage(STEP_STAGE[step])
  return set
}

/** What a step being done starts next (in words); the Wafid slip after a booking. */
async function startsNext(db, workflowId, profileId) {
  try {
    if (workflowId === 'wafid_book') {
      try { const { queueWafidSlip } = await import('./wafidStatus.js'); await queueWafidSlip(db, profileId, 'booked') } catch {}
      return ' Status: Medical · Applied — Adal Keep checks the result on Wafid by itself.'
    }
    if (workflowId === 'wafid_check') return ' Medical: FIT.'
    if (workflowId === 'mofa_visa') return ' Visa stage: Visa applied.'
    if (workflowId === 'mofa_pay') return ' Visa stage: Visa paid.'
    if (workflowId === 'musaned_epro_approve') return ' EPRO approved.'
    if (workflowId === 'musaned_add_candidate') return ' Adal Keep now checks every 4 hours whether a Saudi employer chooses her.'
  } catch (e) { console.warn('[mark-done] next step:', e.message) }
  return ''
}

/**
 * Mark a step done and move her on. One of: runId (a paused run's "✔️ … saved"),
 * workflowId (a step's tick), step (a journey step: 'wafid', 'epro', 'visa' …).
 * Returns { ok, message, undo, profile_id, workflow_id }.
 */
export async function markStepDone(db, { profileId = null, workflowId = null, runId = null, step = null, note = 'done — marked by a person' } = {}) {
  const now = new Date().toISOString()
  let run = null
  if (runId) {
    run = await db('automation_queue').where('id', Number(runId)).first()
    if (!run) throw Object.assign(new Error('Run not found'), { status: 404 })
    if (run.status !== 'paused') throw Object.assign(new Error(`Run #${run.id} is ${run.status} — only a run waiting for you can be marked complete.`), { status: 409 })
    profileId = run.profile_id; workflowId = run.workflow_id
  }
  if (step) {
    if (!(step in STEP_WORKFLOW)) throw Object.assign(new Error(`"${step}" cannot be marked done here`), { status: 400 })
    workflowId = workflowId || STEP_WORKFLOW[step]
  }
  profileId = Number(profileId)
  const p = await db('profiles').where('id', profileId).first()
  if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 })
  const snap = { profiles: [], runs: [], maxRun: Number((await db('automation_queue').max('id as m').first())?.m || 0), profileIds: [profileId] }

  if (workflowId) {
    if (!run) run = await db('automation_queue').where({ profile_id: profileId, workflow_id: workflowId }).whereIn('status', ['pending', 'paused', 'running']).orderBy('id', 'desc').first()
    if (run?.status === 'running') throw Object.assign(new Error(`Run #${run.id} is working in its tab now — wait for it, or Cancel it first.`), { status: 409 })
    if (run) {
      try { forgetRunTab(run.id) } catch {}
      snap.runs.push({ id: run.id, before: { status: run.status, pause_reason: run.pause_reason, finished_at: run.finished_at } })
      await db('automation_queue').where('id', run.id).update({ status: 'done', pause_reason: runId ? null : 'Done by hand', finished_at: now, updated_at: now })
      // A group run (one certificate / one Tasheer appointment): everyone on it is done too.
      if (GROUP.has(workflowId)) {
        const members = await db('automation_queue').where({ status: 'paused', pause_reason: `with-run-${run.id}` }).select('id', 'profile_id', 'status', 'pause_reason', 'finished_at')
        for (const m of members) { snap.runs.push({ id: m.id, before: { status: m.status, pause_reason: m.pause_reason, finished_at: m.finished_at } }); snap.profileIds.push(m.profile_id) }
        if (members.length) await (await import('./insuranceCertificate.js')).settleMembers(db, run.id, 'done')
      }
    } else {
      const [id] = await db('automation_queue').insert({
        profile_id: profileId, workflow_id: workflowId, status: 'done', pause_reason: 'Done by hand', current_step: 0,
        context: seal('{}'), log: JSON.stringify([{ at: now, level: 'info', msg: 'Marked done by hand' }]), created_at: now, updated_at: now, finished_at: now,
      })
      run = { id: Number(id?.id ?? id), profile_id: profileId, workflow_id: workflowId }
      snap.runs.push({ id: run.id, inserted: true })
    }
  }

  const set = effects(workflowId, step, p, now)
  snap.profiles.push({ id: profileId, before: Object.fromEntries(FIELDS.map(k => [k, p[k] ?? null])) })
  if (Object.keys(set).length) await db('profiles').where('id', profileId).update({ ...set, updated_at: now })
  if (run) await noteLine(db, profileId, `${workflowId} (run #${run.id}) ${note}`)
  else await noteLine(db, profileId, `${step}: ${note}`)
  const next = workflowId ? await startsNext(db, workflowId, profileId) : ''

  const undo = randomBytes(9).toString('base64url')
  undos.set(undo, { at: Date.now(), snap })
  for (const [k, v] of undos) if (Date.now() - v.at > KEEP_MS) undos.delete(k)
  return { ok: true, undo, profile_id: profileId, workflow_id: workflowId, run_id: run?.id || null, message: `Marked done.${next}` }
}

/** Takes a "mark as done" back (its token, within 10 minutes). */
export async function undoMarkDone(db, token) {
  const u = undos.get(String(token || ''))
  if (!u) throw Object.assign(new Error('Too late to undo — tick it back by hand'), { status: 410 })
  undos.delete(String(token))
  const now = new Date().toISOString()
  const { snap } = u
  for (const r of snap.runs) {
    if (r.inserted) await db('automation_queue').where('id', r.id).update({ status: 'cancelled', pause_reason: 'Tick taken back', updated_at: now })
    else await db('automation_queue').where('id', r.id).update({ ...r.before, updated_at: now })
  }
  for (const p of snap.profiles) await db('profiles').where('id', p.id).update({ ...p.before, updated_at: now })
  // What marking it done started (the Wafid slip) goes again.
  await db('automation_queue').where('id', '>', snap.maxRun).whereIn('profile_id', snap.profileIds).where('status', 'pending')
    .update({ status: 'cancelled', pause_reason: 'Mark as done undone', finished_at: now, updated_at: now })
  for (const id of new Set(snap.profileIds)) await noteLine(db, id, '"mark as done" undone')
  return { ok: true, message: 'Undone — back where she was' }
}

async function noteLine(db, profileId, what) {
  try {
    const p = await db('profiles').where('id', profileId).first('notes')
    const line = `[${new Date().toISOString().slice(0, 10)}] ${what}`
    await db('profiles').where('id', profileId).update({ notes: p?.notes ? `${p.notes}\n${line}` : line, updated_at: new Date().toISOString() })
  } catch (e) { console.warn('[notes]', e.message) }
}

export const _undos = undos
