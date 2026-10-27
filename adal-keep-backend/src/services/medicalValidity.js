/**
 * The medical's battery: when her Wafid slip (medical) runs out, a warning is
 * given once at 2 months, 1 month, 2 weeks, 1 week, 3 days and 1 day left
 * (a task + a desktop popup), and once more when it has run out.
 */
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
    const title = `🔋 ${p.full_name}: medical ${a.text}`
    const body = left > 0
      ? `Her Wafid medical is valid till ${p.medical_valid_until} (${left} day${left === 1 ? '' : 's'} left).`
      : `Her Wafid medical was valid till ${p.medical_valid_until}.`
    await db('tasks').insert({ type: 'automation', title, description: body, status: 'pending', profile_id: p.id, assigned_to: 1, is_ai_created: true, created_at: new Date().toISOString() }).catch(() => {})
    try { const { showDesktopNotice } = await import('./worker.js'); showDesktopNotice(title, body) } catch {}
    console.log(`[medical] ${title}`)
  }
}

export function startMedicalWatcher(db) {
  const run = () => checkMedicalValidity(db).catch(e => console.warn('[medical]', e.message))
  setTimeout(run, 30000)
  setInterval(run, 60 * 60 * 1000)
}
