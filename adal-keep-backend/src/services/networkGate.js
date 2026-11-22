/**
 * networkGate.js — who may use this PC's Adal Keep from the network.
 *
 * Before: every /api call and every stored document answered anyone who could
 * reach port 4000 (the office Wi-Fi, Tailscale): profiles, passports, the
 * portals' passwords, the Musaned code. Now:
 *
 *   • This PC itself (127.0.0.1) — as before. The phones and Adal Admin come
 *     through Supabase: the PC makes their calls itself, so they count as here.
 *   • Another computer (a branch PC, a laptop at home) — only once someone at
 *     this PC said "Yes" to it: it asks ("Computer X wants to open Adal Keep"),
 *     the main PC shows Yes / No, and the computer keeps a key (a cookie for a
 *     browser, a header for a follower PC's own server). Settings lists them;
 *     a removed one asks again.
 *   • A few calls stay open, as they must: health, the setup and licence
 *     state, the phone app's pairing (number-checked, slowed down), the
 *     Companion's scans, and asking to join.
 *
 * Also: requests from another website (a page open in the browser calling
 * http://localhost:4000) are refused — only Adal Keep's own pages may call
 * it (Origin), and a name that is not this PC's (DNS rebinding) is refused.
 *
 * Keys are stored hashed (data/pc-access.json); the key itself never is.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { syncNode } from './sync/index.js'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const FILE = process.env.ADAL_PC_ACCESS_FILE || path.join(DATA, 'pc-access.json')
const COOKIE = 'adal_pc'
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')

// The list of computers let in. Asked on 2026-11-19 ("it is logging out
// fast"): a list that could not be read (cut short by a power cut or by a
// read in the middle of a write) used to count as empty, so every Companion
// was out and had to type the number again — and the next write made that
// for good. Now it is written whole or not at all (a new file, then renamed),
// the one before is kept (.bak), and one that cannot be read falls back to
// that copy or to the last good one in memory — never to an empty list.
let lastGood = null
function parse(f) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? { pcs: [], pending: [], ...j } : null }
function read() {
  try { const s = parse(FILE); if (s) { lastGood = JSON.stringify(s); return s } } catch {}
  if (lastGood) return JSON.parse(lastGood)
  try { const s = parse(FILE + '.bak'); if (s) return s } catch {}
  return { pcs: [], pending: [] }
}
const whole = (f, text) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f) }
function write(s) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const text = JSON.stringify(s, null, 1)
  whole(FILE, text)
  try { whole(FILE + '.bak', text) } catch {}
  lastGood = text
}
/** One of this computer's keys: the first one, or one it got later (another address of the main PC, a cleared window). */
const hasKey = (p, h) => p.key === h || (Array.isArray(p.keys) && p.keys.includes(h))

// A Companion standing in for the main PC (services/standby: ADAL_BEHIND_COMPANION=1):
// the office reaches this server through adal-companion.exe (port 4000, allowed in
// the firewall), which connects from a loopback address of its own per computer
// (127.168.1.20 for 192.168.1.20) — never 127.0.0.1, so every check here sees
// "another computer" — and says who it is (x-adal-real-ip, always its own value).
const BEHIND = process.env.ADAL_BEHIND_COMPANION === '1'
export const ipOf = (req) => {
  const sock = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  if (BEHIND && /^127\./.test(sock) && sock !== '127.0.0.1') {
    const real = String(req.headers['x-adal-real-ip'] || '')
    if (/^[\d.]+$|^[0-9a-f:]+$/i.test(real)) return real
  }
  return sock
}

/** The returning main PC reads a standing-in Companion's work with its token (services/standby). */
export function mergeTokenOk(req) {
  const t = process.env.ADAL_MERGE_TOKEN || ''
  const got = String(req.headers['x-adal-merge'] || '')
  if (t.length < 24 || got.length !== t.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(t))
}
export const isLocal = (req) => ['127.0.0.1', '::1'].includes(ipOf(req))
/**
 * A computer on the agency's own network: the office Wi-Fi or cable, this
 * PC's hotspot (192.168.137.x), or the agency's Tailscale (100.64–127.x).
 * Since 2026-11-19 being on that network is not enough to get in: every
 * Companion types the main PC's number once (POST /pc-access/number) and
 * keeps the key it gets, so the main PC knows each one and can suspend it.
 * Nobody at the main PC approves anything.
 */
export function isOwnNetwork(req) {
  const ip = ipOf(req)
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true
  const m = ip.match(/^(\d+)\.(\d+)\./)
  if (m && m[1] === '172' && Number(m[2]) >= 16 && Number(m[2]) <= 31) return true
  if (m && m[1] === '100' && Number(m[2]) >= 64 && Number(m[2]) <= 127) return true
  return /^(fe80|fc|fd)/i.test(ip)
}

function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='))
  return m ? decodeURIComponent(m.slice(name.length + 1)) : ''
}
export const keyOf = (req) => String(req.headers['x-adal-pc'] || cookieOf(req, COOKIE) || '')

