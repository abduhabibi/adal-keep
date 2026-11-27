/**
 * pcReport.js — every PC tells Adal's control tower its own problems (the owner, 2026-11-27),
 * so they are fixed before the staff complain. Every 5 minutes, one row of this PC's own
 * keep_meta, "/_tower/report" (outbound only: no port, no new way in), with:
 *   - the error and crash lines of server.log, robots.log and launcher.log, grouped, with
 *     counts today and yesterday and when each was first seen;
 *   - today's failed and stopped runs with the step they stopped at;
 *   - the 10 slowest steps of the day (the gaps in the runs' own logs);
 *   - free memory, disk and processor; the internet speed last measured; the version.
 * Never a girl's data: names (every name this PC knows), passport and phone numbers,
 * passwords, codes and tokens are taken out of every line; no documents, no pictures.
 * A run working has the internet (runFocus.js): the report waits. Off: ADAL_PC_REPORTS=0.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = () => process.env.ADAL_REPORT_DATA || path.join(BACKEND, 'data')
export const reportsOn = (env = process.env) => env.ADAL_PC_REPORTS !== '0'
export const REPORT_MS = 5 * 60_000
export const KEY = '/_tower/report'
const LOGS = ['server.log', 'robots.log', 'launcher.log']
const FIRST_BYTES = 256 * 1024, MAX_BYTES = 1024 * 1024

// ------------------------------------------------------------- cleaning --
/** The words of every name this PC knows (girls, employees, brokers): taken out of lines. */
export async function knownNames(db) {
  const words = new Set()
  const add = (v) => { for (const w of String(v || '').toLowerCase().split(/[^\p{L}']+/u)) if (w.length >= 3) words.add(w) }
  for (const [table, cols] of [['profiles', ['full_name', 'first_name', 'middle_name', 'last_name', 'mother_name']], ['employees', ['name']], ['brokers', ['name', 'full_name']]]) {
    for (const c of cols) { try { for (const r of await db(table).whereNotNull(c).select(c)) add(r[c]) } catch {} }
  }
  return words
}
/** A line with nothing personal left in it. */
export function clean(line, names = new Set()) {
  let t = String(line ?? '')
    .replace(/((?:pass(?:word)?|pwd|token|secret|api[_-]?key|otp|code|cookie|authorization|bearer)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[hidden]')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b[A-Z]{1,2}\d{6,9}\b/g, '[passport]')
    .replace(/\+?\d[\d\s-]{7,15}\d/g, m => m.replace(/\D/g, '').length >= 9 ? '[number]' : m)
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[code]')
    // Ethiopic and Arabic writing: names, here.
    .replace(/[ሀ-᎟؀-ۿ][ሀ-᎟؀-ۿ\s]*/g, '[name] ')
  if (names.size) t = t.replace(/[\p{L}']+/gu, w => names.has(w.toLowerCase()) ? '[name]' : w)
  return t.replace(/(\[name\]\s*){2,}/g, '[name] ').replace(/\s+/g, ' ').trim()
}
/** One group for one kind of line: numbers, ids, times and quoted parts make no new group. */
export const groupOf = (source, line) => `${source}|${String(line)
  .replace(/^\S*\d{4}-\d\d-\d\dT\S+\s*/, '').replace(/0x[0-9a-f]+|\d+(\.\d+)?/gi, '#').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '…').replace(/\s+/g, ' ').slice(0, 160)}`

const BAD = /\b(error|errors|failed|failure|fail|exception|uncaught|unhandled|crash(ed)?|fatal|panic|ENOENT|EACCES|EPERM|ECONNREFUSED|timed out|timeout)\b|✖|\bERR!/i
const NOT_BAD = /\b(no errors?|0 errors?|without error)\b/i
export const isProblem = (line) => BAD.test(line) && !NOT_BAD.test(line)

// --------------------------------------------------------------- state --
const STATE_FILE = () => path.join(DATA(), 'pc-report.json')
let state = null
const today = (now = new Date()) => now.toLocaleDateString('en-CA')
function st() {
  if (state) return state
  try { state = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) } catch { state = {} }
  state.offsets ||= {}; state.groups ||= {}
  return state
}
function save() { try { fs.mkdirSync(DATA(), { recursive: true }); fs.writeFileSync(STATE_FILE(), JSON.stringify(state)) } catch {} }
export const _reset = () => { state = { offsets: {}, groups: {} } }

/** A new day: today's counts become yesterday's. */
function roll(now) {
  const d = today(now)
  for (const g of Object.values(st().groups)) if (g.day !== d) { g.yesterday = g.day === today(new Date(now.getTime() - 86400e3)) ? g.today : 0; g.today = 0; g.day = d }
}

/** What was added to a log since the last look (the end of it the first time). */
function newPart(file) {
  try {
    const size = fs.statSync(file).size
    let from = st().offsets[file]
    if (from == null || from > size) from = Math.max(0, size - FIRST_BYTES)
    from = Math.max(from, size - MAX_BYTES)
    const len = size - from
    st().offsets[file] = size
    if (len <= 0) return ''
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, from)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

/** The logs' new problem lines, into their groups. */
export function readLogs(names = new Set(), { dir = DATA(), now = new Date() } = {}) {
  roll(now)
  const at = now.toISOString(), d = today(now)
  for (const f of LOGS) {
    const source = f.replace(/\.log$/, '')
    for (const raw of newPart(path.join(dir, f)).split(/\r?\n/)) {
      if (!raw || raw.length > 4000 || !isProblem(raw)) continue
      const line = clean(raw, names).slice(0, 240)
      const key = groupOf(source, line)
      const g = st().groups[key] ||= { source, line, first: at, today: 0, yesterday: 0, total: 0, day: d }
      g.line = line; g.last = at; g.today++; g.total++
    }
  }
  // The 80 groups seen last are kept.
  const all = Object.entries(st().groups).sort((a, b) => (a[1].last < b[1].last ? 1 : -1))
  if (all.length > 80) state.groups = Object.fromEntries(all.slice(0, 80))
  save()
}

// ---------------------------------------------------------------- runs --
const since = (now) => new Date(new Date(today(now) + 'T00:00:00').getTime()).toISOString()
/** Today's runs that failed or stopped, and where. */
export async function badRuns(db, names, now = new Date()) {
  try {
    const rows = await db('run_history').whereIn('outcome', ['failed', 'stopped', 'cancelled']).where('started_at', '>=', since(now))
      .orderBy('started_at', 'desc').limit(30).select('workflow', 'workflow_id', 'site', 'outcome', 'reason', 'step', 'started_at', 'duration_s')
    return rows.map(r => ({ workflow: r.workflow || r.workflow_id, site: r.site, outcome: r.outcome, step: clean(r.step, names).slice(0, 160), reason: clean(r.reason, names).slice(0, 200), at: r.started_at, duration_s: r.duration_s }))
  } catch { return [] }
}
/** The 10 slowest steps of the day: the longest gaps between one line of a run's log and the next. */
export async function slowSteps(db, names, now = new Date()) {
  const out = new Map()
  try {
    const rows = await db('automation_queue').where('updated_at', '>=', since(now)).orderBy('id', 'desc').limit(200).select('workflow_id', 'log')
    for (const r of rows) {
      let log = []; try { log = JSON.parse(r.log || '[]') } catch {}
      for (let i = 0; i + 1 < log.length; i++) {
        const ms = Date.parse(log[i + 1]?.ts) - Date.parse(log[i]?.ts)
        if (!(ms > 0) || ms > 3 * 3600e3) continue
        const step = clean(log[i].msg, names).slice(0, 120)
        const k = `${r.workflow_id}|${groupOf('', step)}`
        const s = out.get(k) || { workflow: r.workflow_id, step, max_s: 0, total_s: 0, times: 0 }
        s.max_s = Math.max(s.max_s, Math.round(ms / 100) / 10); s.total_s += ms / 1000; s.times++
        out.set(k, s)
      }
    }
  } catch {}
  return [...out.values()].sort((a, b) => b.max_s - a.max_s).slice(0, 10).map(s => ({ ...s, avg_s: Math.round(s.total_s / s.times * 10) / 10, total_s: undefined }))
}

// ------------------------------------------------------------- the PC --
/** How busy the processor is, from two looks a second apart (Windows has no load average). */
export async function cpuBusy(ms = 1000) {
  const take = () => os.cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, all: a.all + t } }, { idle: 0, all: 0 })
  const a = take(); await new Promise(r => setTimeout(r, ms)); const b = take()
  const all = b.all - a.all
  return all > 0 ? Math.round((1 - (b.idle - a.idle) / all) * 100) : null
}

/** The report itself. version(): this PC's version. */
export async function buildReport(db, { version = () => null, cpuMs = 1000, now = new Date() } = {}) {
  const names = await knownNames(db).catch(() => new Set())
  readLogs(names, { now })
  const disk = await import('./pcHealth.js').then(p => p.diskFree()).catch(() => null)
  const net = await import('./netQuality.js').then(n => n.ownNet()).catch(() => null)
  const M = await import('./mainPC.js').catch(() => ({}))
  const day = today(now)
  return {
    v: 1,
    at: now.toISOString(),
    pc_name: os.hostname().slice(0, 60),
    pc_number: M.pcNumber?.() || null,
    role: M.isCompanion?.() ? 'companion' : M.isFollower?.() ? 'follower' : 'main',
    version: (() => { try { const v = version(); return (v && typeof v === 'object' ? v.sha : v) || null } catch { return null } })(),
    sys: {
      ram_free_mb: Math.round(os.freemem() / 1048576), ram_total_mb: Math.round(os.totalmem() / 1048576),
      disk_free_mb: disk?.free_mb ?? null, cpu_busy: await cpuBusy(cpuMs).catch(() => null), cores: os.cpus().length,
      node_mb: Math.round(process.memoryUsage().rss / 1048576), uptime_min: Math.round(process.uptime() / 60),
    },
    net: net ? { mbps: net.mbps ?? null, rtt_ms: net.rtt_ms ?? null, ok: net.ok ?? null, at: net.at || null } : null,
    errors: Object.values(st().groups).filter(g => g.today || g.yesterday).sort((a, b) => (a.last < b.last ? 1 : -1)).slice(0, 40)
      .map(({ day: d, ...g }) => ({ ...g, today: d === day ? g.today : 0 })),
    runs_failed: await badRuns(db, names, now),
    slow_steps: await slowSteps(db, names, now),
  }
}

// ------------------------------------------------------------- sending --
const upsert = (cloud, me, data) => cloud('POST', '/rest/v1/keep_meta?on_conflict=agency_id,key',
  [{ agency_id: me, key: KEY, data, updated_at: data.at }], { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })

/** One report now: { sent } or { waited } (a run has the internet) or { off }. link: { cloud, me } (tests). */
export async function reportOnce(db, { version, link = null, focus = null } = {}) {
  if (!reportsOn()) return { off: true }
  const RF = focus || await import('./runFocus.js').catch(() => null)
  if (RF?.held?.('the PC report')) return { waited: true }
  let cloud = link?.cloud, me = link?.me
  if (!cloud) {
    const C = await import('./chatCloud.js')
    if (!C.chatConfigured()) return { off: true, why: 'no online account here' }
    me = await C.cloudAgencyId(db)
    cloud = (m, p, b, o) => C.cloudCall(db, m, p, b, o)
  }
  if (!me) return { off: true, why: 'not signed in online' }
  const data = await buildReport(db, { version })
  await upsert(cloud, me, data)
  return { sent: true, data }
}

let started = false
export function startReports(db, { version } = {}) {
  if (started || !reportsOn() || process.env.NODE_ENV === 'test') return
  started = true
  const loop = async () => {
    let wait = REPORT_MS
    try {
      const r = await reportOnce(db, { version })
      if (r.waited) wait = 60_000                // tried again a minute later, after the run
      if (r.off) wait = 30 * 60_000
    } catch (e) { console.warn('[pc report]', e.message); wait = 10 * 60_000 }
    setTimeout(loop, wait).unref?.()
  }
  setTimeout(loop, 2 * 60_000).unref?.()
}
