/**
 * runFocus.js — while a robot run works, the PC's internet is the run's (the owner, 2026-11-26: "whenever only one
 * robot is working, you need to concentrate the internet into that"; Main is on a ~5 Mbit/s Wi-Fi stick).
 *
 * The robots (their own process, or in the app) say so in data/run-focus.json, written every 3 s while a run works and
 * good for 15 s only: a run that ends — or a process that crashes — frees the line within 15 s by itself. Everything
 * else that uses the internet asks held('what') at the start of its round and, while held, gives that round up;
 * later('what', fn) does it again within ~2 s of the last run ending. LMIS codes, the phones' live channel, the PCs'
 * copying over the office network and anything a run itself does are never held.
 * Off: ADAL_RUN_FOCUS=0 (nothing held). Errors: nothing held.
 */
import fs from 'fs'
import path from 'path'

export const focusOn = (env = process.env) => env.ADAL_RUN_FOCUS !== '0'
export const FOCUS_MS = 15000, BEAT_MS = 3000
const FILE = () => path.resolve(process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data'), 'run-focus.json')

let seen = { at: 0, until: 0, runs: 0 }
function fromFile(now) {
  if (now - seen.at < 1000) return seen
  let f = {}
  try { f = JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch {}
  seen = { at: now, until: Number(f.until) || 0, runs: Number(f.runs) || 0 }
  return seen
}

let localRuns = () => 0
/** How many runs work on this PC now (this process's own, else what the robots' file says). */
export function runsNow(now = Date.now()) {
  let n = 0
  try { n = localRuns() || 0 } catch {}
  if (n) return n
  const f = fromFile(now)
  return f.until > now ? f.runs || 1 : 0
}

const told = new Set()
/** Should `what` (a background job that uses the internet) give up this round? Said once a focus. */
export function held(what, now = Date.now()) {
  try {
    if (!focusOn()) return false
    const n = runsNow(now)
    if (!n) return false
    if (!told.has(what)) { told.add(what); console.log(`[focus] ${what} waits — ${n} robot run(s) have the internet`) }
    watch()
    return true
  } catch { return false }
}

const waiting = new Map()
/** Do `fn` again once no run works (the last one for each `what`). */
export function later(what, fn) { waiting.set(what, fn); watch() }

let timer = null
function watch() {
  if (timer) return
  timer = setInterval(() => {
    if (runsNow() > 0) return
    clearInterval(timer); timer = null
    if (told.size) console.log(`[focus] the run ended — ${[...told].join(', ')} go on`)
    told.clear()
    const go = [...waiting.values()]; waiting.clear()
    for (const fn of go) Promise.resolve().then(fn).catch(e => console.warn('[focus]', e.message))
  }, 2000)
  timer.unref?.()
}

/** The robots' side (worker.js): `count()` is how many runs work. */
let beacon = null
export function startFocusBeacon(count) {
  localRuns = count
  if (beacon || !focusOn()) return
  let wrote = false
  beacon = setInterval(() => {
    try {
      const n = count() || 0
      if (n) { fs.writeFileSync(FILE() + '.new', JSON.stringify({ until: Date.now() + FOCUS_MS, runs: n, pid: process.pid })); fs.renameSync(FILE() + '.new', FILE()); wrote = true }
      else if (wrote) { fs.rmSync(FILE(), { force: true }); wrote = false }
    } catch {}
  }, BEAT_MS)
  beacon.unref?.()
}

export const _resetForTest = () => { seen = { at: 0, until: 0, runs: 0 }; told.clear(); waiting.clear(); localRuns = () => 0; if (beacon) clearInterval(beacon); beacon = null; if (timer) clearInterval(timer); timer = null }