/** The approved computer this request comes from, or null. */
export function approvedPC(req) {
  const k = keyOf(req)
  if (!k) return null
  const h = hash(k)
  const s = read()
  const pc = s.pcs.find(p => hasKey(p, h) && !p.revoked)
  if (pc?.suspended) return null
  if (pc && Date.now() - (pc.last_seen || 0) > 10 * 60000) { pc.last_seen = Date.now(); pc.last_ip = ipOf(req); write(s) }
  if (pc) return pc
  // Another PC of the agency (each has its own full copy): its key is on the
  // agency's list every PC holds (sync_pcs), put there by the main PC when it
  // came in with the number — so the PCs reach each other with the main PC off.
  const peer = syncNode()?.peerByKey(k)
  return peer ? { id: `sync:${peer.pc_id}`, name: peer.name, sync: true, pc_id: peer.pc_id } : null
}

// Calls another computer may make before it is approved.
const OPEN = [
  ['GET', /^\/api\/health$/],
  ['GET', /^\/api\/setup\/status$/],
  ['GET', /^\/api\/subscription\/status$/],
  ['POST', /^\/api\/subscription\/unlock$/],
  ['GET', /^\/api\/mobile\/(ping|app|app\.apk)$/],
  ['POST', /^\/api\/mobile\/pair$/],
  ['GET', /^\/api\/companion\/info$/],
  ['POST', /^\/api\/companion\/ingest$/],
  ['POST', /^\/api\/messaging\/ai\/event$/],
  ['POST', /^\/api\/pc-access\/request$/],
  ['POST', /^\/api\/pc-access\/signin$/],
  ['POST', /^\/api\/pc-access\/number$/],
  ['POST', /^\/api\/pc-access\/check-number$/],
  ['GET', /^\/api\/pc-access\/status$/],
  // Adal's signed release, which every PC of the office hands on (services/lanRelease.js).
  ['GET', /^\/api\/system\/update\/lan\/(latest|file\/[0-9a-f]{64})$/],
  ['POST', /^\/api\/system\/update\/lan\/offer$/],
]

