/**
 * tower.js — Adal's control tower (Adal Keep Admin → Fleet), over the internet:
 * no SSH, no LAN, no new tables. Everything goes through this PC's own rows of
 * keep_meta (its online account: agency_id = its own sign-in, which the
 * keep_meta rules already let it write):
 *
 *   /_tower/beat   this PC, every 60 s: who and what it is, how busy, robots,
 *                  last error, crash reports grouped by message (no personal data);
 *   /_tower/cmds   written by Admin (service key): commands, each one signed
 *                  by Adal's tower key (Ed25519, ~/.adal-keep/tower-signing.pem on
 *                  Adal's PC). A command runs only if its signature is right, it
 *                  names this PC's account, it has not expired and never ran before;
 *   /_tower/acks   this PC's answer to each command (refused / running / done / failed + result);
 *   /_tower/flag   written by Admin, signed: the tower is open for this PC.
 *
 * Behind a flag: on by itself only for the "Adal Test" agency (or a signed
 * /_tower/flag, or ADAL_TOWER=1; ADAL_TOWER=0 turns it off everywhere).
 * Collected logs go to the private "keep" bucket, <account>/_support/logs/…,
 * with passwords, keys, passport numbers and phone numbers hidden.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = () => process.env.ADAL_TOWER_DATA || path.join(BACKEND, 'data')
const PORT = () => Number(process.env.PORT) || 4000

// The public half of Adal's tower key (the private half never leaves Adal's PC).
export const TOWER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF4PqpNepJ8OcYL3v0/BUp7BWYd4AXmpGBMP8cpnddlQ=
-----END PUBLIC KEY-----`
let verifyKey = TOWER_PUBLIC_KEY
export const _setTowerKeyForTests = (pem) => { verifyKey = pem || TOWER_PUBLIC_KEY }

export const KINDS = ['restart', 'cancel_runs', 'collect_logs', 'self_check', 'update_now', 'suspend', 'resume', 'support_note', 'ticket_reply']
export const BEAT_MS = 60_000
const POLL_MS = 20_000
const FLAG_MS = 10 * 60_000
// The owner's test agency is "Test agency" in Supabase (also "Adal Test agency").
export const TEST_AGENCY = /^\s*(adal\s+)?test\s+agency\b|\badal\s*test\b/i

// --------------------------------------------------------------- signatures --
/** A signed envelope { payload: JSON text, sig: base64 } → the payload, or null. */
export function openSigned(env) {
  if (!env || typeof env.payload !== 'string' || typeof env.sig !== 'string') return null
  try {
    if (!crypto.verify(null, Buffer.from(env.payload), verifyKey, Buffer.from(env.sig, 'base64'))) return null
    return JSON.parse(env.payload)
  } catch { return null }
}

/**
 * Whether one command may run here: { ok, cmd } or { ok: false, why }.
 * me: this PC's online account id; done: ids that already ran.
 */
export function checkCommand(env, { me, done = new Set(), now = Date.now() } = {}) {
  const cmd = openSigned(env)
  if (!cmd) return { ok: false, why: 'bad signature' }
  if (!cmd.id || !KINDS.includes(cmd.kind)) return { ok: false, why: 'unknown command', cmd }
  if (!me || cmd.target !== me) return { ok: false, why: 'not for this PC', cmd }
  if (!(Date.parse(cmd.expires_at) > now)) return { ok: false, why: 'expired', cmd }
  if (done.has(cmd.id)) return { ok: false, why: 'already done', cmd }
  return { ok: true, cmd }
}

