/**
 * wafidStatus.js — Wafid booking queue + the medical result checker.
 *
 *   queueWafidBooking(db, profileId)  a "Book Wafid medical" run (the button,
 *                                     or by itself once an employer chose her)
 *   checkAll(db)                      every "Medical · Applied" profile is
 *                                     looked up on wafid.com: FIT → Medical ·
 *                                     Fit, UNFIT → Medical · Rejected
 *   startWafidChecker()               nothing: the daily check of the Wafid tab (working
 *                                     hours, one PC of the agency) is in selectionCheck.js
 */
import { getBrowser, openBrowserIfAny } from './browser.js'
import { setupTab, borrowTab, doneWithTab, activeRunIds } from './tabManager.js'
import { checkMedicalStatus, downloadResultPdf } from './wafidWorkflow.js'

export const WAFID_BOOK = 'wafid_book'
const BETWEEN_MS = 20000 // one look-up every 20 s: gentle on wafid.com

/** Queue a booking run unless one is waiting, running or done already. */
export async function queueWafidBooking(db, profileId, trigger = 'button') {
  const existing = await db('automation_queue')
    .where({ profile_id: profileId, workflow_id: WAFID_BOOK })
    .whereIn('status', ['pending', 'running', 'paused'])
    .orderBy('id', 'desc').first()
  if (existing) return { queued: false, runId: existing.id, reason: `already ${existing.status}` }
  // A Wafid booking starts only when a person presses Book — never by itself
  // (asked on 2026-11-15: "don't book Wafid until you are told to").
  if (trigger !== 'button') return { queued: false, reason: 'Wafid is booked only when a person presses Book' }
  const now = new Date().toISOString()
  const [runId] = await db('automation_queue').insert({
    profile_id: profileId, workflow_id: WAFID_BOOK, status: 'pending', current_step: 0,
    context: '{}', log: JSON.stringify([{ ts: Date.now(), level: 'info', msg: trigger === 'chosen' ? 'Started by itself: a Saudi employer chose her on Musaned' : 'Started from the Wafid button' }]),
    created_at: now, updated_at: now,
  })
  try { const { drainQueue } = await import('./worker.js'); drainQueue(db).catch(() => {}) } catch {}
  console.log(`[wafid] booking queued for profile ${profileId} (run #${runId}, ${trigger})`)
  return { queued: true, runId }
}

/**
 * The appointment slip, fetched by itself (no call for a person): after the
 * booking, and when a check finds her booked but no slip in her profile yet.
 */
export async function queueWafidSlip(db, profileId, trigger = 'booked') {
  const busy = await db('automation_queue').where({ profile_id: profileId, workflow_id: 'wafid_slip' })
    .whereIn('status', ['pending', 'running', 'paused']).first()
  if (busy) return { queued: false, runId: busy.id }
  const now = new Date().toISOString()
  const [runId] = await db('automation_queue').insert({
    profile_id: profileId, workflow_id: 'wafid_slip', status: 'pending', current_step: 0,
    context: '{}', log: JSON.stringify([{ ts: Date.now(), level: 'info', msg: trigger === 'booked' ? 'Started by itself: the Wafid booking is done' : 'Started by itself: her slip is not in her profile yet' }]),
    created_at: now, updated_at: now,
  })
  try { const { drainQueue } = await import('./worker.js'); drainQueue(db).catch(() => {}) } catch {}
  console.log(`[wafid] appointment slip queued for profile ${profileId} (run #${runId}, ${trigger})`)
  return { queued: true, runId }
}

/** She is FIT on Wafid: her booking is done, whoever booked it — the Book card shows ✓. */
export async function markBookingDone(db, profileId, why = 'She is FIT on Wafid — the booking is done') {
  const done = await db('automation_queue').where({ profile_id: profileId, workflow_id: WAFID_BOOK, status: 'done' }).first()
  if (done) return false
  const open = await db('automation_queue').where({ profile_id: profileId, workflow_id: WAFID_BOOK }).whereIn('status', ['pending', 'paused']).first()
  if (open) { await db('automation_queue').where({ id: open.id }).update({ status: 'done', pause_reason: why, updated_at: new Date().toISOString() }); return true }
  const now = new Date().toISOString()
  await db('automation_queue').insert({
    profile_id: profileId, workflow_id: WAFID_BOOK, status: 'done', current_step: 3, context: '{}', pause_reason: why,
    log: JSON.stringify([{ ts: Date.now(), level: 'info', msg: `✓ ${why}` }]), created_at: now, updated_at: now, started_at: now,
  })
  return true
}

const STATE_TO_STATUS = { fit: 'medical_fit', unfit: 'medical_rejected' }

export const checker = { running: false, last: null, results: [] }

async function note(db, profileId, title, body) {
  try {
    await db('tasks').insert({
      type: 'automation', title, description: body, status: 'pending', profile_id: profileId,
      assigned_to: 1, is_ai_created: true, created_at: new Date().toISOString(),
    })
  } catch {}
}

