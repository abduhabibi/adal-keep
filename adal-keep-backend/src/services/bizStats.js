/**
 * bizStats.js — the business numbers Adal reads in Adal Keep Admin → Business
 * (asked on 2026-11-23). Each agency's main PC works out COUNTS from its own
 * database and sends them with the other summaries (keep_meta "/_stats", every
 * 30 minutes, flag "biz_stats"). No names, passport numbers, profile ids or
 * account names are in it: per day and per robot / stage, numbers only.
 *
 *   added      profiles added per day (profiles.created_at)
 *   moves      stage moves per day (profile_days: a profile's stage changed)
 *   stages     for each stage, how many stays ended and the average days in it
 *   robots     per robot: runs done / failed / other, seconds worked, per day (run_history, 30 days)
 *   cvs        CVs made per day
 *
 * Hours saved is an ESTIMATE made in Admin from these counts and the minutes a
 * person needs for the same job by hand (MANUAL_MINUTES below, edited here).
 * The heartbeat (keep_meta "/_pc", the fleet) supplies which PCs are on.
 */
const DAY = 86400000
export const DAYS = 90
export const bizStatsOn = async () => (await import('./agencyConfig.js')).localFlag('biz_stats')

/** Minutes a person needs to do the same by hand (estimate; one place to change it). */
export const MANUAL_MINUTES = {
  profile: 8,            // a profile typed from a passport and its papers
  cv: 6,                 // a CV made by hand
  default_robot: 10,     // a site robot's job (typing into a government site)
  robots: { musaned_add_candidate: 15, musaned_cv_import: 10, wafid_book: 12, wafid_slip: 5, wafid_check: 4, mofa_visa: 20, mofa_pay: 8, insurance_certificate: 12, tasheer_schedule: 25, lmis: 15, lmis_contract: 15, police_certificate: 15, delete_labour: 6, musaned_delete: 6 },
}

const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA')
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v))
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n }

/** Pure part: stage moves and stage stays from a profile's rows (sorted by profile, day). */
export function stageMoves(rows) {
  const moves = {}, stays = {}
  let cur = null
  for (const r of rows) {
    let stage = null
    try { stage = JSON.parse(r.data || '{}').stage || null } catch {}
    if (!stage) continue
    if (!cur || cur.profile !== r.profile_id) { cur = { profile: r.profile_id, stage, since: null, first: true, day: r.day }; continue }
    if (stage !== cur.stage) {
      bump(moves, r.day)
      // A stay counts only when both its start (a move seen) and its end were seen.
      if (cur.since) {
        const d = Math.max(0, Math.round((Date.parse(r.day) - Date.parse(cur.since)) / DAY))
        const s = stays[cur.stage] ||= { n: 0, days: 0 }
        s.n++; s.days += d
      }
      cur = { profile: r.profile_id, stage, since: r.day }
    }
  }
  return { moves, stays: Object.fromEntries(Object.entries(stays).map(([k, v]) => [k, { n: v.n, avg_days: Math.round(v.days / v.n * 10) / 10 }])) }
}