// ------------------------------------------------------------ hiding things --
const hide = (t) => String(t ?? '')
  .replace(/((?:pass(?:word)?|pwd|token|secret|api[_-]?key|otp|cookie|authorization|bearer)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[hidden]')
  .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[token]')
  .replace(/\b[A-Z]{1,2}\d{6,9}\b/g, '[passport]')
  .replace(/\+?\d{9,13}/g, '[number]')
export const _hide = hide

// ----------------------------------------------------------------- crashes --
// Uncaught errors of this backend, the pages (React error boundaries) and the
// Go programs (launcher, Companion), grouped by message: Admin counts them per
// agency and version.
const CRASH_FILE = () => path.join(DATA(), 'tower-crashes.json')
let crashes = null
function loadCrashes() {
  if (crashes) return crashes
  try { crashes = JSON.parse(fs.readFileSync(CRASH_FILE(), 'utf8')) } catch { crashes = [] }
  if (!Array.isArray(crashes)) crashes = []
  return crashes
}
let saveTimer = null
function saveCrashesSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try { fs.mkdirSync(DATA(), { recursive: true }); fs.writeFileSync(CRASH_FILE(), JSON.stringify(crashes)) } catch {}
  }, 2000)
  saveTimer.unref?.()
}
/** The group of a message: numbers, ids and quoted parts do not make a new group. */
export const crashKey = (source, message) => `${source}|${String(message).replace(/0x[0-9a-f]+|\d+/gi, '#').replace(/'[^']*'|"[^"]*"/g, '…').replace(/\s+/g, ' ').slice(0, 200)}`
export function noteCrash({ source = 'backend', message = '', where = '', stack = '', version = null } = {}) {
  const list = loadCrashes()
  const src = String(source).replace(/[^\w-]/g, '').slice(0, 20) || 'other'
  const msg = hide(message).replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!msg) return null
  const key = crashKey(src, msg)
  const now = new Date().toISOString()
  let g = list.find(x => x.key === key)
  if (g) { g.count++; g.last = now; if (where) g.where = hide(where).slice(0, 120); if (version) g.version = String(version).slice(0, 20) }
  else {
    g = { key, source: src, message: msg, where: hide(where).slice(0, 120), stack: hide(stack).split('\n').slice(0, 6).join('\n').slice(0, 600), version: version ? String(version).slice(0, 20) : null, count: 1, first: now, last: now }
    list.push(g)
    // The 60 newest groups are kept.
    if (list.length > 60) { list.sort((a, b) => (a.last < b.last ? 1 : -1)); list.length = 60 }
  }
  saveCrashesSoon()
  return g
}
export const crashList = () => loadCrashes().slice().sort((a, b) => (a.last < b.last ? 1 : -1))
export const _resetCrashes = () => { crashes = [] }

let hooked = false
function hookCrashes() {
  if (hooked) return
  hooked = true
  // (diag.js already keeps the process alive on these: here they are only counted.)
  process.on('uncaughtException', (e) => { try { noteCrash({ source: 'backend', message: e?.message || String(e), where: 'uncaught', stack: e?.stack }) } catch {} })
  process.on('unhandledRejection', (e) => { try { noteCrash({ source: 'backend', message: e?.message || String(e), where: 'unhandled promise', stack: e?.stack }) } catch {} })
}

// ------------------------------------------------------------------- state --
// What ran here (no command runs twice) and whether robots are held.
const STATE_FILE = () => path.join(DATA(), 'tower-state.json')
let state = null
function st() {
  if (state) return state
  try { state = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) } catch { state = {} }
  state.done ||= []; state.acks ||= []; state.tickets ||= []
  return state
}
function saveState() { try { fs.mkdirSync(DATA(), { recursive: true }); fs.writeFileSync(STATE_FILE(), JSON.stringify(state)) } catch {} }
export const _resetState = () => { state = { done: [], acks: [], tickets: [] } }

/** Robots held by Adal (suspend): no new run starts on this PC; the ones working go on. */
export const towerHeld = () => !!st().held
export const towerStatus = () => ({ on: status.on, why: status.why, held: st().held || null, last_beat: status.lastBeat, error: status.error, acks: st().acks.slice(0, 10) })
const status = { on: false, why: 'not started', lastBeat: null, error: null }
// This PC's Supabase calls while the tower is on (the Help button sends with it).
let live = null
export const _setLiveForTests = (l) => { live = l }

// ---------------------------------------------------------------- the beat --
let versionOf = () => null
function versionNow() {
  const v = versionOf()
  return v?.sha || null
}

