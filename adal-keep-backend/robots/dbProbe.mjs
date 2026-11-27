/**
 * dbProbe.mjs — where a slow statement's time goes (2026-11-27, Main: reads by index 5.9-6.0 s, also with 16 threads).
 * A connection of its own (no pool, no knex) every 10 s times: `select 1` (Node's thread pool only), a read that takes a
 * read snapshot (SQLite's locks, the WAL index, the disk), and the -wal file's size. The latest is said with every
 * "[db] slow" line, and the probe says itself when its read took over a second. At the start: the file's journal mode
 * (not "wal": a read waits for every writer). Off: ADAL_DB_PROBE=0.
 */
import fs from 'fs'

export const probeOn = (env = process.env) => env.ADAL_DB_PROBE !== '0'
export const lastProbe = { at: 0, selectMs: null, readMs: null, walMB: null, mode: '' }

/** One line of the latest probe. Pure. */
export function probeLine(p = lastProbe, now = Date.now()) {
  if (!p.at) return 'no probe yet'
  return `probe ${Math.round((now - p.at) / 1000)} s ago: select 1 ${p.selectMs} ms (threads), a read ${p.readMs} ms (locks/disk), WAL ${p.walMB} MB, ${p.mode || '?'} mode`
}

export async function startDbProbe(file, { everyMs = 10000, log = (m) => console.warn(m) } = {}) {
  if (!probeOn() || !file) return null
  let sqlite3
  try { sqlite3 = (await import('sqlite3')).default } catch { return null }
  const db = await new Promise((ok) => { const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => ok(e ? null : d)) })
  if (!db) return null
  db.configure?.('busyTimeout', 15000)
  const q = (sql) => new Promise((ok) => { const t0 = Date.now(); db.get(sql, (e, row) => ok({ ms: Date.now() - t0, row, e })) })
  const mode = (await q('PRAGMA journal_mode')).row?.journal_mode || '?'
  lastProbe.mode = mode
  log(`[db] the file is in ${mode} mode${mode === 'wal' ? '' : ' — not WAL: every read here waits for every write of Adal Keep'}`)
  const round = async () => {
    const a = await q('select 1 as x')
    const b = await q('select max(id) as m from automation_queue')
    let walMB = null
    try { walMB = Math.round(fs.statSync(file + '-wal').size / 1048576 * 10) / 10 } catch { walMB = 0 }
    Object.assign(lastProbe, { at: Date.now(), selectMs: a.ms, readMs: b.ms, walMB })
    if (b.ms > 1000 || a.ms > 1000) log(`[db] ${probeLine()}${b.e ? ` — ${b.e.message}` : ''}`)
  }
  round()
  const t = setInterval(round, everyMs); t.unref?.()
  return t
}

// ── What fills Adal Robots' own thread ─────────────────────────────────────────────────────────────────────────
// (Main: "select 1" 1-1.3 s while a read under lock took 1 ms: the event loop itself was busy.) When the loop stalls
// over 500 ms, a 20 s CPU profile (Node's own, at most once in 10 minutes) says the functions that took the time.
// Off: ADAL_STALL_PROFILE=0.
let profiledAt = 0
/** The top functions of a CPU profile by own time. Pure. → [{ fn, where, ms }] */
export function topOf(profile, n = 6) {
  const self = new Map(), byId = new Map(profile.nodes.map(x => [x.id, x]))
  const dt = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples.length)
  for (const id of profile.samples) self.set(id, (self.get(id) || 0) + 1)
  const sum = new Map()
  for (const [id, hits] of self) {
    const f = byId.get(id)?.callFrame; if (!f) continue
    if (/^\((idle|program|garbage collector)\)$/.test(f.functionName)) { const k = f.functionName; sum.set(k, { fn: k, where: '', ms: (sum.get(k)?.ms || 0) + hits * dt }); continue }
    const where = `${String(f.url || '').replace(/^.*[\\/](src|robots|node_modules)[\\/]/, '$1/')}:${f.lineNumber + 1}`
    const k = `${f.functionName || '(anonymous)'} ${where}`
    sum.set(k, { fn: f.functionName || '(anonymous)', where, ms: (sum.get(k)?.ms || 0) + hits * dt })
  }
  return [...sum.values()].filter(x => x.fn !== '(idle)').sort((a, b) => b.ms - a.ms).slice(0, n).map(x => ({ ...x, ms: Math.round(x.ms) }))
}

export async function profileStall({ ms = 20000, log = (m) => console.warn(m) } = {}) {
  if (process.env.ADAL_STALL_PROFILE === '0' || Date.now() - profiledAt < 10 * 60e3) return null
  profiledAt = Date.now()
  try {
    const inspector = await import('node:inspector')
    const s = new inspector.Session(); s.connect()
    const post = (m, p = {}) => new Promise((ok, no) => s.post(m, p, (e, r) => e ? no(e) : ok(r)))
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 1000 }); await post('Profiler.start')
    await new Promise(r => setTimeout(r, ms))
    const { profile } = await post('Profiler.stop')
    s.disconnect()
    const top = topOf(profile)
    log(`[db] Adal Robots' thread for ${ms / 1000} s: ${top.map(t => `${t.fn}${t.where ? ` (${t.where})` : ''} ${t.ms} ms`).join(', ')}`)
    return top
  } catch (e) { log(`[db] no profile: ${e.message}`); return null }
}

/** Every 2 s: how late a timer comes (the loop's stall); over 500 ms → a profile. */
export function watchStalls({ log } = {}) {
  if (process.env.ADAL_STALL_PROFILE === '0') return null
  let at = Date.now()
  const t = setInterval(() => {
    const late = Date.now() - at - 2000
    at = Date.now()
    if (late > 500) { lastProbe.stallMs = late; profileStall({ log }).catch(() => {}) }
  }, 2000)
  t.unref?.()
  return t
}
