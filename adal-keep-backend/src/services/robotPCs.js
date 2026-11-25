/**
 * robotPCs.js — the office's PCs that can do robot work, known to the program that runs the robots.
 *
 * Why (2026-11-25): a Companion announces itself to Adal Keep (POST /companion/robot-browser), which kept it in
 * memory — but the runs are placed in Adal Robots, another program, whose list was always empty: "no stronger office
 * PC is on" on a 2-core main PC with an 8-core one beside it. Now the announcements are kept in data/robot-pcs.json
 * (this user only: it holds the Companions' tokens, new at each start of theirs), and just before a run each PC is
 * asked how it is (at most 0.6 s, all at once): one missed announcement is not "gone", and one gone is not chosen.
 */
import fs from 'fs'
import path from 'path'

const FILE = () => path.resolve(process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data'), 'robot-pcs.json')
export const KNOWN_MS = 12 * 3600e3        // heard from in the last 12 hours: worth asking
let written = 0, pending = null, seen = { mtime: 0, list: [] }

/** Adal Keep: the announcements as they are now (written at most every 2 s; whole, then put in place). */
export function keepAnnounced(list, now = Date.now()) {
  const put = () => {
    pending = null; written = Date.now()
    try {
      const f = FILE()
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f + '.new', JSON.stringify(list()), { mode: 0o600 })
      fs.renameSync(f + '.new', f)
    } catch (e) { console.warn('[robots] the office\'s PCs not kept:', e.message) }
  }
  if (pending) return
  if (now - written > 2000) put()
  else { pending = setTimeout(put, 2000); pending.unref?.() }
}

/** What Adal Keep last heard, read again only when it changed. */
export function announced(now = Date.now()) {
  try {
    const m = fs.statSync(FILE()).mtimeMs
    if (m !== seen.mtime) seen = { mtime: m, list: JSON.parse(fs.readFileSync(FILE(), 'utf8')) }
  } catch { seen = { mtime: 0, list: [] } }
  return (Array.isArray(seen.list) ? seen.list : []).filter(d => d?.id && d.token && now - Number(d.at || 0) < KNOWN_MS)
}

/**
 * How is this PC now? GET /robot/now with its token.
 * → { reachable, answers, ...power } (an older Companion has no such address: reachable, answers false)
 */
export async function askPC(d, ms = 600, fetchFn = fetch) {
  const host = String(d.ip).includes(':') ? `[${d.ip}]` : d.ip
  try {
    const r = await fetchFn(`http://${host}:${d.port}/robot/now`, { headers: { 'x-adal-robot': d.token }, signal: AbortSignal.timeout(ms) })
    if (!r.ok) return { reachable: true, answers: false }
    const j = await r.json()
    const n = (v) => (v == null || !Number.isFinite(Number(v)) ? undefined : Number(v))
    const p = { cores: n(j.cores), mem_gb: n(j.mem_gb), free_gb: n(j.free_gb), load: n(j.load), battery: j.battery === true, updating: j.updating === true, browser: j.browser !== false, version: j.version ? String(j.version).slice(0, 20) : d.version }
    return { reachable: true, answers: true, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) }
  } catch { return { reachable: false, answers: false } }
}

/** All of them at once: those that can be reached now, with how they are. */
export async function askAll(list, { ms = 600, fetchFn = fetch, now = Date.now() } = {}) {
  const got = await Promise.all(list.map(async d => ({ d, a: await askPC(d, ms, fetchFn) })))
  return got.filter(x => x.a.reachable).map(({ d, a }) => ({ ...d, ...a, at: now }))
}
export const _resetForTest = () => { written = 0; clearTimeout(pending); pending = null; seen = { mtime: 0, list: [] } }