async function robots(db) {
  const out = { running: 0, waiting: 0, paused: 0 }
  try { out.running = (await import('./busy.js')).runsWorking() } catch {}
  try {
    const rows = await db('automation_queue').whereIn('status', ['pending', 'paused']).select('status').count({ c: '*' }).groupBy('status')
    for (const r of rows) out[r.status === 'pending' ? 'waiting' : 'paused'] = Number(r.c) || 0
  } catch {}
  return out
}

/** The beat: small (well under 4 KB), no personal data. */
export async function beatData(db, { agencyName = null } = {}) {
  const M = await import('./mainPC.js').catch(() => ({}))
  const cpus = os.cpus()
  const employee = await import('./activeEmployee.js').then(a => a.getActiveEmployee(db)).catch(() => null)
  const disk = await import('./pcHealth.js').then(p => p.diskFree()).catch(() => null)
  const net = await import('./netQuality.js').then(n => n.ownNet()).catch(() => null)
  const errs = await import('./diag.js').then(d => d.recentErrors?.(3) || []).catch(() => [])
  return {
    v: 1,
    at: new Date().toISOString(),
    agency: agencyName,
    role: M.isCompanion?.() ? 'companion' : M.isFollower?.() ? 'follower' : 'main',
    pc_name: os.hostname().slice(0, 60),
    pc_number: M.pcNumber?.() || null,
    employee: employee?.name ? String(employee.name).slice(0, 60) : null,
    version: versionNow(),
    os: `${os.type()} ${os.release()}`.slice(0, 60),
    cpu: { cores: cpus.length, model: String(cpus[0]?.model || '').slice(0, 60), load: os.loadavg().map(x => Math.round(x * 100) / 100) },
    ram: { total_mb: Math.round(os.totalmem() / 1048576), free_mb: Math.round(os.freemem() / 1048576), node_mb: Math.round(process.memoryUsage().rss / 1048576) },
    disk_free_mb: disk?.free_mb ?? null,
    net: net ? { rtt_ms: net.rtt_ms, mbps: net.mbps, ok: net.ok } : null,
    net_type: netType(),
    robots: await robots(db),
    held: st().held ? { at: st().held.at, note: st().held.note || '' } : null,
    uptime_min: Math.round(process.uptime() / 60),
    last_error: errs.length ? { at: errs[errs.length - 1].at, line: hide(errs[errs.length - 1].line).slice(0, 240) } : null,
    crashes: crashList().slice(0, 15).map(({ key, stack, ...g }) => g),
    last_cmd: st().acks[0] ? { id: st().acks[0].id, kind: st().acks[0].kind, status: st().acks[0].status } : null,
    // The equipment check (services/pcCheck.js: RAM, SSD, free disk, cores, cable / Wi-Fi and its speed), with PC reports on.
    ...(process.env.ADAL_PC_REPORTS === '1' ? { pc_check: await import('./pcCheck.js').then(p => p.pcCheck().then(() => p.pcCheckReport())).catch(() => null) } : {}),
  }
}

/** Wi-Fi, cable or other — from the names of the PC's network cards that have an address. */
function netType() {
  try {
    const up = Object.entries(os.networkInterfaces()).filter(([, l]) => (l || []).some(a => !a.internal && a.family === 'IPv4')).map(([n]) => n)
    if (!up.length) return 'none'
    if (up.some(n => /wi-?fi|wlan|wlp|wireless/i.test(n))) return 'wifi'
    if (up.some(n => /ethernet|^eth|^enp|^eno|^en\d/i.test(n))) return 'cable'
    if (up.some(n => /cellular|wwan|mobile|usb|rndis/i.test(n))) return 'mobile'
    return 'other'
  } catch { return null }
}

// --------------------------------------------------------------- commands --
// The PC's own API, as its own robots call it (not through the online link).
const local = (method, p, body) => fetch(`http://127.0.0.1:${PORT()}/api${p}`, {
  method,
  signal: AbortSignal.timeout(5 * 60_000),
  headers: { 'Content-Type': 'application/json', 'X-Adal-Who': encodeURIComponent('Adal support') },
  body: body == null ? undefined : JSON.stringify(body),
}).then(async r => ({ code: r.status, body: await r.json().catch(() => null) }))

