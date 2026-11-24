/**
 * Adal Robots — the robots in a program of their own (the owner, 2026-11-24: "remove the robots from Adal Keep …
 * and make the robots work as fast as possible"). A stuck robot, a slow site or a busy browser never slows or
 * blanks Adal Keep: this is another Node process, started and stopped on its own.
 *
 *  - It reads the jobs Adal Keep puts in line (automation_queue, the same SQLite file), runs them one at a time and
 *    writes back their steps, log and result: Adal Keep's pages show them as before.
 *  - Its own database connection, never held: one at most, closed after 2 s unused, a short wait for it
 *    (2026-11-24: Adal Keep stopped answering with its connection pool full).
 *  - Its own browser (the PC's Brave / Chrome / Edge, its own profile): headless on Linux, out of sight on Windows.
 *    Never a window.
 *  - A weak PC: while the processor is over 80 % busy no new run starts (it waits in line).
 *  - 127.0.0.1:4010 (this PC only, a token): the live view of a run's tab and the person's clicks (the "I'm not a
 *    robot" tick), the "needs you" list, Stop and Continue — Adal Keep passes those on (src/services/robotsLink.js).
 *
 * Start: node robots/adal-robots.mjs   (Linux: adal-robots.service; Windows: AdalRobots, hidden, with the PC)
 * Env:   ADAL_ROBOTS_PORT (4010), ADAL_CDP_PORT (9222), ADAL_ROBOTS_CPU (0.8), SQLITE_PATH (Adal Keep's file)
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

/** Over `limit` of the processor busy now (a 1-s sample; Windows has no load average)? */
export async function cpuOver(limit = CPU_LIMIT, ms = 1000) {
  const t = () => os.cpus().reduce((a, c) => { const v = Object.values(c.times); a.all += v.reduce((x, y) => x + y, 0); a.idle += c.times.idle; return a }, { all: 0, idle: 0 })
  const a = t(); await new Promise(r => setTimeout(r, ms)); const b = t()
  const all = b.all - a.all
  return all > 0 && 1 - (b.idle - a.idle) / all > limit
}

/** Adal Keep's database settings with a connection that is never held. */
export async function openDb() {
  const knexConfig = (await import('../knexfile.js')).default.development
  const knex = (await import('knex')).default
  return knex({
    ...knexConfig,
    pool: { ...knexConfig.pool, min: 0, max: 1, idleTimeoutMillis: 2000, reapIntervalMillis: 1000, acquireTimeoutMillis: 30000 },
  })
}

async function main() {
  process.chdir(BACK)                              // uploads/, data/ and the profile are found as in Adal Keep
  process.env.ADAL_ROBOT_PROCESS = '1'
  process.env.ADAL_ROBOTS_IN_APP = '1'            // the robot code runs here (Adal Keep itself runs none: services/robotsInApp.js)
  // The robots work on the agency's main PC only (a Companion's jobs reach the main PC with the rest of its data).
  const { notMainPC } = await import('../src/services/mainPC.js')
  if (notMainPC()) { say('this PC is not the agency\'s main PC: the robots work there — nothing to do here'); return }
  // Below the person's programs: on a 2-core PC Adal Keep's window and the PC answer first (its browser inherits it).
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  const token = robotsToken()
  const db = await openDb()
  await db.raw('select 1')
  const express = (await import('express')).default
  const app = express()
  app.locals.db = db
  app.use(express.json({ limit: '2mb' }))
  app.get('/health', (req, res) => res.json({ ok: true, program: 'Adal Robots', pid: process.pid, up_s: Math.round(process.uptime()) }))
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
  // A weak PC: no new run while the processor is over 80 % busy.
  let waitedSince = 0
  worker.setClaimGate(async () => {
    const busy = await cpuOver(CPU_LIMIT)
    if (busy && !waitedSince) { waitedSince = Date.now(); say(`the processor is over ${Math.round(CPU_LIMIT * 100)} % busy — the next run waits`) }
    if (!busy && waitedSince) { say(`the processor is free again after ${Math.round((Date.now() - waitedSince) / 1000)} s — runs go on`); waitedSince = 0 }
    return !busy
  })
  worker.startWorker(db)
  // What Adal Keep no longer runs itself (main.js, ROBOTS_HERE): it runs here.
  const later = (name, f) => Promise.resolve().then(f).catch(e => console.warn(`[robots] ${name}:`, e.message))
  later('sessions', async () => (await import('../src/services/sessionKeeper.js')).startSessionKeeper(db))   // a day's sign-ins kept, Wafid on standby
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
