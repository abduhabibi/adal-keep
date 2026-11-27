/**
 * Adal Robots — the robots in a program of their own (the owner, 2026-11-24: "remove the robots from Adal Keep …
 * and make the robots work as fast as possible"). A stuck robot, a slow site or a busy browser never slows or
 * blanks Adal Keep: this is another Node process, started and stopped on its own.
 *
 *  - It reads the jobs Adal Keep puts in line (automation_queue, the same SQLite file), runs them one at a time and
 *    writes back their steps, log and result: Adal Keep's pages show them as before.
 *  - Its own database connection: one at most, closed after a minute unused, a short wait for it
 *    (2026-11-24: Adal Keep stopped answering with its connection pool full).
 *  - Its own browser (the PC's Brave / Chrome / Edge, its own profile): headless on Linux, out of sight on Windows.
 *    No window, unless switched on for this PC (ADAL_ROBOTS_WINDOW=1).
 *  - A weak PC: while a run works and the processor is over 80 % busy no other starts (robots/gate.mjs).
 *  - 127.0.0.1:4010 (this PC only, a token): the live view of a run's tab and the person's clicks (the "I'm not a
 *    robot" tick), the "needs you" list, Stop and Continue — Adal Keep passes those on (src/services/robotsLink.js).
 *
 * Start: node robots/adal-robots.mjs   (Linux: adal-robots.service; Windows: AdalRobots, hidden, with the PC)
 * Env:   ADAL_ROBOTS_WINDOW=1: its browser on the screen, brought to the front when a person must tick (off: no window)
 *        ADAL_ROBOTS_PORT (4010), ADAL_CDP_PORT (9222), ADAL_ROBOTS_CPU (0.8), SQLITE_PATH (Adal Keep's file)
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.resolve(HERE, '..')
const PORT = Number(process.env.ADAL_ROBOTS_PORT) || 4010
const CPU_LIMIT = Number(process.env.ADAL_ROBOTS_CPU) || 0.8

const say = (...a) => console.log(new Date().toISOString().slice(11, 19), '[robots]', ...a)

/** The token Adal Keep sends with each call (data/robots-token, made once, this PC only). */
export function robotsToken(dir = path.join(BACK, 'data')) {
  const f = path.join(dir, 'robots-token')
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t } catch {}
  const t = crypto.randomBytes(24).toString('hex')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(f, t, { mode: 0o600 })
  return t
}

/** The processor's time so far, all cores: { all, idle } (Windows has no load average). */
export const cpuTimes = () => os.cpus().reduce((a, c) => { const v = Object.values(c.times); a.all += v.reduce((x, y) => x + y, 0); a.idle += c.times.idle; return a }, { all: 0, idle: 0 })

// (2026-11-27, Main's robots.log: "Acquire connection error: operation timed out" — opening the connection itself
// took over 30 s, again and again: closed after 2 s unused, it was opened anew for nearly every 3-15 s timer, each time
// the file and six PRAGMAs. An idle connection in WAL holds no lock: it stays a minute. Off: ADAL_ROBOTS_DB_KEEP=0.)
export const dbIdleMs = (env = process.env) => env.ADAL_ROBOTS_DB_KEEP === '0' ? 2000 : 60000

/** Adal Keep's database settings with one connection, closed after a minute unused. */
export async function openDb() {
  const knexConfig = (await import('../knexfile.js')).default.development
  const knex = (await import('knex')).default
  return knex({
    ...knexConfig,
    pool: { ...knexConfig.pool, min: 0, max: 1, idleTimeoutMillis: dbIdleMs(), reapIntervalMillis: 1000, acquireTimeoutMillis: 30000 },
  })
}

