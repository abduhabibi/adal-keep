/**
 * sharePower.js — the office's PCs share their power (asked on 2026-11-20:
 * "if my PC is a bit old … it will send the thing that needs computation and
 * the other PC will do the work and send it back … even working on my browser
 * can work, because LAN is too fast").
 *
 * The heavy work in Adal Keep is the browser: every robot run is a whole
 * website in Adal Browser, and every CV PDF is drawn in one. The data and the
 * robots' steps stay on the main PC; only the browser work goes to the PC that
 * does it best — the strongest Companion on the office network, even while
 * someone works on it (in a window out of sight there, never over their work).
 * The person who started it watches it, and answers it, in the live view here.
 *
 * Every Companion says every 20 s how strong it is now (adal-companion
 * robot.go: cores, memory, free memory, how busy, on battery). This PC
 * measures itself. A weak or busy PC gives its heavy work away; a strong one
 * keeps its own and does the others' too.
 */
import os from 'os'

// ── this PC, measured ───────────────────────────────────────────────────────
let lastTimes = null, lastLoad = null
function sampleLoad() {
  const cpus = os.cpus() || []
  let idle = 0, total = 0
  for (const c of cpus) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle }
  if (lastTimes && total > lastTimes.total) lastLoad = Math.round(100 * (1 - (idle - lastTimes.idle) / (total - lastTimes.total)))
  lastTimes = { idle, total }
}
sampleLoad()
setInterval(sampleLoad, 10000).unref?.()

const GB = 1024 ** 3
export function ownPower() {
  return { id: '', name: os.hostname(), cores: os.cpus()?.length || 1, mem_gb: os.totalmem() / GB, free_gb: os.freemem() / GB, load: lastLoad ?? 30 }
}

// ── how strong, how weak ────────────────────────────────────────────────────
/** Room for heavy work now: processor left over + free memory, less what it already does. */
export function score(p, running = 0) {
  if (!p) return 0
  const cores = Math.min(Number(p.cores) || 1, 16)
  const idle = 1 - Math.min(100, Math.max(0, Number(p.load ?? 50))) / 100
  const free = Math.min(Number(p.free_gb ?? 1), 12)
  return (cores * idle + free) * (p.battery ? 0.7 : 1) - running * 1.5
}

/** A PC that should not carry a whole website itself: little memory, little free, or very busy. */
export function isWeak(p, running = 0) {
  if (!p) return true
  return (Number(p.mem_gb) || 4) < 7 || (Number(p.free_gb) || 0) < 1.5 + running * 0.6 || Number(p.load ?? 0) > 80
}

/**
 * Who does this browser work. `from`: the PC it was started on ('' = this
 * main PC, else a Companion's id). `pcs`: this PC first ({id:''}) and the
 * Companions there now; `running`: id → robot runs it does now.
 * → { to, help }  (help: done by another PC than the one it came from)
 */
export function choose({ from = '', pcs = [], running = {}, mainAllowed = true }) {
  const origin = pcs.find(p => p.id === from)
  if (!origin) return { to: from, help: false }
  const busy = (p) => running[p.id] || 0
  if (!isWeak(origin, busy(origin))) return { to: from, help: false }
  const mine = score(origin, busy(origin))
  const best = pcs
    .filter(p => p.id !== from && (p.id !== '' || mainAllowed) && !isWeak(p, busy(p)))
    .map(p => ({ p, s: score(p, busy(p)) }))
    .sort((a, b) => b.s - a.s || String(a.p.id).localeCompare(String(b.p.id)))[0]
  if (!best || best.s < Math.max(mine * 1.3, mine + 2)) return { to: from, help: false }
  return { to: best.p.id, help: true }
}

// ── the office now ──────────────────────────────────────────────────────────
/** This PC and every Companion there, with how strong each is now. */
export async function officePCs() {
  const rb = await import('./remoteBrowsers.js')
  return [ownPower(), ...rb.liveDevices().map(d => ({ ...d }))]
}

/** Robot runs each PC's browser does now ('' = this PC). */
export async function runningOn(db) {
  const out = {}
  for (const r of await db('automation_queue').where('status', 'running').select('context')) {
    let d = ''
    try { d = String(JSON.parse(r.context || '{}').on_device || '') } catch {}
    out[d] = (out[d] || 0) + 1
  }
  return out
}

const label = (p) => p ? `${p.name || 'a PC'} (${Math.round(p.mem_gb || 0)} GB, ${p.cores || 1} cores)` : 'a PC'

/**
 * Before a robot run starts (once): a weak PC's run goes to the strongest PC.
 * The run's context then says where (on_device), for whom (helped_for) and
 * that it works out of sight there (quiet). Returns a line for its log, or ''.
 */
export async function placeRun(db, job, { mainAllowed = true } = {}) {
  let ctx = {}
  try { ctx = JSON.parse(job.context || '{}') } catch {}
  if (ctx.placed || ctx.on_main) return ''
  const pcs = await officePCs()
  const from = String(ctx.on_device || '')
  const c = choose({ from, pcs, running: await runningOn(db), mainAllowed })
  ctx.placed = 1
  let line = ''
  if (c.help) {
    const a = pcs.find(p => p.id === from), b = pcs.find(p => p.id === c.to)
    ctx.helped_for = a?.name || 'this PC'
    ctx.helped_by = b?.name || 'another PC'
    ctx.quiet = 1
    if (c.to) ctx.on_device = c.to; else delete ctx.on_device
    line = `${a?.name || 'This PC'} is busy — ${label(b)} does the work for it, out of sight there; watch and answer it here`
  }
  job.context = JSON.stringify(ctx)
  const { seal } = await import('./accountVault.js')
  await db('automation_queue').where('id', job.id).update({ context: seal(job.context) })
  return line
}

/**
 * For a CV PDF (no run): the strongest Companion's browser when this PC is
 * weak, else null (drawn here as before).
 */
export async function helperForPdf() {
  const pcs = await officePCs()
  const c = choose({ from: '', pcs })
  return c.help && c.to ? c.to : null
}

/** For Settings: every PC, how strong it is now, and what it does. */
export async function shareReport(db) {
  const running = await runningOn(db).catch(() => ({}))
  const pcs = await officePCs()
  return pcs.map(p => ({
    id: p.id, name: p.name, here: p.id === '', cores: p.cores, mem_gb: p.mem_gb != null ? Math.round(p.mem_gb * 10) / 10 : null,
    free_gb: p.free_gb != null ? Math.round(p.free_gb * 10) / 10 : null, load: p.load ?? null, battery: !!p.battery,
    runs: running[p.id] || 0, weak: isWeak(p, running[p.id] || 0), score: Math.round(score(p, running[p.id] || 0) * 10) / 10,
  }))
}