/** The whole report for one agency's database. Never throws: a missing table gives an empty part. */
export async function statsReport(db, now = Date.now()) {
  const since = dayOf(now - (DAYS - 1) * DAY)
  const out = { v: 1, at: new Date(now).toISOString(), days: DAYS, profiles: 0, added: {}, cvs: {}, moves: {}, stages: {}, robots: {} }
  try { out.profiles = Number((await db('profiles').count({ n: '*' }))[0].n) || 0 } catch {}
  const countByDay = async (table, col) => {
    const res = {}
    try {
      for (const r of await db(table).whereNotNull(col).select(col)) {
        const ms = toMs(r[col]); if (Number.isFinite(ms)) { const d = dayOf(ms); if (d >= since) bump(res, d) }
      }
    } catch {}
    return res
  }
  out.added = await countByDay('profiles', 'created_at')
  out.cvs = await countByDay('generated_cvs', 'created_at')
  try {
    const rows = await db('profile_days').where('day', '>=', dayOf(now - (DAYS + 60) * DAY)).orderBy(['profile_id', 'day']).select('profile_id', 'day', 'data')
    const m = stageMoves(rows)
    for (const [d, n] of Object.entries(m.moves)) if (d >= since) out.moves[d] = n
    out.stages = m.stays
  } catch {}
  try {
    for (const r of await db('run_history').where('kind', 'run').whereNot('outcome', 'running').select('workflow_id', 'started_at', 'outcome', 'duration_s')) {
      const ms = Date.parse(r.started_at); if (!Number.isFinite(ms)) continue
      const w = out.robots[r.workflow_id || 'unknown'] ||= { done: 0, failed: 0, other: 0, secs: 0, d: {} }
      const k = r.outcome === 'done' ? 'done' : r.outcome === 'failed' ? 'failed' : 'other'
      w[k]++; w.secs += r.duration_s || 0
      const day = (w.d[dayOf(ms)] ||= { done: 0, failed: 0 })
      if (k !== 'other') day[k]++
    }
  } catch {}
  return out
}

/** Estimated staff hours saved from a (merged) report: successful robot runs, profiles and CVs, each at its manual minutes. */
export function hoursSaved(rep, days = 30, now = Date.now()) {
  const from = dayOf(now - (days - 1) * DAY)
  const sum = (o) => Object.entries(o || {}).reduce((n, [d, v]) => n + (d >= from ? v : 0), 0)
  let min = sum(rep.added) * MANUAL_MINUTES.profile + sum(rep.cvs) * MANUAL_MINUTES.cv
  for (const [w, r] of Object.entries(rep.robots || {})) {
    const done = Object.entries(r.d || {}).reduce((n, [d, v]) => n + (d >= from ? v.done : 0), 0)
    min += done * (MANUAL_MINUTES.robots[w] ?? MANUAL_MINUTES.default_robot)
  }
  return Math.round(min / 6) / 10   // hours, one decimal
}

/** Adds many agencies' reports into one fleet-wide report (counts only). */
export function mergeReports(list) {
  const t = { profiles: 0, added: {}, cvs: {}, moves: {}, stages: {}, robots: {} }
  const addDays = (a, b) => { for (const [d, n] of Object.entries(b || {})) bump(a, d, n) }
  for (const r of list.filter(Boolean)) {
    t.profiles += r.profiles || 0
    addDays(t.added, r.added); addDays(t.cvs, r.cvs); addDays(t.moves, r.moves)
    for (const [s, v] of Object.entries(r.stages || {})) { const x = t.stages[s] ||= { n: 0, total: 0 }; x.n += v.n; x.total += v.avg_days * v.n }
    for (const [w, v] of Object.entries(r.robots || {})) {
      const x = t.robots[w] ||= { done: 0, failed: 0, other: 0, secs: 0, d: {} }
      x.done += v.done; x.failed += v.failed; x.other += v.other; x.secs += v.secs
      for (const [d, c] of Object.entries(v.d || {})) { const y = x.d[d] ||= { done: 0, failed: 0 }; y.done += c.done; y.failed += c.failed }
    }
  }
  t.stages = Object.fromEntries(Object.entries(t.stages).map(([s, v]) => [s, { n: v.n, avg_days: Math.round(v.total / v.n * 10) / 10 }]))
  return t
}

let lastAt = 0
/** Sends this agency's numbers (called with the other 30-minute reports in cloudSync.js). */
export async function pushStats(db, upsert, agency, { force = false } = {}) {
  if (!force && !(await bizStatsOn())) return null
  if (!force && Date.now() - lastAt < 20 * 60000) return null
  lastAt = Date.now()
  const data = await statsReport(db)
  await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_stats', data, updated_at: data.at }], 'agency_id,key')
  return data
}
