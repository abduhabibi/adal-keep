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
let ownNet = () => null
import('./netQuality.js').then(n => { ownNet = n.ownNet }).catch(() => {})
export function ownPower() {
  return { id: '', name: os.hostname(), cores: os.cpus()?.length || 1, mem_gb: os.totalmem() / GB, free_gb: os.freemem() / GB, load: lastLoad ?? 30, net: ownNet(), lan: true }
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

// ── the PC that finishes first (asked on 2026-11-21) ────────────────────────
// "When any PC asks for a robot run, Adal Keep picks the PC that will finish
// fastest": its cores and how busy they are now, its free memory, its internet
// (how fast and how reliably it reaches the portals), whether its Adal Browser
// already has the site open and signed in for that account, and what it does
// already. Office network only: a PC that is not on it is never given work.

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^127\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i]
/** An address on the office network (or this PC itself): never one on the internet. */
export function isLanAddress(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '').trim()
  return !!a && PRIVATE.some(r => r.test(a))
}

/**
 * About how many seconds one robot run takes on this PC now (smaller is
 * better). Rough, but every part is what makes a run slow in practice:
 *   page work: ~120 core-seconds, a browser uses at most ~4 cores;
 *   memory: under 3 GB free the pages wait for the disk;
 *   internet: ~150 answers from the portal and ~25 MB of pages, tried again
 *     when an answer does not come (reliability);
 *   sign-in: 60 s (a code, a captcha); 20 s with the site open there; none
 *     when its tab is signed in there;
 *   another PC: its files go over the office network first (~5 s);
 *   what it does already: each run there waits ~5 minutes more.
 */
export function estimate(p, { running = 0, tab = null, remote = false } = {}) {
  if (!p) return Infinity
  const cores = Math.min(Math.max(Number(p.cores) || 1, 1), 16)
  const idle = 1 - Math.min(100, Math.max(0, Number(p.load ?? 50))) / 100
  const cpu = Math.max(0.25, Math.min(4, cores * idle))
  const free = Number(p.free_gb ?? 1)
  const net = p.net || {}
  const rtt = Number(net.rtt_ms ?? 400), mbps = Number(net.mbps ?? 4), ok = Math.max(0.3, Math.min(1, Number(net.ok ?? 0.9)))
  const work = 120 / cpu
  const memory = free < 1.5 ? 90 : free < 3 ? 20 : 0
  const internet = (150 * rtt / 1000 + (25 * 8) / Math.max(0.3, mbps)) / ok
  const signIn = tab?.signedIn ? 0 : tab ? 20 : 60
  const total = work + memory + internet + signIn + (remote ? 5 : 0) + running * 300
  return Math.round((p.battery ? total * 1.15 : total) * 10) / 10
}

/**
 * Where this run finishes first. `from`: the PC that asked ('' = the main PC).
 * `tabs`: pc id → { signedIn } where its site (and account) is open already.
 * A PC that never said how strong it is (an older Companion) and one off the
 * office network are never given work. It stays where it was asked unless
 * another PC is clearly faster (15 % and 15 s), so runs do not hop about.
 * → { to, help, secs: { id: seconds }, why }
 */
export function chooseBest({ from = '', pcs = [], running = {}, tabs = {}, mainAllowed = true }) {
  const origin = pcs.find(p => p.id === from)
  if (!origin) return { to: from, help: false, secs: {}, why: '' }
  const known = (p) => p.id === '' || (p.mem_gb != null && p.lan !== false)
  const secs = {}
  for (const p of pcs) {
    if (p.id !== from && (!known(p) || (p.id === '' && !mainAllowed))) continue
    secs[p.id] = estimate(p, { running: running[p.id] || 0, tab: tabs[p.id] || null, remote: p.id !== '' })
  }
  const mine = secs[from]
  const best = Object.entries(secs).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]
  if (!best || best[0] === from || !(best[1] <= mine * 0.85 && mine - best[1] >= 15)) return { to: from, help: false, secs, why: '' }
  const to = best[0], b = pcs.find(p => p.id === to)
  const why = tabs[to]?.signedIn && !tabs[from]?.signedIn ? 'its tab is signed in already'
    : (b.net?.rtt_ms != null && origin.net?.rtt_ms != null && b.net.rtt_ms * 1.5 < origin.net.rtt_ms) ? 'its internet is faster'
    : 'it is stronger and less busy now'
  return { to, help: true, secs, why }
}

