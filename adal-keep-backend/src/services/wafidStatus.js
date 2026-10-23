/**
 * wafidStatus.js — Wafid booking queue + the medical result checker.
 *
 *   queueWafidBooking(db, profileId)  a "Book Wafid medical" run (the button,
 *                                     or by itself once an employer chose her)
 *   checkAll(db)                      every "Medical · Applied" profile is
 *                                     looked up on wafid.com: FIT → Medical ·
 *                                     Fit, UNFIT → Medical · Rejected
 *   startWafidChecker(db)             checkAll every few hours, in a
 *                                     background tab of the agency's Brave
 */
import { getBrowser } from './browser.js'
import { setupTab } from './tabManager.js'
import { checkMedicalStatus } from './wafidWorkflow.js'

export const WAFID_BOOK = 'wafid_book'
const EVERY_MS = Number(process.env.WAFID_CHECK_HOURS || 4) * 3600 * 1000
const BETWEEN_MS = 20000 // one look-up every 20 s: gentle on wafid.com

/** Queue a booking run unless one is waiting, running or done already. */
export async function queueWafidBooking(db, profileId, trigger = 'button') {
  const existing = await db('automation_queue')
    .where({ profile_id: profileId, workflow_id: WAFID_BOOK })
    .whereIn('status', ['pending', 'running', 'paused'])
    .orderBy('id', 'desc').first()
  if (existing) return { queued: false, runId: existing.id, reason: `already ${existing.status}` }
  if (trigger !== 'button') {
    const done = await db('automation_queue').where({ profile_id: profileId, workflow_id: WAFID_BOOK, status: 'done' }).first()
    if (done) return { queued: false, runId: done.id, reason: 'already booked' }
  }
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

/** Look every applied profile up once. Returns what changed. */
export async function checkAll(db, { onlyId = null } = {}) {
  if (checker.running) return { busy: true }
  checker.running = true
  checker.results = []
  let page = null
  try {
    let q = db('profiles').whereNotNull('passport_number').whereNot('passport_number', '')
    q = onlyId ? q.where('id', onlyId) : q.where('status', 'medical_applied')
    const list = await q.select('id', 'full_name', 'passport_number', 'nationality')
    if (!list.length) return { checked: 0, results: [] }

    const browser = await getBrowser()
    page = await browser.newPage()
    await setupTab(page, { runId: 'wafid-status' })
    page.__adalAllowImages = true // reCAPTCHA

    for (const [i, p] of list.entries()) {
      if (i) await new Promise(r => setTimeout(r, BETWEEN_MS))
      let r
      try { r = await checkMedicalStatus(page, String(p.passport_number).trim().toUpperCase()) } catch (e) { r = { state: 'unknown', text: e.message } }
      const row = { id: p.id, name: p.full_name, passport: p.passport_number, ...r }
      checker.results.push(row)
      console.log(`[wafid] ${p.full_name} (${p.passport_number}): ${r.state} — ${r.text}`)
      const status = STATE_TO_STATUS[r.state]
      if (status) {
        await db('profiles').where('id', p.id).update({ status, updated_at: new Date().toISOString() })
        await note(db, p.id, `Wafid medical: ${r.state === 'fit' ? 'FIT ✅' : 'UNFIT ❌'} — ${p.full_name}`,
          `wafid.com shows ${r.text} for passport ${p.passport_number}. Status set to Medical · ${r.state === 'fit' ? 'Fit' : 'Rejected'}.`)
      }
      if (r.state === 'challenge') {
        await note(db, p.id, 'Wafid asks "I am not a robot"', 'The medical check stopped. Open wafid.com/en/medical-status-search once in the Adal Keep Brave, answer it, then press "Check medical results now".')
        break
      }
    }
    return { checked: checker.results.length, results: checker.results }
  } finally {
    try { await page?.close() } catch {}
    checker.running = false
    checker.last = new Date().toISOString()
  }
}

let timer = null
export function startWafidChecker(db) {
  if (timer) return
  const tick = () => checkAll(db).catch(e => console.warn('[wafid] check failed:', e.message))
  setTimeout(tick, 3 * 60 * 1000) // a few minutes after start
  timer = setInterval(tick, EVERY_MS)
  console.log(`🩺 Wafid medical results checked every ${EVERY_MS / 3600000} h`)
}