function tail(file, bytes = 200 * 1024) {
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(bytes, size))
    fs.readSync(fd, buf, 0, buf.length, size - buf.length)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch { return null }
}

// Adal's switch for one agency's PCs, when its agency-config record cannot reach them
// (agency_config off on the PC): data/flags.json companion_full, then a restart (sync starts at boot).
function setCompanionFull(on, ctx) {
  const file = process.env.ADAL_FLAGS_FILE || path.join(BACKEND, 'data', 'flags.json')
  let flags = {}
  try { flags = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch {}
  flags.companion_full = on
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(flags, null, 1))
  fs.renameSync(`${file}.tmp`, file)
  ctx.after = () => setTimeout(() => process.exit(0), 1500).unref?.()
  return { companion_full: on, message: `Full copy on the Companions ${on ? 'ON' : 'OFF'} for this PC (Adal Keep starts again in a few seconds).` }
}

export const handlers = {
  async companion_full_on(db, args, ctx) { return setCompanionFull(true, ctx) },
  async companion_full_off(db, args, ctx) { return setCompanionFull(false, ctx) },
  async restart(db, args, ctx) {
    ctx.after = () => setTimeout(() => process.exit(0), 1500).unref?.()
    return { message: 'Adal Keep starts again in a few seconds (the launcher / service brings it back).' }
  },
  async cancel_runs(db) {
    const rows = await db('automation_queue').whereIn('status', ['pending', 'running', 'paused']).select('id')
    let cancelled = 0
    const failed = []
    for (const r of rows) {
      const a = await ctx_local('POST', `/automations/${r.id}/cancel`)
      if (a.code < 300) cancelled++
      else failed.push(`#${r.id}: ${a.body?.error || a.code}`)
    }
    return { cancelled, failed: failed.slice(0, 10), message: `${cancelled} run(s) cancelled${failed.length ? `, ${failed.length} could not be` : ''}.` }
  },
  async self_check(db, args, ctx) {
    const out = { version: versionNow() }
    const t0 = Date.now()
    try { await db.raw('select 1'); out.database = { ok: true, ms: Date.now() - t0 } } catch (e) { out.database = { ok: false, why: e.message } }
    try { const P = await import('./pcHealth.js'); const s = await P.checkPC(db); out.disk = s?.disk || P.diskFree(); out.freeze = s?.freeze || null } catch (e) { out.disk = { why: e.message } }
    try { const H = await import('./portalHealth.js'); await H.checkPortals({ retryMs: 0 }); out.portals = H.portalStatus().portals.map(({ name, ok, why }) => ({ name, ok, why })) } catch (e) { out.portals = { why: e.message } }
    try { const t = Date.now(); await ctx.cloud('GET', `/rest/v1/keep_meta?agency_id=eq.${ctx.me}&key=eq.${encodeURIComponent('/_tower/flag')}&select=key`); out.cloud = { ok: true, ms: Date.now() - t } } catch (e) { out.cloud = { ok: false, why: e.message } }
    out.robots = await robots(db)
    out.ram = { free_mb: Math.round(os.freemem() / 1048576), node_mb: Math.round(process.memoryUsage().rss / 1048576) }
    const bad = [out.database?.ok === false && 'database', out.cloud?.ok === false && 'internet', (out.disk?.free_mb ?? 1e9) < 3072 && 'disk', Array.isArray(out.portals) && out.portals.some(p => !p.ok) && 'portals'].filter(Boolean)
    out.message = bad.length ? `Problems: ${bad.join(', ')}` : 'All good.'
    return out
  },
  async update_now() {
    const a = await ctx_local('POST', '/system/update/apply', {})
    return { code: a.code, message: a.body?.message || a.body?.error || (a.code < 300 ? 'Update started.' : `Answer ${a.code}`) }
  },
  async suspend(db, args) {
    st().held = { at: new Date().toISOString(), note: String(args?.note || '').slice(0, 200) }
    saveState()
    await supportNote(db, `Adal support paused the robots on this PC${args?.note ? `: ${args.note}` : '.'} Runs already working go on; new ones wait.`)
    return { message: 'Robots held on this PC: no new run starts.' }
  },
  async resume(db) {
    delete st().held
    saveState()
    try { (await import('./worker.js')).drainQueue(db) } catch {}
    return { message: 'Robots work again on this PC.' }
  },
  async support_note(db, args) {
    const text = String(args?.text || '').trim().slice(0, 1000)
    if (!text) throw new Error('empty note')
    await supportNote(db, text)
    return { message: 'The note is on the PC (Notifications).' }
  },
  async collect_logs(db, args, ctx) {
    const gz = await logBundle(db)
    const name = `${ctx.me}/_support/logs/${os.hostname().replace(/[^\w-]/g, '_').slice(0, 40)}-${Date.now()}.txt.gz`
    await ctx.cloud('POST', `/storage/v1/object/keep/${name}`, gz, { headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'true' } })
    return { object: name, bytes: gz.length, message: `Logs sent (${Math.round(gz.length / 1024)} KB).` }
  },
  // Adal answered a Help ticket (and/or closed it): a notification on this PC.
  async ticket_reply(db, args, ctx) {
    const t = st().tickets.find(x => x.id === args?.ticket)
    const text = String(args?.text || '').trim().slice(0, 2000)
    const statusNow = ['open', 'answered', 'closed'].includes(args?.status) ? args.status : (text ? 'answered' : null)
    if (t) {
      if (text && !t.replies.some(r => r.id === args.reply_id)) t.replies.push({ id: args.reply_id || crypto.randomUUID(), from: 'Adal support', text, at: new Date().toISOString() })
      if (statusNow) t.status = statusNow
      saveState()
      await pushTickets(ctx.cloud, ctx.me).catch(() => {})
    }
    const about = t ? `“${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''}”` : 'your question'
    if (text) await supportNote(db, `Adal support answered ${about}: ${text}`)
    else if (statusNow === 'closed') await supportNote(db, `Adal support closed ${about}.`)
    return { message: t ? `Ticket ${statusNow || t.status}.` : 'Ticket not on this PC (answered as a note).' }
  },
}
async function logBundle(db) {
  const parts = [`Adal Keep support logs — ${os.hostname()} — ${new Date().toISOString()} — version ${versionNow() || '?'}`]
  try { const D = await import('./diag.js'); parts.push('== health ==', JSON.stringify(await D.healthReport(db, versionOf()), null, 1)) } catch (e) { parts.push(`== health == ${e.message}`) }
  parts.push('== crashes ==', JSON.stringify(crashList(), null, 1))
  for (const f of ['server.log', 'launcher.log']) parts.push(`== ${f} (end) ==`, tail(path.join(DATA(), f)) ?? '(none)')
  return zlib.gzipSync(Buffer.from(hide(parts.join('\n'))))
}

