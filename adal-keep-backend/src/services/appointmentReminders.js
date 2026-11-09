/**
 * Her appointments (Tasheer — the visa biometrics — and the Wafid medical):
 * the day before each, a task with a beep — her name, the place and the time.
 * Each appointment once (a new date is a new appointment).
 */
const KINDS = [
  { key: 'tasheer', name: 'Tasheer (visa biometrics)', date: 'tasheer_date', time: 'tasheer_time', place: 'tasheer_center', ref: 'tasheer_ref' },
  { key: 'wafid', name: 'Wafid medical', date: 'wafid_appt_date', time: 'wafid_appt_time', place: 'wafid_center', ref: 'wafid_slip_number' },
]

const day = (d) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

/** The reminders due now: an appointment tomorrow (or today, if it was missed) not yet reminded of. */
export function dueReminders(p, now = new Date()) {
  let sent = []
  try { sent = JSON.parse(p.appointment_alerts_sent || '[]') } catch {}
  const today = day(now), tomorrow = day(now.getTime() + 86400000)
  const out = []
  for (const k of KINDS) {
    const date = String(p[k.date] || '').slice(0, 10)
    if (!date || (date !== today && date !== tomorrow)) continue
    const id = `${k.key}:${date}`
    if (sent.includes(id)) continue
    out.push({ id, kind: k, date, when: date === today ? 'today' : 'tomorrow', time: p[k.time] || '', place: p[k.place] || '', ref: p[k.ref] || '' })
  }
  return out
}

export async function checkAppointments(db, now = new Date()) {
  const cols = KINDS.map(k => k.date)
  const rows = await db('profiles').where(q => { for (const c of cols) q.orWhere(c, '>=', day(now)) })
    .select('id', 'full_name', 'appointment_alerts_sent', ...KINDS.flatMap(k => [k.date, k.time, k.place, k.ref])).catch(() => [])
  for (const p of rows) {
    const due = dueReminders(p, now)
    if (!due.length) continue
    let sent = []
    try { sent = JSON.parse(p.appointment_alerts_sent || '[]') } catch {}
    for (const r of due) {
      const title = `📅 ${p.full_name}: ${r.kind.name} ${r.when}${r.time ? ` at ${r.time}` : ''}`
      const body = [`${r.kind.name} on ${r.date}${r.time ? ` at ${r.time}` : ''}`, r.place && `Place: ${r.place}`, r.ref && `Reference: ${r.ref}`].filter(Boolean).join('\n')
      await db('tasks').insert({ type: 'automation', title, description: body, status: 'pending', profile_id: p.id, assigned_to: 1, is_ai_created: true, created_at: new Date().toISOString() }).catch(() => {})
      sent.push(r.id)
      console.log(`[appointments] ${title}`)
    }
    await db('profiles').where('id', p.id).update({ appointment_alerts_sent: JSON.stringify(sent.slice(-20)) }).catch(() => {})
    try { const { beep } = await import('./worker.js'); beep() } catch {}
  }
}

export function startAppointmentWatcher(db) {
  const run = () => checkAppointments(db).catch(e => console.warn('[appointments]', e.message))
  setTimeout(run, 45000)
  setInterval(run, 60 * 60 * 1000)
}
