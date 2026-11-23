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
const FIELDS = ['status', 'visa_stage', 'visa_applied_at', 'musaned_stage', 'chosen_at', 'tasheer_ref', 'tasheer_date']

const undos = new Map()         // token → { at, snap }
const KEEP_MS = 10 * 60000
// An older Undo (its toast still showing) must not put back a state from before a
// later tick or untick of the same thing (asked on 2026-11-23): a later change still
// undoable that touched the same runs or the same fields of her profile wins.
let seq = 0
function keepUndo(snap, changed = []) {
  const undo = randomBytes(9).toString('base64url')
  undos.set(undo, { at: Date.now(), seq: ++seq, snap, changed: new Set(changed) })
  for (const [k, v] of undos) if (Date.now() - v.at > KEEP_MS) undos.delete(k)
  return undo
}
function newerOverlap(u) {
  const runs = new Set(u.snap.runs.map(r => r.id)), ids = new Set(u.snap.profileIds.map(Number))
  for (const v of undos.values()) {
    if (v.seq <= u.seq || !v.snap.profileIds.some(id => ids.has(Number(id)))) continue
    if (v.snap.runs.some(r => runs.has(r.id)) || [...v.changed].some(k => u.changed.has(k))) return true
  }
  return false
}
// One change per profile at a time: a double click, the pop-up and the status track
// at once, never interleave their reads and writes.
const chains = new Map()
export function oneAtATime(profileId, fn) {
  const key = Number(profileId) || 0
  const prev = chains.get(key) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}

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
export async function markStepDone(db, opts = {}) {
  let pid = opts.profileId
  if (opts.runId && !pid) pid = (await db('automation_queue').where('id', Number(opts.runId)).first('profile_id'))?.profile_id
  return oneAtATime(pid, () => markStepDoneNow(db, opts))
}
async function markStepDoneNow(db, { profileId = null, workflowId = null, runId = null, step = null, note = 'done — marked by a person' } = {}) {
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
    } else if ((await db('automation_queue').where({ profile_id: profileId, workflow_id: workflowId }).orderBy('id', 'desc').first('id', 'status'))?.status === 'done') {
      // Already done (a second click): no second "Done by hand" row — one untick must take it back.
      run = null
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
  else if (workflowId) { /* already done: nothing new to note */ }
  else await noteLine(db, profileId, `${step}: ${note}`)
  const next = workflowId && snap.runs.length ? await startsNext(db, workflowId, profileId) : ''

  const undo = keepUndo(snap, Object.keys(set))
  return { ok: true, undo, profile_id: profileId, workflow_id: workflowId, run_id: run?.id || null, message: `Marked done.${next}` }
}


// ── Unchecking: a done step goes back to open, and so does everything after it ──
// The line Musaned-driven steps follow (musaned_stage); a step reopened caps it here (-1 = none).
const STAGE_NAMES = ['EPRO APPROVAL', 'EPRO APPROVED', 'FMOL APPROVAL', 'FMOL APPROVED', 'SENT TO THE SAUDI EMBASSY', 'VISA ISSUED', 'ARRIVED KSA']
const LINE = ['musaned', 'selected', 'wafid', 'epro', 'insurance', 'fmol', 'embassy', 'visa', 'arrived']
const CAP = { musaned: -1, selected: -1, wafid: 0, epro: 0, insurance: 1, fmol: 2, embassy: 3, visa: 4, arrived: 5 }
// The runs that made each step done (cancelled when it is unchecked; nothing is deleted).
const STEP_RUNS = { musaned: ['musaned_add_candidate'], selected: ['musaned_check_chosen'], wafid: ['wafid_book', 'wafid_check'], epro: ['musaned_epro_approve'],
  insurance: ['insurance_certificate'], fmol: ['lmis_contract'], embassy: ['mofa_visa', 'mofa_pay'], tasheer: ['tasheer_schedule'], police: ['police_certificate'] }
export const UNDONE_STEPS = [...LINE, 'tasheer', 'police']

/**
 * Uncheck a done step: she goes back to that stage and every later step is open again.
 * Only the fields her stage is read from change (the old values go in her notes and the
 * undo token); documents, photos, numbers and every run's log stay. By: the employee's name.
 */
