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

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const FILE = path.join(DATA, 'pc-access.json')
const COOKIE = 'adal_pc'
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')

function read() { try { return { pcs: [], pending: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } } catch { return { pcs: [], pending: [] } } }
function write(s) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 1)) }

export const ipOf = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
export const isLocal = (req) => ['127.0.0.1', '::1'].includes(ipOf(req))

function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='))
  return m ? decodeURIComponent(m.slice(name.length + 1)) : ''
}
const keyOf = (req) => String(req.headers['x-adal-pc'] || cookieOf(req, COOKIE) || '')

/** The approved computer this request comes from, or null. */
export function approvedPC(req) {
  const k = keyOf(req)
  if (!k) return null
  const h = hash(k)
  const s = read()
  const pc = s.pcs.find(p => p.key === h && !p.revoked)
  if (pc && Date.now() - (pc.last_seen || 0) > 10 * 60000) { pc.last_seen = Date.now(); pc.last_ip = ipOf(req); write(s) }
  return pc || null
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
  ['GET', /^\/api\/pc-access\/status$/],
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
  const pc = approvedPC(req)
  if (pc) { req.pcAccess = pc; return next() }
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
export function admitSignedIn(req, name, user) {
  const s = read()
  const key = crypto.randomBytes(32).toString('base64url')
  const id = crypto.randomBytes(6).toString('hex')
  s.pcs.push({ id, key: hash(key), name: String(name || 'A computer').slice(0, 60), ip: ipOf(req), agent: String(req.headers['user-agent'] || '').slice(0, 120), approved_at: Date.now(), last_seen: Date.now(), by_account: String(user || '').slice(0, 60) })
  write(s)
  return { id, key }
}

export function statusOf(req) {
  const k = keyOf(req)
  if (!k) return { state: 'none' }
  const h = hash(k), s = read()
  if (s.pcs.some(p => p.key === h && !p.revoked)) return { state: 'approved' }
  if (s.pcs.some(p => p.key === h && p.revoked)) return { state: 'removed' }
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

export const list = () => read().pcs.filter(p => !p.revoked).map(({ key, ...p }) => p)

export function remove(id) {
  const s = read()
  for (const p of s.pcs) if (p.id === id) p.revoked = Date.now()
  write(s)
}

export const setKeyCookie = (res, key) =>
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${5 * 365 * 86400}`)
