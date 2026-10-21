/**
 * Adal Keep — admin panel (only for Adal, on Adal's own PC).
 *
 *   node server.mjs          then open http://localhost:4100
 *
 * Needs adal-admin/.env (never shared, never committed):
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=...        (Supabase → Project Settings → API → service_role)
 *   ADAL_LICENSE_KEY=...            (the same as in adal-keep-backend/.env: shows unlock codes)
 *   ADMIN_PASSWORD=...              (asked by the browser before the panel opens)
 *
 * The service key can read and change everything, so this panel only listens
 * on this PC (127.0.0.1) and asks for ADMIN_PASSWORD.
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
const PASSWORD = process.env.ADMIN_PASSWORD || ''
if (!URL_ || !KEY) {
  console.error('adal-admin/.env needs SUPABASE_URL and SUPABASE_SERVICE_KEY (see the top of server.mjs).')
  process.exit(1)
}
if (!PASSWORD) console.warn('No ADMIN_PASSWORD in adal-admin/.env — anyone using this PC can open the panel.')

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

async function image(res, p) {
  if (!/^[0-9a-f-]{36}\/[\w.-]+$/i.test(p || '')) { res.writeHead(400).end(); return }
  const r = await fetch(`${URL_}/storage/v1/object/authenticated/chat/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  res.writeHead(r.ok ? 200 : 404, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
  res.end(Buffer.from(await r.arrayBuffer()))
}

// ---------------------------------------------------------------- server --
function authorized(req) {
  if (!PASSWORD) return true
  const [, b64] = String(req.headers.authorization || '').split(' ')
  const pass = Buffer.from(b64 || '', 'base64').toString().split(':').slice(1).join(':')
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Adal Keep admin"' }).end('Password needed')
    return
  }
  const u = new URL(req.url, 'http://localhost')
  try {
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
