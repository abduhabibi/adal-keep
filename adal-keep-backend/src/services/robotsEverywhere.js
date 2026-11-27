/**
 * robotsEverywhere.js — the robots work on every PC of the agency, not only on the main PC (the owner, 2026-11-27:
 * "Main may be off while a Companion works; Main is only a name for connecting the PCs").
 *
 * Where may this PC's Adal Robots take runs from its own queue?
 *  - the main PC: always (as before);
 *  - a Companion with its own full copy: while it holds the main role, or while the main PC has not answered this
 *    PC's copying for 45 s (120 s when it was never reached since the start). While the main PC answers, the main PC
 *    runs the robots and drives this PC's browser over the office network, as before.
 * The server (it has the copying) writes the answer to data/robots-here.json every 5 s, good for 15 s; Adal Robots
 * (its own process) reads it. ADAL_ROBOTS_HERE=1|0 forces it (a test). Off: ADAL_ROBOTS_EVERYWHERE=0 (a Companion's
 * robots do nothing, as before). Never throws: in doubt, not here.
 */
import fs from 'fs'
import path from 'path'

export const everywhereOn = (env = process.env) => env.ADAL_ROBOTS_EVERYWHERE !== '0'
export const DOWN_MS = 45000, NEVER_MS = 120000, FRESH_MS = 15000, EVERY_MS = 5000
const FILE = () => path.resolve(process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data'), 'robots-here.json')

let downSince = 0
const startedAt = Date.now()
/**
 * Pure but for `downSince`: { may, why }.
 * main: this PC is the agency's main PC (mainPC.notMainPC() false). full: a Companion with its full copy on.
 * node: the PC copying (sync/node.js) — its roles and what it heard from each PC.
 */
export function decide({ main, full, node, env = process.env, now = Date.now() }) {
  if (env.ADAL_ROBOTS_HERE === '1') return { may: true, why: 'forced on (ADAL_ROBOTS_HERE=1)' }
  if (env.ADAL_ROBOTS_HERE === '0') return { may: false, why: 'forced off (ADAL_ROBOTS_HERE=0)' }
  if (main) return { may: true, why: 'the main PC' }
  if (!everywhereOn(env)) return { may: false, why: 'robots on the main PC only (ADAL_ROBOTS_EVERYWHERE=0)' }
  if (!full) return { may: false, why: 'no full copy on this PC: the main PC runs the robots' }
  if (!node) return { may: false, why: 'not copying with the agency yet' }
  try {
    if (node?.roles?.isMain?.()) { downSince = 0; return { may: true, why: 'this PC holds the main role' } }
    const holder = node?.roles?.holder?.()
    const st = holder ? node.peerState?.get?.(holder) : null
    if (st?.ok) { downSince = 0; return { may: false, why: 'the main PC is on: it runs the robots and drives this PC\'s browser' } }
    if (!st) return now - startedAt >= NEVER_MS ? { may: true, why: `the main PC not reached since the start (${Math.round((now - startedAt) / 1000)} s)` } : { may: false, why: 'waiting to hear from the main PC' }
    downSince = downSince || now
    const s = Math.round((now - downSince) / 1000)
    return now - downSince >= DOWN_MS ? { may: true, why: `the main PC has not answered for ${s} s` } : { may: false, why: `the main PC did not answer (${s} s) — waiting ${Math.round(DOWN_MS / 1000)} s` }
  } catch { return { may: false, why: 'not known' } }
}

/** The server: the answer written every 5 s (only on a PC that is not the main PC; the main PC needs none). */
let timer = null, last = ''
export function startRobotsHere({ main, full, node, log = console.log } = {}) {
  if (timer) return
  const write = () => {
    try {
      const r = decide({ main: main(), full: full(), node: node() })
      fs.mkdirSync(path.dirname(FILE()), { recursive: true })
      fs.writeFileSync(FILE() + '.new', JSON.stringify({ ...r, at: Date.now() })); fs.renameSync(FILE() + '.new', FILE())
      const line = `${r.may ? 'takes runs' : 'no runs'} — ${r.why.replace(/\d+ s/g, 'n s')}`
      if (line !== last) { last = line; log(`[robots-here] this PC's robots: ${r.may ? 'take runs' : 'no runs'} — ${r.why}`) }
    } catch {}
  }
  write()
  timer = setInterval(write, EVERY_MS); timer.unref?.()
}

/** Adal Robots: may it take a run now? The file, while fresh; ADAL_ROBOTS_HERE first. */
export function robotsMayRunHere({ main = false, env = process.env, now = Date.now() } = {}) {
  if (env.ADAL_ROBOTS_HERE === '1') return { may: true, why: 'forced on (ADAL_ROBOTS_HERE=1)' }
  if (env.ADAL_ROBOTS_HERE === '0') return { may: false, why: 'forced off (ADAL_ROBOTS_HERE=0)' }
  if (main) return { may: true, why: 'the main PC' }
  if (!everywhereOn(env)) return { may: false, why: 'robots on the main PC only (ADAL_ROBOTS_EVERYWHERE=0)' }
  try {
    const f = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (now - Number(f.at || 0) > FRESH_MS) return { may: false, why: 'Adal Keep has not said for 15 s' }
    return { may: !!f.may, why: String(f.why || '') }
  } catch { return { may: false, why: 'Adal Keep has not said yet' } }
}

/** The Companion program starts its robot browser (out of sight) when it is closed: ADAL_ROBOT_BROWSER_URL + token. */
export async function startCompanionBrowser({ url = process.env.ADAL_ROBOT_BROWSER_URL, token = process.env.ADAL_ROBOT_TOKEN, fetchFn = fetch } = {}) {
  if (!url || !token) throw new Error('No Companion robot browser to start (ADAL_ROBOT_BROWSER_URL / ADAL_ROBOT_TOKEN)')
  const r = await fetchFn(`${url.replace(/\/+$/, '')}/json/version?quiet=1`, { headers: { 'x-adal-robot': token }, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`the Companion's robot browser did not start (${r.status})`)
  return true
}

export const _resetForTest = () => { downSince = 0; if (timer) clearInterval(timer); timer = null; last = '' }