export async function markStepUndone(db, opts = {}) {
  return oneAtATime(opts.profileId, () => markStepUndoneNow(db, opts))
}
async function markStepUndoneNow(db, { profileId, step, employee = null } = {}) {
  if (step === 'cv') throw Object.assign(new Error('Her CV is a document: delete it from her Generated CVs if it is wrong'), { status: 400 })
  if (!UNDONE_STEPS.includes(step)) throw Object.assign(new Error(`"${step}" cannot be unchecked here`), { status: 400 })
  profileId = Number(profileId)
  const p = await db('profiles').where('id', profileId).first()
  if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 })
  const now = new Date().toISOString()
  const snap = { profiles: [], runs: [], maxRun: Number((await db('automation_queue').max('id as m').first())?.m || 0), profileIds: [profileId] }
  const steps = step === 'tasheer' || step === 'police' ? [step] : LINE.slice(LINE.indexOf(step))
  const set = {}
  let cap = 99
  for (const k of steps) {
    cap = Math.min(cap, CAP[k] ?? 99)
    if (k === 'selected' || k === 'musaned') set.chosen_at = null
    if (k === 'wafid' && ['medical_fit', 'medical_applied', 'medical_rejected'].includes(p.status)) set.status = null
    if (k === 'embassy' || k === 'visa' || k === 'arrived') { if (p.visa_stage) set.visa_stage = null; if (p.visa_applied_at) set.visa_applied_at = null }
    if (k === 'tasheer') { if (p.tasheer_ref) set.tasheer_ref = null; if (p.tasheer_date) set.tasheer_date = null }
  }
  if (cap < 99 && musanedStep(p.musaned_stage) > cap) set.musaned_stage = cap < 0 ? null : STAGE_NAMES[cap]
  if (cap < 0 && p.musaned_stage && musanedStep(p.musaned_stage) < 0 && !/CANCEL|REJECT/i.test(p.musaned_stage)) set.musaned_stage = null
  for (const k of steps) {
    const ids = STEP_RUNS[k] || []
    if (!ids.length) continue
    for (const r of await db('automation_queue').where({ profile_id: profileId, status: 'done' }).whereIn('workflow_id', ids).select('id', 'status', 'pause_reason', 'finished_at')) {
      snap.runs.push({ id: r.id, before: { status: r.status, pause_reason: r.pause_reason, finished_at: r.finished_at } })
      await db('automation_queue').where('id', r.id).update({ status: 'cancelled', pause_reason: 'Tick taken back', updated_at: now })
    }
  }
  const before = Object.fromEntries(FIELDS.map(k => [k, p[k] ?? null]))
  snap.profiles.push({ id: profileId, before })
  const had = Object.keys(set).filter(k => before[k] != null && before[k] !== '').map(k => `${k}=${before[k]}`).join(', ')
  if (Object.keys(set).length) await db('profiles').where('id', profileId).update({ ...set, updated_at: now })
  const who = employee?.name || 'someone'
  await noteLine(db, profileId, `${step}: unchecked by ${who} — back at this stage; later steps open again${had ? ` (was ${had})` : ''}`)
  const undo = keepUndo(snap, Object.keys(set))
  return { ok: true, undo, profile_id: profileId, step, message: 'Unchecked — she is back at this step. Her documents and data are kept.' }
}

/** Takes a "mark as done" back (its token, within 10 minutes). */
export async function undoMarkDone(db, token) {
  const u = undos.get(String(token || ''))
  if (!u) throw Object.assign(new Error('Too late to undo — tick it back by hand'), { status: 410 })
  return oneAtATime(u.snap.profileIds[0], () => undoNow(db, String(token)))
}
async function undoNow(db, token) {
  const u = undos.get(token)
  if (!u) throw Object.assign(new Error('Already undone'), { status: 410 })
  if (newerOverlap(u)) throw Object.assign(new Error('She was changed again since — tick or untick it by hand'), { status: 409 })
  undos.delete(token)
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

// The fields a tick by hand set, taken back with it (only when they still say what the tick wrote).
const UNTICK = {
  wafid_book: (p) => p.status === 'medical_applied' ? { status: null } : {},
  wafid_check: (p) => p.status === 'medical_fit' ? { status: null } : {},
  mofa_visa: (p) => p.visa_stage === 'Visa applied' ? { visa_stage: null, visa_applied_at: null } : {},
  mofa_pay: (p) => p.visa_stage === 'Visa paid' ? { visa_stage: 'Visa applied' } : {},
  musaned_check_chosen: (p) => p.chosen_at ? { chosen_at: null } : {},
}

/**
 * A tick made by hand taken back (the checkbox on a step's card): every "Done by
 * hand" row of that step is cancelled (a double click made two), and what the
 * tick set on her profile goes back. With an Undo token like the rest.
 */
export async function untickByHand(db, { profileId, workflowId } = {}) {
  return oneAtATime(profileId, async () => {
    profileId = Number(profileId)
    const p = await db('profiles').where('id', profileId).first()
    if (!p) throw Object.assign(new Error('Profile not found'), { status: 404 })
    const latest = await db('automation_queue').where({ profile_id: profileId, workflow_id: workflowId }).orderBy('id', 'desc').first()
    if (!latest || latest.status !== 'done' || latest.pause_reason !== 'Done by hand') {
      if (latest && latest.status !== 'done') return { ok: true, profile_id: profileId, message: 'Not done any more' }
      throw Object.assign(new Error('Only a step ticked by hand can be unticked'), { status: 409 })
    }
    const now = new Date().toISOString()
    const snap = { profiles: [], runs: [], maxRun: Number((await db('automation_queue').max('id as m').first())?.m || 0), profileIds: [profileId] }
    for (const r of await db('automation_queue').where({ profile_id: profileId, workflow_id: workflowId, status: 'done', pause_reason: 'Done by hand' }).select('id', 'status', 'pause_reason', 'finished_at')) {
      snap.runs.push({ id: r.id, before: { status: r.status, pause_reason: r.pause_reason, finished_at: r.finished_at } })
      await db('automation_queue').where('id', r.id).update({ status: 'cancelled', pause_reason: 'Tick taken back', updated_at: now })
    }
    const set = UNTICK[workflowId]?.(p) || {}
    snap.profiles.push({ id: profileId, before: Object.fromEntries(FIELDS.map(k => [k, p[k] ?? null])) })
    if (Object.keys(set).length) await db('profiles').where('id', profileId).update({ ...set, updated_at: now })
    await noteLine(db, profileId, `${workflowId}: tick taken back`)
    return { ok: true, undo: keepUndo(snap, Object.keys(set)), profile_id: profileId, message: 'Not done any more' }
  })
}

async function noteLine(db, profileId, what) {
  try {
    const p = await db('profiles').where('id', profileId).first('notes')
    const line = `[${new Date().toISOString().slice(0, 10)}] ${what}`
    await db('profiles').where('id', profileId).update({ notes: p?.notes ? `${p.notes}\n${line}` : line, updated_at: new Date().toISOString() })
  } catch (e) { console.warn('[notes]', e.message) }
}

export const _undos = undos