async function main() {
  process.chdir(BACK)                              // uploads/, data/ and the profile are found as in Adal Keep
  process.env.ADAL_ROBOT_PROCESS = '1'
  process.env.ADAL_ROBOTS_IN_APP = '1'            // the robot code runs here (Adal Keep itself runs none: services/robotsInApp.js)
  // The main PC's robots, and since 2026-11-27 a Companion's too (robotsEverywhere.js): a Companion takes runs from its
  // own queue only while the main PC is off (or it holds the main role); otherwise the main PC drives its browser.
  const { notMainPC } = await import('../src/services/mainPC.js')
  const E = await import('../src/services/robotsEverywhere.js')
  const mainHere = !notMainPC()
  if (!mainHere && !E.everywhereOn()) { say('this PC is not the agency\'s main PC: the robots work there — nothing to do here (ADAL_ROBOTS_EVERYWHERE=0)'); return }
  // Below the person's programs: on a 2-core PC Adal Keep's window and the PC answer first (its browser inherits it).
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  const token = robotsToken(process.env.ADAL_ROBOTS_DATA || undefined)
  const db = await openDb()
  await db.raw('select 1')
  const express = (await import('express')).default
  const app = express()
  app.locals.db = db
  app.use(express.json({ limit: '2mb' }))
  // running: the runs working here (Adal Keep's update waits for them: routes/systemUpdate.js robotsRunning).
  let runningNow = () => 0
  app.get('/health', (req, res) => res.json({ ok: true, program: 'Adal Robots', pid: process.pid, up_s: Math.round(process.uptime()), here: E.robotsMayRunHere({ main: mainHere }), running: runningNow() }))
  // Everything else: Adal Keep only (its token), never another program or PC.
  app.use((req, res, next) => (req.get('x-adal-robots') === token ? next() : res.status(403).json({ error: 'Adal Robots answers Adal Keep only' })))
  app.use('/api', (await import('../src/routes/automations.js')).default)
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s))
    s.on('error', reject)
  }).catch(e => {
    if (e.code === 'EADDRINUSE') { say(`another Adal Robots already works on this PC (port ${PORT}) — this one stops`); process.exit(0) }
    throw e
  })
  say(`working (pid ${process.pid}), this PC only on 127.0.0.1:${PORT}`)

  const worker = await import('../src/services/worker.js')
  runningNow = () => { try { return worker.queueSnapshot().running.length } catch { return 0 } }
  const ended = (await import('./lastEnd.mjs')).watchLastEnd(process.env.ADAL_ROBOTS_DATA || path.join(BACK, 'data'), { say, running: () => worker.queueSnapshot().running.length })
  // A weak PC: no new run while one of ours works and the processor is over 80 % busy (robots/gate.mjs).
  const [{ makeGate, averageLoad }, { isWaiting }, { nobodyAsked }] = await Promise.all([import('./gate.mjs'), import('../src/services/attention.js'), import('../src/services/personPress.js')])
  const load = averageLoad({ times: cpuTimes })
  const line = async () => worker.readyJobsQuery(db).orderBy('id', 'asc').limit(5)
  const pressed = async () => (await line()).some(x => !nobodyAsked(x))
  const waiting = async () => (await line()).length > 0
  const cpuGate = makeGate({ busy: async () => load.over(CPU_LIMIT), pressed, waiting, working: () => worker.queueSnapshot().running.filter(r => !isWaiting(r.runId)).length, say, limit: CPU_LIMIT })
  // A Companion: a run only while robotsEverywhere says so (said when it changes).
  let hereWas = null
  const hereGate = () => {
    if (mainHere) return true
    const h = E.robotsMayRunHere()
    if (h.may !== hereWas) { hereWas = h.may; say(h.may ? `this PC's robots take runs from its own queue — ${h.why}` : `no runs here now — ${h.why}`) }
    return h.may
  }
  worker.setClaimGate(async () => hereGate() && await cpuGate())
  worker.startWorker(db, { queueOnly: !mainHere, slot: mainHere ? null : (await import('../src/services/sync/ids.js')).currentSlot() })
  // What Adal Keep no longer runs itself (main.js, ROBOTS_HERE): it runs here.
  // (ADAL_ROBOTS_EXTRAS=0: the queue only — a scratch copy's test.)
  // (A Companion: the queue only — its scanner would make the main PC's work twice, its keeper drive the browser the
  // main PC drives.)
  const later = (name, f) => process.env.ADAL_ROBOTS_EXTRAS === '0' || !mainHere ? null : Promise.resolve().then(f).catch(e => console.warn(`[robots] ${name}:`, e.message))
  later('sessions', async () => (await import('../src/services/sessionKeeper.js')).startSessionKeeper(db))   // a day's sign-ins kept, Wafid on standby
  later('tabs', async () => (await import('../src/services/spareTabs.js')).startSpareTabs(db))                    // one Musaned tab (an earlier start's spare ones close)
  later('lines', async () => (await import('../src/services/warmLines.js')).startWarmLines(db))                   // signed-in sites' connections stay open
  later('scanner', async () => (await import('../src/services/autoScanner.js')).startScanner(db))              // new work found every 2 min
  later('wafid', async () => (await import('../src/services/wafidStatus.js')).startWafidChecker(db))
  later('contracts', async () => (await import('../src/services/musanedContracts.js')).startContractChecker(db))
  later('selection', async () => (await import('../src/services/selectionCheck.js')).startSelectionCheck(db))
  later('memory', async () => {
    const [g, b] = await Promise.all([import('../src/services/memoryGuard.js'), import('../src/services/browser.js')])
    g.startMemoryGuard({
      working: () => worker.queueSnapshot().running.length,
      quit: async () => { const br = await b.openBrowserIfAny().catch(() => null); if (!br) return; const pages = await br.pages().catch(() => []); if (pages.some(p => p.__adalBorrowed || p.__adalPerson)) return; await b.quitBrowser() },
    })
  })
  // Stopped in Adal Keep (its Stop wrote 'cancelled'): the run here stops at its next step.
  const { markCancelled } = await import('../src/services/cancellation.js')
  const watch = setInterval(async () => {
    const ids = worker.queueSnapshot().running.map(r => Number(r.runId))
    if (!ids.length) return
    const rows = await db('automation_queue').whereIn('id', ids).select('id', 'status').catch(() => [])
    for (const r of rows) if (r.status === 'cancelled') markCancelled(r.id)
  }, 3000)
  watch.unref?.()

  const stop = async (sig) => {
    say(`${sig}: stopping (the runs working now go on after the next start)`)
    clearInterval(watch)
    ended.stopped(sig)
    try { worker.stopWorker() } catch {}
    server.close()
    await db.destroy().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('unhandledRejection', (e) => console.warn('[robots] unhandled:', e?.message || e))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('[robots] could not start:', e); process.exit(1) })
}