// ------------------------------------------------------------- Help tickets --
// The Help button (every page, PC and phone): a short note, maybe a picture of
// the screen. It goes to Adal with this PC's logs, version and PC; Adal answers
// from Admin → Tickets (a signed ticket_reply command) and the answer shows here
// as a notification. Online: <account>/_support/tickets/<id>/… in the private
// bucket and the list in keep_meta "/_tower/tickets". Kept here until it is online.
const pushTickets = (cloud, me) => upsertMeta(cloud, me, '/_tower/tickets', {
  at: new Date().toISOString(),
  tickets: st().tickets.filter(t => t.online).map(({ online, ...t }) => t),
})
export const ticketList = () => st().tickets.map(({ online, ...t }) => ({ ...t, sent: !!online }))

export async function createTicket(db, { text = '', image = null, who = null, page = '' } = {}, link = live) {
  const note = String(text || '').trim().slice(0, 2000)
  if (!note) throw Object.assign(new Error('Write what is wrong first.'), { code: 400 })
  if (!link?.cloud || !link?.me) throw Object.assign(new Error('Help is not open on this PC yet (no internet, or not switched on by Adal).'), { code: 503 })
  let shot = null
  if (image) {
    const m = String(image).match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/)
    if (!m) throw Object.assign(new Error('The picture must be a JPEG, PNG or WebP.'), { code: 400 })
    shot = { type: `image/${m[1]}`, buf: Buffer.from(m[2], 'base64') }
    if (shot.buf.length > 4 * 1024 * 1024) throw Object.assign(new Error('The picture is too big (4 MB at most).'), { code: 413 })
  }
  const M = await import('./mainPC.js').catch(() => ({}))
  const t = {
    id: crypto.randomUUID(), at: new Date().toISOString(), status: 'open', replies: [],
    text: hide(note), who: who ? String(who).slice(0, 60) : null, page: String(page || '').slice(0, 120),
    agency: status.agencyName || null, pc_name: os.hostname().slice(0, 60), pc_number: M.pcNumber?.() || null, version: versionNow(),
    log: null, shot: null,
  }
  const dir = `${link.me}/_support/tickets/${t.id}`
  try {
    const gz = await logBundle(db)
    await link.cloud('POST', `/storage/v1/object/keep/${dir}/log.txt.gz`, gz, { headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'true' } })
    t.log = `${dir}/log.txt.gz`
  } catch (e) { t.log_error = hide(e.message).slice(0, 200) }
  if (shot) {
    const ext = shot.type.split('/')[1].replace('jpeg', 'jpg')
    await link.cloud('POST', `/storage/v1/object/keep/${dir}/screen.${ext}`, shot.buf, { headers: { 'Content-Type': shot.type, 'x-upsert': 'true' } })
    t.shot = `${dir}/screen.${ext}`
  }
  t.online = true
  st().tickets.unshift(t)
  st().tickets = st().tickets.slice(0, 30)
  saveState()
  await pushTickets(link.cloud, link.me)
  console.log(`[tower] Help ticket sent to Adal${t.who ? ` by ${t.who}` : ''}`)
  return { ok: true, ticket: { id: t.id, at: t.at, status: t.status }, message: 'Sent to Adal support. The answer comes here as a notification.' }
}
let ctx_local = local
export const _setLocalForTests = (fn) => { ctx_local = fn || local }