// The browsers to look in: this PC's (when open) and the Companions' this PC is connected to (none is opened).
async function openBrowsers() {
  const out = []
  try { const b = await (await import('./browser.js')).openBrowserIfAny(); if (b) out.push({ device: '', browser: b }) } catch {}
  try { for (const x of await (await import('./remoteBrowsers.js')).connectedBrowsers()) out.push({ device: x.id, browser: x.browser }) } catch {}
  return out
}
const within = (p, ms, d) => Promise.race([Promise.resolve(p), new Promise(r => setTimeout(() => r(d), ms))]).catch(() => d)
const signedInUrl = (url) => { try { return !/\/(auth|login|signin|sign-in)/i.test(new URL(url).pathname) } catch { return false } }

/**
 * Where each PC already has this run's site open: { pcId: { signedIn } }, in
 * its account's own space only (another account's tab is another sign-in).
 */
export async function tabsOnPCs(db, job, { browsers = null, spaceOf = null } = {}) {
  const tm = await import('./tabManager.js')
  const host = tm.siteOfWorkflow(job.workflow_id)
  if (!host) return {}
  let acct = job.account_id
  if (!acct) { try { acct = JSON.parse(job.context || '{}').account_id } catch {} }
  const want = await tm.spaceKeyForAccount(db, tm.peerOf(job.workflow_id), acct).catch(() => '')
  spaceOf = spaceOf || (await import('./browser.js')).spaceOf
  const found = {}
  for (const b of browsers || await openBrowsers()) {
    for (const page of await within(b.browser.pages(), 4000, [])) {
      let url = ''
      try { url = page.url() } catch {}
      if (!host.test(url)) continue
      let key = '?'
      try { key = page.browserContext() === page.browser().defaultBrowserContext() ? '' : (spaceOf(page) || '?') } catch {}
      if (key !== want) continue
      found[b.device] = { signedIn: signedInUrl(url) || !!found[b.device]?.signedIn }
    }
  }
  return found
}

const mins = (s) => s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`

/**
 * Before a robot run starts (once): the PC that finishes it first does it, out
 * of sight there. The run's context then says where (on_device), for whom
 * (helped_for) and that it works out of sight (quiet). A line for its log, or ''.
 */
export async function placeRun(db, job, { mainAllowed = true, pcs = null, tabs = null } = {}) {
  let ctx = {}
  try { ctx = JSON.parse(job.context || '{}') } catch {}
  if (ctx.placed || ctx.on_main) return ''
  pcs = pcs || await officePCs()
  const from = String(ctx.on_device || '')
  tabs = tabs || await tabsOnPCs(db, job).catch(() => ({}))
  const c = chooseBest({ from, pcs, running: await runningOn(db), tabs, mainAllowed })
  ctx.placed = 1
  ctx.quiet = 1   // every robot browser works out of sight, on whatever PC (2026-11-21)
  let line = ''
  if (c.help) {
    const a = pcs.find(p => p.id === from), b = pcs.find(p => p.id === c.to)
    ctx.helped_for = a?.name || 'this PC'
    ctx.helped_by = b?.name || 'another PC'
    if (c.to) ctx.on_device = c.to; else delete ctx.on_device
    line = `${label(b)} does this run: about ${mins(c.secs[c.to])} there, ${mins(c.secs[from])} on ${a?.name || 'this PC'} (${c.why}). Watch it in Browsers`
  }
  job.context = JSON.stringify(ctx)
  const { seal } = await import('./accountVault.js')
  await db('automation_queue').where('id', job.id).update({ context: seal(job.context) })
  return line
}

/** The PC for a move (Transitions): the same choice, from this PC, with the site's open tabs counted. */
export async function placeTransition(siteUrl, { from = '', pcs = null, browsers = null } = {}) {
  pcs = pcs || await officePCs()
  let host = ''
  try { host = new URL(siteUrl).hostname } catch {}
  const tabs = {}
  if (host) {
    for (const b of browsers || await openBrowsers()) {
      for (const page of await within(b.browser.pages(), 4000, [])) {
        let url = ''
        try { url = page.url() } catch {}
        try { if (new URL(url).hostname === host) tabs[b.device] = { signedIn: signedInUrl(url) || !!tabs[b.device]?.signedIn } } catch {}
      }
    }
  }
  return chooseBest({ from, pcs, tabs })
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
