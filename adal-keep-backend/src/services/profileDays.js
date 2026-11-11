/**
 * Each profile's whole status, day by day (asked on 2026-11-11): every hour
 * the list's stage and journey steps of every profile (CV, Musaned, selected,
 * Wafid, EPRO, insurance, FMOL approved or not, embassy, visa, arrived) are
 * kept as today's row (profile_days) — so the profile shows, per day, where
 * she was and what moved. Only the database: no browser, no internet.
 */
const TITLES = { cv: 'CV', musaned: 'Musaned', selected: 'Selected', wafid: 'Wafid', wakala: 'Paid wakala', epro: 'EPRO',
  insurance: 'Insurance', fmol: 'FMOL', embassy: 'Embassy', visa: 'Visa issued', arrived: 'Arrived KSA' }
const today = () => new Date().toLocaleDateString('en-CA')
let busy = false

/** Today's row for every profile (only where something changed since the last look). */
export async function snapshotDays(db) {
  if (busy) return 0
  busy = true
  try {
    const { allStages } = await import('../routes/automations.js')
    const { profiles } = await allStages(db)
    const day = today(), at = new Date().toISOString()
    const had = new Map((await db('profile_days').where({ day }).select('profile_id', 'data')).map(r => [r.profile_id, r.data]))
    let n = 0
    for (const p of profiles) {
      const data = JSON.stringify({ stage: p.stage, musaned_stage: p.musaned_stage || '', steps: p.steps || {}, notes: p.notes || {} })
      if (had.get(p.profile_id) === data) continue
      if (had.has(p.profile_id)) await db('profile_days').where({ profile_id: p.profile_id, day }).update({ data, updated_at: at })
      else await db('profile_days').insert({ profile_id: p.profile_id, day, data, updated_at: at }).catch(() => {})
      n++
    }
    return n
  } finally { busy = false }
}

/** Her days, newest first: what she was and what changed from the day before. */
export async function daysOf(db, profileId, limit = 90) {
  const rows = await db('profile_days').where({ profile_id: profileId }).orderBy('day', 'desc').limit(limit + 1).select('day', 'data', 'updated_at')
  const parsed = rows.map(r => { try { return { day: r.day, at: r.updated_at, ...JSON.parse(r.data || '{}') } } catch { return { day: r.day, at: r.updated_at, steps: {} } } })
  return parsed.slice(0, limit).map((d, i) => {
    const before = parsed[i + 1]
    const changes = []
    if (before) {
      if ((before.musaned_stage || '') !== (d.musaned_stage || '') && d.musaned_stage) changes.push(`Musaned: ${before.musaned_stage || '—'} → ${d.musaned_stage}`)
      for (const [k, v] of Object.entries(d.steps || {})) {
        const was = before.steps?.[k]
        if (was && was !== v) changes.push(`${TITLES[k] || k}: ${was} → ${v}`)
      }
    }
    return { ...d, changes, first: !before }
  })
}

/** FMOL from Musaned's stage: 'approved' | 'waiting' | '' (not there yet). */
export function fmolOf(stage) {
  const s = String(stage || '')
  if (/CANCEL|REJECT/i.test(s)) return ''
  if (/FMOL\s*APPROVED|EMBASSY|VISA\s*ISSUED|ARRIVED/i.test(s)) return 'approved'
  if (/FMOL\s*APPROVAL/i.test(s)) return 'waiting'
  return ''
}

let timer = null
export function startProfileDays(db) {
  if (timer) return
  const run = () => snapshotDays(db).catch(e => console.warn('[days]', e.message))
  setTimeout(run, 2 * 60000)
  timer = setInterval(run, 60 * 60000)
  timer.unref?.()
}
