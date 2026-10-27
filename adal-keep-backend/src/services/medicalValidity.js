/**
 * The medical's battery: when her Wafid slip (medical) runs out, a warning is
 * given once at 2 months, 1 month, 2 weeks, 1 week, 3 days and 1 day left
 * (a task + a desktop popup), and once more when it has run out.
 */
/**
 * The deadline comes from her medical record (Wafid's result PDF): the
 * "Medical examination date" + 2 months.
 */
export function medicalDeadline(text) {
  const m = String(text || '').match(/Medical\s+examination\s+date\s*[:\-]?\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/i)
  if (!m) return null
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const exam = new Date(Date.UTC(y, mo - 1, d))
  if (isNaN(exam) || exam.getUTCMonth() !== mo - 1) return null
  const end = new Date(Date.UTC(y, mo - 1 + 2, 1))
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate()
  end.setUTCDate(Math.min(d, last))
  return { exam: exam.toISOString().slice(0, 10), until: end.toISOString().slice(0, 10) }
}

/** Read the medical record PDF and set her battery. Returns the dates or null. */
export async function applyMedicalRecord(db, profileId, buf) {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buf })
  let text = ''
  try { text = (await parser.getText()).text || '' } finally { await parser.destroy?.().catch?.(() => {}) }
  const dates = medicalDeadline(text)
  if (!dates) return null
  const p = await db('profiles').where('id', profileId).first('medical_valid_from', 'medical_valid_until')
  if (p?.medical_valid_from !== dates.exam || p?.medical_valid_until !== dates.until) {
    await db('profiles').where('id', profileId).update({ medical_valid_from: dates.exam, medical_valid_until: dates.until })
  }
  return dates
}

/** Once at start: every profile's newest medical record sets its battery; FIT means booked. */
export async function backfillMedical(db) {
  const SAFE = (await import('path')).join((await import('path')).dirname((await import('url')).fileURLToPath(import.meta.url)), '..', '..', 'data', 'SafeStorage')
  const fs = await import('fs')
  const rows = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.name', 'Medical Report').andWhere('files.mimetype', 'application/pdf')
    .orderBy('files.id', 'desc').select('files.path', 'profile_fields.profile_id').catch(() => [])
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.profile_id)) continue
    const file = [r.path, (await import('path')).join(SAFE, (await import('path')).basename(r.path || ''))].find(f => f && fs.existsSync(f))
    if (!file) continue
    try { if (await applyMedicalRecord(db, r.profile_id, fs.readFileSync(file))) seen.add(r.profile_id) } catch {}
  }
  try {
    const { markBookingDone } = await import('./wafidStatus.js')
    for (const p of await db('profiles').where('status', 'medical_fit').select('id')) await markBookingDone(db, p.id)
  } catch (e) { console.warn('[medical] booking marks:', e.message) }
  if (seen.size) console.log(`[medical] ${seen.size} battery(ies) set from the medical record`)
}

const STEPS = [[60, '2 months'], [30, '1 month'], [14, '2 weeks'], [7, '1 week'], [3, '3 days'], [1, '1 day']]

export function daysLeft(until, now = new Date()) {
  if (!until) return null
  const end = new Date(String(until).slice(0, 10) + 'T23:59:59')
  return Math.ceil((end - now) / 86400000) || 0
}

/** The warning due now (or null), given the days left and those already given. */
export function dueAlert(left, sent = []) {
  if (left == null) return null
  if (left <= 0) return sent.includes('0') ? null : { key: '0', text: 'has run out' }
  const step = STEPS.filter(([d]) => left <= d).pop()   // the smallest step reached
  if (!step || sent.includes(String(step[0]))) return null
  return { key: String(step[0]), text: `${step[1]} left` }
}

export async function checkMedicalValidity(db) {
  const rows = await db('profiles').whereNotNull('medical_valid_until').andWhere('medical_valid_until', '!=', '')
    .select('id', 'full_name', 'medical_valid_until', 'medical_alerts_sent').catch(() => [])
  for (const p of rows) {
    const left = daysLeft(p.medical_valid_until)
    // The warnings belong to one end date: a new slip (or a corrected date) starts over.
    let sent = []
    try {
      const was = JSON.parse(p.medical_alerts_sent || '{}')
      if (was?.until === p.medical_valid_until) sent = was.keys || []
    } catch {}
    const a = dueAlert(left, sent)
    if (!a) continue
    // Every bigger step counts as given too: one warning at a time, never a burst.
    const given = new Set([...sent, a.key, ...STEPS.filter(([d]) => d > Number(a.key) || a.key === '0').map(([d]) => String(d))])
    await db('profiles').where('id', p.id).update({ medical_alerts_sent: JSON.stringify({ until: p.medical_valid_until, keys: [...given] }) })
    // Always the exact number of days left (never "2 months" for 34 days).
    const title = left > 0
      ? `🔋 ${p.full_name}: medical — ${left} day${left === 1 ? '' : 's'} left`
      : `🔋 ${p.full_name}: medical has run out`
    const body = left > 0
      ? `Her medical deadline is ${p.medical_valid_until}: ${left} day${left === 1 ? '' : 's'} left.`
      : `Her medical deadline was ${p.medical_valid_until}.`
    await db('tasks').insert({ type: 'automation', title, description: body, status: 'pending', profile_id: p.id, assigned_to: 1, is_ai_created: true, created_at: new Date().toISOString() }).catch(() => {})
    try { const { showDesktopNotice } = await import('./worker.js'); showDesktopNotice(title, body) } catch {}
    console.log(`[medical] ${title}`)
  }
}

export function startMedicalWatcher(db) {
  const run = () => checkMedicalValidity(db).catch(e => console.warn('[medical]', e.message))
  setTimeout(() => backfillMedical(db).catch(e => console.warn('[medical] backfill:', e.message)).then(run), 30000)
  setInterval(run, 60 * 60 * 1000)
}