/** Only Adal Keep's own pages may call it: the same address, or its own app windows. */
const OWN_ORIGINS = new Set(['http://localhost', 'capacitor://localhost', 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:4000', 'http://127.0.0.1:4000', 'http://localhost:4101', 'http://127.0.0.1:4101'])
export function originOk(req) {
  const o = req.headers.origin
  if (!o || o === 'null' && isLocal(req)) return true
  if (OWN_ORIGINS.has(o)) return true
  try { return new URL(o).host === req.headers.host } catch { return false }
}

/** This PC's own names: an IP, localhost, its computer name, Tailscale (*.ts.net) or *.local. */
function hostOk(req) {
  const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return true
  if (!h.includes('.')) return true                     // a computer's name on the office network
  if (/\.(ts\.net|local|lan|home|localhost)$/.test(h)) return true
  return h === os.hostname().toLowerCase()
}

export function networkGate(req, res, next) {
  const p = req.path
  if (!p.startsWith('/api') && !p.startsWith('/uploads')) return next()
  if (!hostOk(req)) return res.status(403).json({ error: 'Not this PC\'s address' })
  if (!originOk(req)) return res.status(403).json({ error: 'Only Adal Keep\'s own pages may do this' })
  if (isLocal(req)) return next()
  if (OPEN.some(([m, re]) => (req.method === m || (m === 'GET' && req.method === 'HEAD')) && re.test(p))) return next()
  if (req.method === 'GET' && /^\/api\/branch\/export(\/|$)/.test(p) && mergeTokenOk(req)) return next()
  const pc = approvedPC(req)
  if (pc) { req.pcAccess = pc; return next() }
  // Suspended on the main PC (Settings → Connected devices): cut off at once.
  if (isSuspended(req)) return res.status(403).json({ error: 'This computer was suspended by the main PC', suspended: true })
  return res.status(401).json({ error: 'This computer is not allowed to open Adal Keep yet', pc_access: true })
}

// ── Asking, answering, the list ─────────────────────────────────────────────

/** A computer asks to join: it gets its key now (used once it is approved). */
export function requestAccess(req, name) {
  const s = read()
  const key = crypto.randomBytes(32).toString('base64url')
  const id = crypto.randomBytes(6).toString('hex')
  s.pending = s.pending.filter(x => Date.now() - x.at < 24 * 3600000).slice(-20)
  s.pending.push({ id, key: hash(key), name: String(name || 'A computer').slice(0, 60), ip: ipOf(req), agent: String(req.headers['user-agent'] || '').slice(0, 120), at: Date.now() })
  write(s)
  return { id, key }
}

/**
 * Signed in with an account of this PC (the owner's or an employee's, the same
 * username and password): let in at once — nobody here has to say Yes.
 */
export function admitSignedIn(req, name, user, { cid = '', device = '' } = {}) {
  const s = read()
  const key = crypto.randomBytes(32).toString('base64url')
  // The same Companion coming back (its own id, kept by AdalKeep.exe, or its
  // online account): the same place on the list, one more key — after a new
  // address of the main PC (the router, Tailscale), a cleared window, a new
  // browser profile. So it is one computer in Settings, suspended as one.
  const same = companionOf(s, { cid, device })
  if (same) {
    if (same.suspended) return { suspended: true, id: same.id }
    same.keys = [...(Array.isArray(same.keys) ? same.keys : []), hash(key)].slice(-20)
    same.last_seen = Date.now(); same.last_ip = ipOf(req)
    if (name) same.name = String(name).slice(0, 60)
    if (cid && !same.cid) same.cid = hash('cid:' + cid)
    write(s)
    return { id: same.id, key, again: true }
  }
  const id = crypto.randomBytes(6).toString('hex')
  s.pcs.push({ id, key: hash(key), name: String(name || 'A computer').slice(0, 60), ip: ipOf(req), agent: String(req.headers['user-agent'] || '').slice(0, 120), approved_at: Date.now(), last_seen: Date.now(), by_account: String(user || '').slice(0, 60), ...(cid ? { cid: hash('cid:' + cid) } : {}) })
  write(s)
  return { id, key }
}

/** The Companion on the list (not logged out) with this own id or online account. */
function companionOf(s, { cid = '', device = '' } = {}) {
  cid = String(cid || ''); device = String(device || '')
  if (cid.length >= 16) { const h = hash('cid:' + cid); const p = s.pcs.find(x => !x.revoked && x.cid === h); if (p) return p }
  if (/^[0-9a-f-]{36}$/i.test(device)) { const p = s.pcs.find(x => !x.revoked && x.device === device); if (p) return p }
  return null
}
/** That Companion (by its own id or online account) is suspended on this PC. */
export function companionSuspended(who) { return !!companionOf(read(), who)?.suspended }

/** This request carries the key of a computer the main PC suspended. */
export function isSuspended(req) {
  const k = keyOf(req)
  if (!k) return false
  const h = hash(k)
  return read().pcs.some(p => hasKey(p, h) && !p.revoked && p.suspended) || syncNode()?.peerKeyState(k) === 'suspended'
}

export function statusOf(req) {
  const k = keyOf(req)
  if (!k) return { state: 'none' }
  const h = hash(k), s = read()
  if (s.pcs.some(p => hasKey(p, h) && !p.revoked && p.suspended)) return { state: 'suspended' }
  if (s.pcs.some(p => hasKey(p, h) && !p.revoked)) return { state: 'approved' }
  if (s.pcs.some(p => hasKey(p, h) && p.revoked)) return { state: 'removed' }
  const q = s.pending.find(x => x.key === h)
  return q ? { state: q.denied ? 'denied' : 'waiting' } : { state: 'none' }
}

export const pending = () => read().pending.filter(x => !x.denied && Date.now() - x.at < 24 * 3600000).map(({ key, ...x }) => x)

export function answer(id, yes) {
  const s = read()
  const q = s.pending.find(x => x.id === id)
  if (!q) throw new Error('No such request (it may be older than a day)')
  if (yes) {
    s.pcs.push({ id: q.id, key: q.key, name: q.name, ip: q.ip, agent: q.agent, approved_at: Date.now(), last_seen: Date.now() })
    s.pending = s.pending.filter(x => x.id !== id)
  } else q.denied = true
  write(s)
}

export const list = () => read().pcs.filter(p => !p.revoked).map(({ key, keys, cid, ...p }) => p)

/** Suspend a computer (it keeps its place on the list) or allow it again. Its online account id, if any. */
export function setSuspended(id, on) {
  const s = read()
  const pc = s.pcs.find(p => p.id === id && !p.revoked)
  if (!pc) throw new Error('No such computer')
  if (on) pc.suspended = Date.now(); else delete pc.suspended
  write(s)
  // Written down every time (2026-11-22: "the main PC suspended the Companion" had no trace): only a person's
  // click on this PC (POST /pc-access/devices/suspend, this PC only) calls this — nothing suspends a PC by itself.
  console.log(`[pc-access] ${on ? 'SUSPENDED' : 'allowed again'}: ${pc.name || id} (${pc.last_ip || '?'}) — by a person on the main PC`)
  return pc.device || null
}

/** The online account (keep_devices user id) this computer's Companion uses. */
export function linkDevice(id, device) {
  const s = read()
  const pc = s.pcs.find(p => p.id === id && !p.revoked)
  if (!pc || !device) return
  pc.device = String(device)
  write(s)
}

export function remove(id) {
  const s = read()
  for (const p of s.pcs) if (p.id === id) p.revoked = Date.now()
  write(s)
}

export const setKeyCookie = (res, key) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${5 * 365 * 86400}`)