async function supportNote(db, text) {
  const now = new Date().toISOString()
  await db('notifications').insert({ company_id: 1, type: 'adal_support', title: 'Adal support', body: String(text).slice(0, 1000), created_day: now.slice(0, 10), created_at: now, updated_at: now })
}

/**
 * Read /_tower/cmds and run what is new: each answered in /_tower/acks.
 * cloud(method, path, body, opts): the PC's signed-in Supabase calls.
 */
export async function pollCommands(db, { cloud, me }) {
  const rows = await cloud('GET', `/rest/v1/keep_meta?agency_id=eq.${me}&key=eq.${encodeURIComponent('/_tower/cmds')}&select=data`)
  const list = rows?.[0]?.data?.cmds || []
  const s = st()
  const done = new Set(s.done)
  let changed = false
  for (const env of list) {
    const c = checkCommand(env, { me, done })
    if (!c.ok) {
      // Refusals answered once (a forged or stale row is not answered every 20 s).
      const id = c.cmd?.id || `sig:${String(env?.sig || '').slice(0, 16)}`
      if (c.why === 'already done' || done.has(id)) continue
      s.done.unshift(id); done.add(id)
      s.acks.unshift({ id, kind: c.cmd?.kind || null, status: 'refused', result: { message: c.why }, at: new Date().toISOString() })
      console.warn(`[tower] command refused: ${c.why}`)
      changed = true
      continue
    }
    const { cmd } = c
    s.done.unshift(cmd.id); done.add(cmd.id)
    s.done = s.done.slice(0, 200)
    saveState()
    console.log(`[tower] Adal support: ${cmd.kind} (${cmd.id})`)
    const ack = { id: cmd.id, kind: cmd.kind, status: 'running', at: new Date().toISOString() }
    s.acks.unshift(ack); s.acks = s.acks.slice(0, 20)
    await pushAcks(cloud, me).catch(() => {})
    const ctx = { me, cloud, after: null }
    try {
      ack.result = await handlers[cmd.kind](db, cmd.args || {}, ctx)
      ack.status = 'done'
    } catch (e) {
      ack.status = 'failed'
      ack.result = { message: hide(e.message).slice(0, 300) }
    }
    ack.done_at = new Date().toISOString()
    saveState()
    await pushAcks(cloud, me).catch(() => {})
    changed = false   // (the acks just went, refusals with them)
    if (ctx.after) { ctx.after(); return }
  }
  if (changed) { s.done = s.done.slice(0, 200); saveState(); await pushAcks(cloud, me).catch(() => {}) }
}
const upsertMeta = (cloud, me, key, data) => cloud('POST', '/rest/v1/keep_meta?on_conflict=agency_id,key',
  [{ agency_id: me, key, data, updated_at: new Date().toISOString() }], { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })
