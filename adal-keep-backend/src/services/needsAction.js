/**
 * needsAction.js — "Needs action today" (asked on 2026-11-19): the girls with
 * something due or overdue today, built only from what Adal Keep already
 * knows (her journey steps, status, dates and documents). In the app only:
 * the dashboard's list (GET /api/needs-action) and, once a day in working
 * hours, one notification that phones show as an Android notification. No
 * WhatsApp message is sent.
 *
 * What counts (each item: { kind, text, overdue }):
 *   docs      a document her current step needs is missing
 *   medical   her medical runs out within 7 days (overdue: it has run out)
 *   appt      her Wafid medical or Tasheer appointment is today
 *   stuck     a robot's run failed (overdue) or waits for a person
 *   chosen    chosen on Musaned 3+ days ago and her Wafid not booked yet
 *   musaned   Musaned waits for the office: EPRO approval, unpaid wakala
 *   result    Wafid booked 5+ days after her appointment and still no result
 */

const DAY = 86400000
const dayOf = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
const daysSince = (date, now) => {
  const s = String(date || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return Math.floor((new Date(dayOf(now) + 'T00:00:00') - new Date(s + 'T00:00:00')) / DAY)
}
// Her step now: the first one up to the EPRO not reached yet (as the Profiles tabs).
const ORDER = ['cv', 'musaned', 'selected', 'wafid', 'epro', 'insurance', 'fmol', 'embassy', 'visa']
export function currentStep(steps = {}) {
  let reached = -1
  ORDER.forEach((k, i) => { if (steps[k] === 'done' || (k === 'musaned' && steps[k] === 'waiting')) reached = i })
  return ORDER[Math.min(reached + 1, ORDER.length - 1)]
}
const WORKFLOW_NAMES = { musaned_add_candidate: 'Add to Musaned', wafid_book: 'Book Wafid', wafid_slip: 'Wafid slip', wafid_check: 'Wafid result', lmis_contract: 'LMIS contract', mofa_visa: 'Visa', insurance_certificate: 'Insurance', tasheer_schedule: 'Tasheer', musaned_epro_approve: 'EPRO approval', police_certificate: 'Police clearance' }

/**
 * One girl's items for today. p: her profile row; st: her line from
 * allStages() ({ steps, missing, problem }); runs: her latest run per robot.
 */
export function itemsFor(p, st = {}, runs = {}, now = new Date()) {
  const steps = st.steps || {}
  const out = []
  if (steps.arrived === 'done' || p.status === 'medical_rejected') {
    // Arrived, or UNFIT (the Unfit tab has its own work): nothing is due.
    return out
  }
  // Documents her current step needs.
  const step = currentStep(steps)
  const missing = (st.missing || {})[step] || []
  const STEP_NAME = { cv: 'the CV', musaned: 'Musaned', selected: 'the contract', wafid: 'Wafid', epro: 'the EPRO', insurance: 'the insurance', fmol: 'FMOL', embassy: 'the embassy', visa: 'the visa' }
  if (missing.length) out.push({ kind: 'docs', text: `Missing for ${STEP_NAME[step] || step}: ${missing.join(', ')}`, overdue: false })
  // The medical's battery.
  if (p.medical_valid_until) {
    const left = -daysSince(p.medical_valid_until, now)
    if (left != null && !Number.isNaN(left)) {
      if (left < 0) out.push({ kind: 'medical', text: `Medical ran out on ${String(p.medical_valid_until).slice(0, 10)}`, overdue: true })
      else if (left <= 7) out.push({ kind: 'medical', text: `Medical runs out ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`} (${String(p.medical_valid_until).slice(0, 10)})`, overdue: false })
    }
  }
  // Appointments today.
  for (const [name, date, time] of [['Wafid medical', p.wafid_appt_date, p.wafid_appt_time], ['Tasheer', p.tasheer_date, p.tasheer_time]]) {
    if (daysSince(date, now) === 0) out.push({ kind: 'appt', text: `${name} today${time ? ` at ${time}` : ''}`, overdue: false })
  }
  // A robot stuck: failed, or waiting for a person.
  if (st.problem) out.push({ kind: 'stuck', text: st.problem, overdue: true })
  for (const r of Object.values(runs)) {
    if (r?.status === 'paused') out.push({ kind: 'stuck', text: `${WORKFLOW_NAMES[r.workflow_id] || r.workflow_id} waits for you`, overdue: false })
  }
  // Chosen, Wafid not booked.
  const chosenAgo = daysSince(p.chosen_at, now)
  if (steps.selected === 'done' && steps.wafid === 'todo' && p.status !== 'medical_fit' && chosenAgo != null && chosenAgo >= 3) {
    out.push({ kind: 'chosen', text: `Chosen ${chosenAgo} days ago — Wafid not booked`, overdue: true })
  }
  // Wafid booked long ago, no result.
  const apptAgo = daysSince(p.wafid_appt_date, now)
  if (p.status === 'medical_applied' && apptAgo != null && apptAgo >= 5) out.push({ kind: 'result', text: `No Wafid result ${apptAgo} days after her medical`, overdue: true })
  // Musaned waits for the office.
  if (steps.epro === 'active') out.push({ kind: 'musaned', text: 'EPRO approval waits on Musaned', overdue: false })
  if (steps.wakala === 'failed') out.push({ kind: 'musaned', text: 'Wakala unpaid on Musaned', overdue: false })
  return out
}

/** Today's list: [{ profile_id, name, items, overdue }], overdue girls first. */
export async function needsActionToday(db, now = new Date()) {
  const { allStages } = await import('../routes/automations.js')
  const { profiles: stages } = await allStages(db)
  const byId = new Map(stages.map(s => [s.profile_id, s]))
  const cols = ['id', 'full_name', 'destination_country', 'status', 'chosen_at', 'medical_valid_until', 'wafid_appt_date', 'wafid_appt_time', 'tasheer_date', 'tasheer_time']
  const have = await db('profiles').columnInfo().catch(() => ({}))
  const profiles = await db('profiles').select(cols.filter(c => c in have))
  const runs = new Map()
  for (const r of await db('automation_queue').whereIn('status', ['paused']).select('profile_id', 'workflow_id', 'status').orderBy('id', 'asc').catch(() => [])) {
    if (!runs.has(r.profile_id)) runs.set(r.profile_id, {})
    runs.get(r.profile_id)[r.workflow_id] = r
  }
  const list = []
  for (const p of profiles) {
    const items = itemsFor(p, byId.get(p.id) || {}, runs.get(p.id) || {}, now)
    // country: her destination, for the top bar's country filter (empty: Saudi Arabia there).
    if (items.length) list.push({ profile_id: p.id, name: p.full_name || `#${p.id}`, country: p.destination_country || '', items, overdue: items.some(i => i.overdue) })
  }
  list.sort((a, b) => (b.overdue - a.overdue) || (b.items.length - a.items.length) || String(a.name).localeCompare(String(b.name)))
  return { day: dayOf(now), count: list.length, profiles: list }
}

// ── Once a day: one notification (phones show it) ───────────────────────────

const TOLD_KEY = 'needs_action_told'
export async function tellToday(db, now = new Date()) {
  const day = dayOf(now)
  const row = await db('settings').where('key', TOLD_KEY).first().catch(() => null)
  if (row?.value === day) return { told: false, why: 'already today' }
  const { count, profiles } = await needsActionToday(db, now)
  const at = new Date().toISOString()
  if (row) await db('settings').where('key', TOLD_KEY).update({ value: day, updated_at: at })
  else await db('settings').insert({ key: TOLD_KEY, value: day, created_at: at, updated_at: at })
  if (!count) return { told: false, count: 0 }
  const late = profiles.filter(p => p.overdue).length
  const names = profiles.slice(0, 4).map(p => `${p.name}: ${p.items[0].text}`).join('\n')
  await db('notifications').insert({
    type: 'needs_action',
    title: `📋 Needs action today: ${count} girl${count === 1 ? '' : 's'}${late ? ` (${late} overdue)` : ''}`,
    body: names + (count > 4 ? `\n+${count - 4} more — open the dashboard` : ''),
    created_day: day,
  }).catch(e => console.warn('[needs-action] notification:', e.message))
  console.log(`[needs-action] ${count} girl(s) need action today${late ? `, ${late} overdue` : ''}`)
  return { told: true, count }
}

let timer = null
export function startNeedsAction(db, { isFollower = () => false } = {}) {
  if (timer) return
  const run = () => {
    const now = new Date()
    // Working hours, on the main PC only (it holds the list; phones get it from there).
    if (isFollower() || now.getDay() === 0 || now.getHours() < 8 || now.getHours() >= 17) return
    tellToday(db, now).catch(e => console.warn('[needs-action]', e.message))
  }
  setTimeout(run, 3 * 60e3).unref?.()
  timer = setInterval(run, 15 * 60e3)
  timer.unref?.()
}