/**
 * What Wafid shows for her, saved: FIT → Medical · Fit (her next step; the
 * Book card shows ✓, her slip is fetched when missing), UNFIT → Medical ·
 * Rejected (the Unfit tab). The result's PDF goes into her Medical Report.
 */
export async function saveResult(db, p, r, pdf = null) {
  const status = STATE_TO_STATUS[r?.state]
  if (!status) return false
  await db('profiles').where('id', p.id).update({ status, updated_at: new Date().toISOString() })
  await note(db, p.id, `Wafid medical: ${r.state === 'fit' ? 'FIT ✅' : 'UNFIT ❌'} — ${p.full_name}`,
    `wafid.com shows ${r.text} for passport ${p.passport_number}. Status set to Medical · ${r.state === 'fit' ? 'Fit' : 'Rejected'}.`)
  if (pdf?.length) {
    try {
      const { savePdf } = await import('./musanedContracts.js')
      await savePdf(db, p.id, 'Medical Report', pdf, `wafid-medical-${String(p.passport_number).trim().toUpperCase()}.pdf`)
      const { applyMedicalRecord } = await import('./medicalValidity.js')
      await applyMedicalRecord(db, p.id, pdf).catch(() => null)
    } catch (e) { console.warn(`[wafid] ${p.full_name}: the result PDF was not saved: ${e.message}`) }
  }
  if (r.state === 'fit') {
    await markBookingDone(db, p.id).catch(() => false)
    const slip = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where({ 'profile_fields.profile_id': p.id, 'profile_fields.name': 'Appointment Slip' }).first('files.id').catch(() => null)
    if (!slip) await queueWafidSlip(db, p.id, 'missing').catch(() => {})
  }
  return true
}

/**
 * Look profiles up once, one after the other. Returns what changed.
 *   onlyId      one profile (the button on her page)
 *   list        these profiles (the daily check: the Wafid tab)
 *   look        (passport) => { state, text, pdf? } — another PC reads Wafid
 *               (the daily check on a Companion); without it, this PC's tab
 *   shouldStop  () => reason — the daily check ends early (its PC went away)
 * Without onlyId / list: every "Medical · Applied" profile.
 */
export async function checkAll(db, { onlyId = null, auto = false, list = null, look = null, by = '', shouldStop = null, gapMs = BETWEEN_MS } = {}) {
  if (checker.running) return { busy: true }
  // The timed check never opens Brave itself: only when Brave is open.
  if (auto && !look && !(await openBrowserIfAny())) { console.log('[wafid] Brave is closed — checking when it is open'); return { skipped: true } }
  checker.running = true
  checker.results = []
  checker.by = by
  checker.auto = !!auto
  let page = null, stopped = ''
  try {
    if (!list) {
      let q = db('profiles').whereNotNull('passport_number').whereNot('passport_number', '')
      q = onlyId ? q.where('id', onlyId) : q.where('status', 'medical_applied')
      list = await q.select('id', 'full_name', 'passport_number', 'nationality')
    }
    if (!list.length) return { checked: 0, results: [] }

    if (!look) {
      const browser = await getBrowser()
      page = await borrowTab(browser, 'wafid_check', await activeRunIds(db))
      await setupTab(page, { runId: 'wafid-status' })
      page.__adalAllowImages = true // reCAPTCHA
    }
    const { runsWorking } = await import('./busy.js')
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))

    for (const [i, p] of list.entries()) {
      if (i && gapMs) await sleep(gapMs)
      // One agent at a time: a robot that started meanwhile goes first.
      while (auto && runsWorking() > 0 && !(stopped = shouldStop?.() || '')) await sleep(30000)
      if ((stopped = stopped || shouldStop?.() || '')) break
      const passport = String(p.passport_number).trim().toUpperCase()
      let r, pdf = null
      try {
        if (look) {
          const got = await look(passport)
          if (got?.pdf) pdf = Buffer.from(String(got.pdf), 'base64')
          r = { state: got?.state || 'unknown', text: got?.text || '' }
        } else {
          r = await checkMedicalStatus(page, passport)
          if (STATE_TO_STATUS[r.state]) pdf = await downloadResultPdf(page).catch(() => null)
        }
      } catch (e) { r = { state: 'unknown', text: e.message } }
      checker.results.push({ id: p.id, name: p.full_name, passport: p.passport_number, state: r.state, text: r.text })
      console.log(`[wafid] ${p.full_name} (${p.passport_number}): ${r.state} — ${r.text}${by ? ` (on ${by})` : ''}`)
      await saveResult(db, p, r, pdf)
      if (r.state === 'challenge') {
        await note(db, p.id, 'Wafid asks "I am not a robot"', 'The medical check stopped. Open wafid.com/en/medical-status-search once in Adal Browser, answer it, then press "Check medical results now".')
        stopped = 'Wafid asked "I am not a robot"'
        break
      }
    }
    return { checked: checker.results.length, results: checker.results, ...(stopped ? { stopped } : {}) }
  } finally {
    await doneWithTab(page).catch(() => {})
    checker.running = false
    checker.last = new Date().toISOString()
  }
}

// The daily check of the Wafid tab runs from selectionCheck.js (one PC of the agency, one at a time).
export function startWafidChecker() {}
