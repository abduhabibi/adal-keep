/**
 * Adal Keep — admin panel (only for Adal, on Adal's own PC).
 *
 *   node server.mjs          then open http://localhost:4100
 *                            (one agency's own Adal Keep opens on :4101)
 *
 * Needs adal-admin/.env (never shared, never committed):
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=...        (Supabase → Project Settings → API → service_role)
 *   ADAL_LICENSE_KEY=...            (the same as in adal-keep-backend/.env: shows unlock codes)
 *
 * The service key can read and change everything, so this panel only listens
 * on this PC (127.0.0.1) and asks for a password (chosen the first time it
 * opens; kept as ADMIN_PASSWORD_HASH).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.ADMIN_PORT || 4100)

// --------------------------------------------------------------- settings --
for (const line of (fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const URL_ = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SUPABASE_SERVICE_KEY || ''
if (!URL_ || !KEY) {
  console.error('adal-admin/.env needs SUPABASE_URL and SUPABASE_SERVICE_KEY (see the top of server.mjs).')
  process.exit(1)
}

// ----------------------------------------------------------- unlock codes --
// The same Google Authenticator codes the customers' PCs accept
// (adal-keep-backend/src/services/subscription.js).
function pcSecret(pc) {
  return crypto.createHmac('sha256', process.env.ADAL_LICENSE_KEY || '').update('adal-keep-totp:' + pc).digest().subarray(0, 20)
}
function totp(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step))
  const h = crypto.createHmac('sha1', secret).update(msg).digest()
  const o = h[19] & 15
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0')
}
// The PC number's last digit is a Luhn check digit (subscription.js): a
// mistyped number is caught before it is saved.
function luhnOk(pc) {
  const digits = pc.slice(0, 5)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return String((10 - (sum % 10)) % 10) === pc[5]
}
const codeFor = (pc) => process.env.ADAL_LICENSE_KEY && /^\d{6}$/.test(pc || '') ? totp(pcSecret(pc), Math.floor(Date.now() / 30000)) : null

// -------------------------------------------------------------- supabase --
async function sb(method, p, body, headers = {}) {
  const res = await fetch(`${URL_}${p}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null; try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) throw new Error(data?.message || data?.msg || data?.error || String(text).slice(0, 200) || res.status)
  return data
}
const rest = (method, p, body, headers) => sb(method, `/rest/v1/${p}`, body, headers)

// Adal's own chat identity ("Adal Keep"), made once; it is in every agency's inbox.
let ADMIN_ID = null
async function ensureAdmin() {
  const found = await rest('GET', 'agencies?is_admin=eq.true&select=id&limit=1')
  if (found?.[0]) ADMIN_ID = found[0].id
  else {
    const user = await sb('POST', '/auth/v1/admin/users', {
      email: `admin-${crypto.randomBytes(4).toString('hex')}@adalkeep.app`,
      password: crypto.randomBytes(24).toString('base64url'), email_confirm: true,
    })
    ADMIN_ID = user.id || user.user?.id
    await rest('POST', 'agencies', { id: ADMIN_ID, name: 'Adal Keep', is_admin: true }, { Prefer: 'return=minimal' })
  }
  // Inboxes made before Adal's identity existed get Adal as a member too.
  const inboxes = await rest('GET', 'conversations?kind=eq.admin&select=id')
  if (inboxes?.length) {
    await rest('POST', 'members?on_conflict=conversation_id,agency_id', inboxes.map(c => ({ conversation_id: c.id, agency_id: ADMIN_ID })),
      { Prefer: 'resolution=ignore-duplicates,return=minimal' })
  }
}

// ------------------------------------------------------------------- api --
const api = {
  'GET /api/overview': async () => {
    const [agencies, convs, requests] = await Promise.all([
      rest('GET', 'agencies?select=id,name,pc_number,banned,is_admin,created_at,last_seen&order=last_seen.desc'),
      rest('GET', 'conversations?select=id,kind,key,last_message_at&order=last_message_at.desc'),
      rest('GET', 'unlock_requests?select=id,agency_id,pc_number,image_path,status,note,created_at,decided_at&order=id.desc&limit=200'),
    ])
    const invites = await rest('GET', 'agency_invites?select=pc_number,name,paid,created_at&order=created_at.desc').catch(() => null)
    const name = Object.fromEntries(agencies.map(a => [a.id, a.name]))
    const reads = await rest('GET', `members?agency_id=eq.${ADMIN_ID}&select=conversation_id,last_read_id`)
    const lastRead = Object.fromEntries((reads || []).map(r => [r.conversation_id, r.last_read_id]))
    const lastMsgs = await rest('GET', 'messages?select=id,conversation_id,sender_id,body,image_path,created_at&order=id.desc&limit=500')
    const latest = {}, unread = {}
    for (const m of lastMsgs) {
      latest[m.conversation_id] ||= m
      if (m.sender_id !== ADMIN_ID && m.id > (lastRead[m.conversation_id] ?? 0)) unread[m.conversation_id] = (unread[m.conversation_id] || 0) + 1
    }
    const members = await rest('GET', `members?select=conversation_id,agency_id&conversation_id=in.(${convs.filter(c => c.kind === 'direct').map(c => c.id).join(',') || '00000000-0000-0000-0000-000000000000'})`)
    const title = (c) => c.kind === 'group' ? 'Everyone'
      : c.kind === 'admin' ? name[c.key.slice(6)] || 'agency'
      : members.filter(m => m.conversation_id === c.id).map(m => name[m.agency_id]).join(' ↔ ')
    return {
      adminId: ADMIN_ID,
      agencies: agencies.map(a => ({ ...a, code: a.is_admin ? null : codeFor(a.pc_number) })),
      conversations: convs.map(c => ({ ...c, title: title(c), last: latest[c.id] || null, unread: unread[c.id] || (c.kind === 'admin' && lastRead[c.id] === undefined ? 0 : 0) })),
      requests: requests.map(r => ({ ...r, agency: name[r.agency_id] || '?', code: codeFor(r.pc_number) })),
      // null = the agency_invites table is not in Supabase yet (run schema.sql again)
      invites: invites && invites.map(i => ({ ...i, joined: agencies.find(a => a.pc_number === i.pc_number)?.name || null, code: codeFor(i.pc_number) })),
    }
  },
  'GET /api/messages': async (q) => {
    const rows = await rest('GET', `messages?conversation_id=eq.${encodeURIComponent(q.conversation)}&select=id,sender_id,body,image_path,created_at&order=id.desc&limit=300`)
    const list = (rows || []).reverse()
    if (list.length) {
      await rest('POST', 'members?on_conflict=conversation_id,agency_id', { conversation_id: q.conversation, agency_id: ADMIN_ID, last_read_id: list[list.length - 1].id },
        { Prefer: 'resolution=merge-duplicates,return=minimal' }).catch(() => {})
    }
    return list
  },
  'POST /api/send': async (q, b) => {
    let image_path = null
    if (b.image) {
      const [, mime, data] = String(b.image).match(/^data:([^;]+);base64,(.*)$/) || []
      if (!mime) throw new Error('bad picture')
      image_path = `${ADMIN_ID}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${mime.split('/')[1] || 'jpg'}`
      await sb('POST', `/storage/v1/object/chat/${image_path}`, Buffer.from(data, 'base64'), { 'Content-Type': mime })
    }
    await rest('POST', 'messages', { conversation_id: b.conversation, sender_id: ADMIN_ID, body: (b.body || '').trim() || null, image_path }, { Prefer: 'return=minimal' })
    return { ok: true }
  },
  'POST /api/delete-message': async (q, b) => { await rest('DELETE', `messages?id=eq.${Number(b.id)}`); return { ok: true } },
  'POST /api/ban': async (q, b) => {
    await rest('PATCH', `agencies?id=eq.${encodeURIComponent(b.id)}`, { banned: !!b.banned }, { Prefer: 'return=minimal' })
    return { ok: true }
  },
  // Add an agency by its PC number (it may not have installed yet).
  'POST /api/invite': async (q, b) => {
    const pc = String(b.pc || '').replace(/\D/g, '')
    if (!/^\d{6}$/.test(pc) || !luhnOk(pc)) throw new Error('That PC number is not right (6 digits; the last one is a check digit — check it again).')
    const nm = String(b.name || '').trim()
    if (!nm) throw new Error('Give the agency a name.')
    await rest('POST', 'agency_invites?on_conflict=pc_number', { pc_number: pc, name: nm, paid: !!b.paid },
      { Prefer: 'resolution=merge-duplicates,return=minimal' })
    // Already installed: it shows under that name right away.
    await rest('PATCH', `agencies?pc_number=eq.${pc}&is_admin=eq.false`, { name: nm }, { Prefer: 'return=minimal' })
    return { ok: true }
  },
  'POST /api/invite-paid': async (q, b) => {
    await rest('PATCH', `agency_invites?pc_number=eq.${encodeURIComponent(b.pc)}`, { paid: !!b.paid }, { Prefer: 'return=minimal' })
    return { ok: true }
  },
  'POST /api/invite-delete': async (q, b) => {
    await rest('DELETE', `agency_invites?pc_number=eq.${encodeURIComponent(b.pc)}`)
    return { ok: true }
  },
  // Delete an agency: its account, chats, receipts and pictures. If that PC
  // opens the chat again it comes back as a new, empty agency (ban to keep it out).
  'POST /api/delete-agency': async (q, b) => {
    const id = String(b.id || '')
    if (!/^[0-9a-f-]{36}$/i.test(id) || id === ADMIN_ID) throw new Error('bad agency')
    const listed = await sb('POST', '/storage/v1/object/list/chat', { prefix: id, limit: 1000 }).catch(() => [])
    const files = (listed || []).map(f => `${id}/${f.name}`)
    if (files.length) await sb('DELETE', '/storage/v1/object/chat', { prefixes: files }).catch(() => {})
    await rest('DELETE', `conversations?key=eq.admin:${id}`)
    await rest('DELETE', `conversations?kind=eq.direct&key=like.*${id}*`)
    await sb('DELETE', `/auth/v1/admin/users/${id}`) // the agency row, its messages and receipts go with it
    return { ok: true, pictures: files.length }
  },
  // Agencies' work: how each agency's work stands (their PCs send a summary
  // with the online copy, adal-keep-backend services/cloudSync.js).
  'GET /api/work': async () => {
    const [agencies, meta, phones] = await Promise.all([
      rest('GET', 'agencies?is_admin=eq.false&select=id,name,pc_number,banned,last_seen&order=name.asc'),
      rest('GET', 'keep_meta?key=in.(/_summary,/_pc)&select=agency_id,key,data,updated_at').catch(() => []),
      rest('GET', 'keep_devices?select=agency_id,revoked').catch(() => []),
    ])
    const of = (id, key) => meta.find(m => m.agency_id === id && m.key === key)
    return agencies.map(a => {
      const pc = of(a.id, '/_pc')?.data?.at || null
      return {
        ...a,
        pcOnline: !!pc && Date.now() - new Date(pc).getTime() < 60000,
        pcSeen: pc,
        summary: of(a.id, '/_summary')?.data || null,
        phones: phones.filter(d => d.agency_id === a.id && !d.revoked).length,
      }
    })
  },
  // Do something in an agency's Adal Keep now (its PC must be on): the relay.
  'POST /api/agency-call': async (q, b) => agencyCall(String(b.agency || ''), String(b.method || 'POST'), String(b.path || ''), b.body ?? null),
  'POST /api/decide': async (q, b) => {
    const status = b.approve ? 'approved' : 'rejected'
    const [r] = await rest('PATCH', `unlock_requests?id=eq.${Number(b.id)}`, { status, note: b.note || null, decided_at: new Date().toISOString() }, { Prefer: 'return=representation' })
    if (r) {
      const [inbox] = await rest('GET', `conversations?key=eq.admin:${r.agency_id}&select=id`)
      if (inbox) await rest('POST', 'messages', {
        conversation_id: inbox.id, sender_id: ADMIN_ID,
        body: b.approve ? 'Payment received — thank you! Your Adal Keep is unlocked.' : `Payment not accepted${b.note ? `: ${b.note}` : '.'} Please send a clear picture of the receipt again.`,
      }, { Prefer: 'return=minimal' })
    }
    return { ok: true }
  },
}

const isAgency = (id) => /^[0-9a-f-]{36}$/i.test(id || '') && id !== ADMIN_ID
async function agencyCall(agency, method, p, body, ms = 25000) {
  if (!isAgency(agency) || !p.startsWith('/')) throw new Error('bad call')
  const [row] = await rest('POST', 'keep_calls?select=id', { agency_id: agency, device_id: ADMIN_ID, method: method.toUpperCase(), path: p, body }, { Prefer: 'return=representation' })
  for (const end = Date.now() + ms; Date.now() < end;) {
    await new Promise(r => setTimeout(r, 500))
    const [a] = await rest('GET', `keep_calls?id=eq.${row.id}&select=status,answer,answer_code`)
    if (a?.status === 'done') { if (a.answer_code >= 400) throw new Error(a.answer?.error || `Error ${a.answer_code}`); return a.answer }
    if (a?.status === 'late') break
  }
  throw new Error("The agency's PC did not answer — it is off or has no internet.")
}

// ------------------------------------------------------- agency windows --
// :4101 serves the Adal Keep pages (adal-keep-frontend `npm run build:admin`
// → keep-app/) for one agency per window. Its "Supabase" is /sb here: only
// that agency's rows (the window names it as its apikey), with the service key.
const KEEP_APP = path.join(HERE, 'keep-app')
const AGENCY_PORT = PORT + 1
const SB_TABLES = /^(keep_meta|keep_files|keep_calls|keep_changes)$/
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
let knownAgencies = { at: 0, ids: new Set() }
async function agencyExists(id) {
  if (Date.now() - knownAgencies.at > 60000) knownAgencies = { at: Date.now(), ids: new Set((await rest('GET', 'agencies?select=id')).map(a => a.id)) }
  return knownAgencies.ids.has(id)
}
async function rawBody(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c) }

async function sbProxy(req, res, u) {
  const send = (code, data, type = 'application/json') => res.writeHead(code, { 'Content-Type': type }).end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data))
  const p = u.pathname.slice(3)                     // /sb/rest/v1/… → /rest/v1/…
  if (p.startsWith('/auth/v1/token')) return send(200, { access_token: 'admin', refresh_token: 'admin', expires_in: 3600 })
  // Signed document links carry their own token.
  if (req.method === 'GET' && p.startsWith('/storage/v1/object/sign/keep/')) {
    const r = await fetch(`${URL_}${p}${u.search}`)
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' })
    return res.end(Buffer.from(await r.arrayBuffer()))
  }
  const agency = String(req.headers.apikey || '')
  if (!isAgency(agency) || !(await agencyExists(agency))) return send(403, { message: 'unknown agency' })
  const fwd = async (method, target, body, headers = {}) => {
    const r = await fetch(`${URL_}${target}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...headers }, body })
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' })
    res.end(Buffer.from(await r.arrayBuffer()))
  }
  const table = p.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1]
  if (table && SB_TABLES.test(table)) {
    if (req.method === 'GET') return fwd('GET', `${p}${u.search ? u.search + '&' : '?'}agency_id=eq.${agency}`)
    if (req.method === 'POST' && /^keep_(calls|changes)$/.test(table)) {
      let b = JSON.parse((await rawBody(req)).toString() || '{}')
      const fix = (r) => ({ ...r, agency_id: agency, device_id: ADMIN_ID })
      b = Array.isArray(b) ? b.map(fix) : fix(b)
      return fwd('POST', `${p}${u.search}`, JSON.stringify(b), { 'Content-Type': 'application/json', ...(req.headers.prefer ? { Prefer: req.headers.prefer } : {}) })
    }
    return send(405, { message: 'not allowed' })
  }
  const obj = p.match(/^\/storage\/v1\/object\/(sign\/)?keep\/(.+)$/)
  if (obj && req.method === 'POST' && decodeURIComponent(obj[2]).startsWith(`${agency}/`)) {
    const body = await rawBody(req)
    return fwd('POST', p, body, { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' })
  }
  return send(403, { message: 'not allowed' })
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost')
  try {
    if (!signedIn(req)) {
      if (u.pathname.startsWith('/sb/')) { res.writeHead(401).end(); return }
      res.writeHead(303, { Location: `http://localhost:${PORT}/` }).end(); return
    }
    if (u.pathname.startsWith('/sb/')) return await sbProxy(req, res, u)
    if (!fs.existsSync(path.join(KEEP_APP, 'index.html'))) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('The agency pages are not built yet: in adal-keep-frontend run  npm run build:admin'); return
    }
    let f = path.normalize(path.join(KEEP_APP, decodeURIComponent(u.pathname)))
    if (!f.startsWith(KEEP_APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(KEEP_APP, 'index.html')
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000' })
    fs.createReadStream(f).pipe(res)
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
}).listen(AGENCY_PORT, '127.0.0.1')

async function image(res, p) {
  if (!/^[0-9a-f-]{36}\/[\w.-]+$/i.test(p || '')) { res.writeHead(400).end(); return }
  const r = await fetch(`${URL_}/storage/v1/object/authenticated/chat/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  res.writeHead(r.ok ? 200 : 404, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
  res.end(Buffer.from(await r.arrayBuffer()))
}

// ---------------------------------------------------------------- server --
// Sign-in: a password Adal chooses the first time the panel opens (kept in
// .env as a salted hash), then a cookie for 12 hours.
const ENV_FILE = path.join(HERE, '.env')
const hashOf = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex')
let passHash = process.env.ADMIN_PASSWORD_HASH || ''   // "salt:hash"
const sessions = new Map()                             // token → expires

function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  passHash = `${salt}:${hashOf(pw, salt)}`
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter(l => !/^ADMIN_PASSWORD(_HASH)?=/.test(l) && l.trim())
  fs.writeFileSync(ENV_FILE, [...lines, `ADMIN_PASSWORD_HASH=${passHash}`].join('\n') + '\n', { mode: 0o600 })
}
function passwordRight(pw) {
  const [salt, h] = passHash.split(':')
  if (!salt || !h) return false
  const a = Buffer.from(hashOf(String(pw || '').trim(), salt), 'hex'), b = Buffer.from(h, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
function signedIn(req) {
  const t = String(req.headers.cookie || '').match(/adal_admin=([a-f0-9]{64})/)?.[1]
  return !!t && (sessions.get(t) || 0) > Date.now()
}
function startSession(res) {
  const t = crypto.randomBytes(32).toString('hex')
  sessions.set(t, Date.now() + 12 * 3600 * 1000)
  res.setHeader('Set-Cookie', `adal_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`)
}
async function formBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c)
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
}
function loginPage(res, { first = false, error = '' } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Adal Keep Admin</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px system-ui,sans-serif;background:#0d1419;color:#e5edf2}
form{background:#141e25;border:1px solid #24323c;border-radius:16px;padding:28px;width:min(360px,90vw)}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 18px;color:#8aa0ae;font-size:13px}
label{display:block;font-size:12px;color:#8aa0ae;margin:12px 0 4px}
input.pw{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #24323c;background:#0d1419;color:#fff;font-size:15px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#fca5a5;font-size:13px;margin-top:10px}.show{display:flex;gap:6px;align-items:center;margin-top:10px}</style></head><body>
<form method="post" action="${first ? '/set-password' : '/login'}">
<h1>Adal Keep Admin</h1>
<p>${first ? 'Choose the password for your admin panel (at least 6 characters). You will type it each time you open the panel.' : 'Type your admin password.'}</p>
<label>Password</label><input class="pw" type="password" name="password" autofocus required minlength="${first ? 6 : 1}" autocomplete="${first ? 'new-password' : 'current-password'}">
${first ? '<label>Type it again</label><input class="pw" type="password" name="again" required autocomplete="new-password">' : ''}
<label class="show"><input type="checkbox" onclick="document.querySelectorAll('input.pw').forEach(i=>i.type=this.checked?'text':'password')"> Show the password</label>
<button>${first ? 'Save and open the panel' : 'Open the panel'}</button>
${error ? `<div class="err">${error}</div>` : ''}
</form></body></html>`)
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'POST' && u.pathname === '/set-password') {
      if (passHash) return loginPage(res, { error: 'A password is already set.' })
      const b = await formBody(req)
      const pw = String(b.password || '').trim()
      if (pw.length < 6) return loginPage(res, { first: true, error: 'Use at least 6 characters.' })
      if (pw !== String(b.again || '').trim()) return loginPage(res, { first: true, error: 'The two passwords are not the same.' })
      setPassword(pw); startSession(res)
      res.writeHead(303, { Location: '/' }).end(); return
    }
    if (req.method === 'POST' && u.pathname === '/login') {
      const b = await formBody(req)
      if (!passwordRight(b.password)) return loginPage(res, { error: 'That password is not right. (Check Caps Lock.)' })
      startSession(res)
      res.writeHead(303, { Location: '/' }).end(); return
    }
    if (u.pathname === '/logout') {
      res.writeHead(303, { 'Set-Cookie': 'adal_admin=; Path=/; Max-Age=0', Location: '/' }).end(); return
    }
    if (!signedIn(req)) {
      if (u.pathname.startsWith('/api/')) { res.writeHead(401).end(); return }
      return loginPage(res, { first: !passHash })
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(HERE, 'public', 'index.html')))
      return
    }
    if (u.pathname === '/api/image') return await image(res, u.searchParams.get('path'))
    const fn = api[`${req.method} ${u.pathname}`]
    if (!fn) { res.writeHead(404).end(); return }
    let body = {}
    if (req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c)
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    }
    const out = await fn(Object.fromEntries(u.searchParams), body)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out))
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }))
  }
}).listen(PORT, '127.0.0.1', async () => {
  try { await ensureAdmin() } catch (e) { console.error('Could not reach Supabase:', e.message) }
  console.log(`Adal Keep admin panel: http://localhost:${PORT}`)
})