const pushAcks = (cloud, me) => upsertMeta(cloud, me, '/_tower/acks', { at: new Date().toISOString(), acks: st().acks })

// -------------------------------------------------------------------- flag --
/** On for this PC? ADAL_TOWER, else the Adal Test agency, else a signed /_tower/flag for this account. */
export async function towerOn({ cloud, me, agencyName }) {
  const env = String(process.env.ADAL_TOWER || '').trim()
  if (env === '0') return { on: false, why: 'ADAL_TOWER=0' }
  if (env === '1') return { on: true, why: 'ADAL_TOWER=1' }
  if (TEST_AGENCY.test(agencyName || '')) return { on: true, why: 'Adal Test agency' }
  const rows = await cloud('GET', `/rest/v1/keep_meta?agency_id=eq.${me}&key=eq.${encodeURIComponent('/_tower/flag')}&select=data`).catch(() => null)
  const f = openSigned(rows?.[0]?.data)
  if (f && f.target === me && f.on === true) return { on: true, why: 'opened by Adal' }
  return { on: false, why: 'not open for this agency yet' }
}

// ------------------------------------------------------------------- start --
let started = false
export function startTower(db, { installedVersion } = {}) {
  if (started || process.env.NODE_ENV === 'test') return
  started = true
  if (installedVersion) versionOf = installedVersion
  hookCrashes()
  let flagAt = 0, beatAt = 0
  const loop = async () => {
    let wait = POLL_MS
    // A robot run has the internet (runFocus.js): Adal's tower is asked every 5 minutes only, until the run ends.
    try { const RF = await import('./runFocus.js'); if (RF.held('the tower') && Date.now() - beatAt < 5 * 60e3) { RF.later('the tower', () => {}); setTimeout(loop, 30_000).unref?.(); return } } catch {}
    try {
      const C = await import('./chatCloud.js')
      if (!C.chatConfigured()) { status.on = false; status.why = 'no Supabase on this PC'; wait = FLAG_MS }
      else {
        const me = await C.cloudAgencyId(db)
        const cloud = (m, p, b, o) => C.cloudCall(db, m, p, b, o)
        if (Date.now() - flagAt >= FLAG_MS - 5000) {
          const agencyName = await C.me(db).then(a => a?.name).catch(() => null)
          Object.assign(status, await towerOn({ cloud, me, agencyName }), { agencyName })
          flagAt = Date.now()
        }
        live = status.on ? { cloud, me } : null
        if (!status.on) wait = FLAG_MS
        else {
          if (Date.now() - beatAt >= BEAT_MS - 2000) {
            await upsertMeta(cloud, me, '/_tower/beat', await beatData(db, { agencyName: status.agencyName }))
            beatAt = Date.now(); status.lastBeat = new Date().toISOString()
          }
          await pollCommands(db, { cloud, me })
          status.error = null
        }
      }
    } catch (e) { status.error = e.message; wait = 60_000 }
    setTimeout(loop, wait).unref?.()
  }
  setTimeout(loop, 30_000).unref?.()
}
