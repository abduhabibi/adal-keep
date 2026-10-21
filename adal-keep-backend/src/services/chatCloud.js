/**
 * chatCloud.js — the chat between every Adal Keep installation, through
 * Supabase (SUPABASE_URL + SUPABASE_ANON_KEY in .env). Only this file knows
 * it is Supabase: moving the chat to another server means replacing it.
 *
 * Each installation is one agency account. It is made the first time the
 * chat is used (an e-mail/password account that only this PC knows, kept in
 * backend/.adal_chat.json) and is named after the company. What an agency may
 * read or send is enforced by the database rules (adal-admin/supabase/schema.sql).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pcNumber } from './subscription.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = path.join(__dirname, '../..', '.adal_chat.json')
const BUCKET = 'chat'

const cfg = () => ({
  url: String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
  anon: String(process.env.SUPABASE_ANON_KEY || '').trim(),
})
export const chatConfigured = () => !!(cfg().url && cfg().anon)

// Links are refused by the database too; this only gives a clear message first.
export const LINK_RE = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|[a-z0-9-]+\.(com|net|org|io|me|et|sa|ae|kw|qa|info|biz|co|app|link|xyz|ly|gl|site|online|shop)(\/|\s|$))/i

export class ChatError extends Error {
  constructor(message, status = 500) { super(message); this.status = status }
}

// ----------------------------------------------------------------- session --
let sess = null // { email, password, user_id, access_token, refresh_token, expires_at }

function readSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch { return null }
}
function saveSession(s) {
  sess = s
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 }) } catch {}
}

async function auth(pathAndQuery, body) {
  const { url, anon } = cfg()
  const res = await fetch(`${url}/auth/v1/${pathAndQuery}`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

function keep(creds, data) {
  saveSession({
    ...creds,
    user_id: data.user?.id || creds.user_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
  })
}

let joinedAs = null
async function token(db) {
  if (!chatConfigured()) throw new ChatError('The chat is not set up on this PC yet (SUPABASE_URL / SUPABASE_ANON_KEY).', 503)
  sess ||= readSession()
  if (sess?.access_token && sess.expires_at > Date.now()) return sess.access_token

  if (sess?.refresh_token) {
    const r = await auth('token?grant_type=refresh_token', { refresh_token: sess.refresh_token })
    if (r.ok && r.data.access_token) { keep(sess, r.data); return sess.access_token }
  }
  if (sess?.email && sess?.password) {
    const r = await auth('token?grant_type=password', { email: sess.email, password: sess.password })
    if (r.ok && r.data.access_token) { keep(sess, r.data); return sess.access_token }
  }

  // First time on this PC: its own account.
  const creds = {
    email: `pc${pcNumber()}-${crypto.randomBytes(4).toString('hex')}@agency.adalkeep.app`,
    password: crypto.randomBytes(24).toString('base64url'),
  }
  const up = await auth('signup', creds)
  if (!up.ok) throw new ChatError(`Could not make this PC's chat account: ${up.data.msg || up.data.error_description || up.data.message || up.status}`, 502)
  if (up.data.access_token) keep(creds, up.data)
  else {
    // "Confirm email" is on in Supabase: the account exists but cannot sign in.
    saveSession({ ...creds, user_id: up.data.id || up.data.user?.id })
    const r = await auth('token?grant_type=password', creds)
    if (!r.ok) throw new ChatError('Supabase asks to confirm the e-mail. Turn off Authentication → Providers → Email → "Confirm email" in Supabase.', 502)
    keep(creds, r.data)
  }
  joinedAs = null
  return sess.access_token
}

async function call(db, method, pathAndQuery, body, { headers = {}, raw = false } = {}) {
  const { url, anon } = cfg()
  const t = await token(db)
  const res = await fetch(`${url}${pathAndQuery}`, {
    method,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${t}`,
      ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  })
  if (raw) return res
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const msg = data?.message || data?.error || String(text).slice(0, 200)
    if (/row-level security|violates/i.test(msg)) throw new ChatError('Not allowed (links are not allowed, or this agency was blocked by Adal).', 403)
    throw new ChatError(msg || `chat server answered ${res.status}`, res.status)
  }
  return data
}

const rpc = (db, name, args = {}) => call(db, 'POST', `/rest/v1/rpc/${name}`, args)

/** Sign in, and join (or rename) this agency: Everyone group + inbox with Adal. */
export async function me(db) {
  await token(db)
  const company = await db('companies').first().catch(() => null)
  const name = String(company?.name || 'Adal Keep agency').trim()
  if (joinedAs !== name) {
    await rpc(db, 'join_agency', { p_name: name, p_pc: pcNumber() })
    joinedAs = name
  }
  const rows = await call(db, 'GET', `/rest/v1/agencies?id=eq.${sess.user_id}&select=id,name,banned`)
  return rows?.[0] || { id: sess.user_id, name, banned: false }
}

export const agencies = (db) => rpc(db, 'list_agencies')
export const conversations = async (db) => { await me(db); return rpc(db, 'my_conversations') }
export const openDirect = (db, other) => rpc(db, 'open_direct', { other })

export async function messages(db, conversationId, afterId = 0) {
  const rows = await call(db, 'GET',
    `/rest/v1/messages?conversation_id=eq.${encodeURIComponent(conversationId)}&id=gt.${Number(afterId) || 0}` +
    `&select=id,sender_id,body,image_path,created_at&order=id.desc&limit=${afterId ? 200 : 80}`)
  const list = (rows || []).reverse()
  if (list.length) {
    // Read up to the newest one.
    await call(db, 'PATCH',
      `/rest/v1/members?conversation_id=eq.${encodeURIComponent(conversationId)}&agency_id=eq.${sess.user_id}`,
      { last_read_id: list[list.length - 1].id }, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
  return list
}

async function uploadImage(db, buffer, mimetype) {
  const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' }[mimetype] || 'jpg'
  const name = `${sess.user_id}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
  await call(db, 'POST', `/storage/v1/object/${BUCKET}/${name}`, buffer, { headers: { 'Content-Type': mimetype || 'image/jpeg' } })
  return name
}

export async function send(db, conversationId, body, image) {
  const text = String(body || '').trim()
  if (LINK_RE.test(text)) throw new ChatError('Links are not allowed in the chat.', 400)
  if (!text && !image) throw new ChatError('Nothing to send.', 400)
  await me(db)
  const image_path = image ? await uploadImage(db, image.buffer, image.mimetype) : null
  const rows = await call(db, 'POST', '/rest/v1/messages',
    { conversation_id: conversationId, body: text || null, image_path },
    { headers: { Prefer: 'return=representation' } })
  return rows?.[0]
}

/** A picture from the chat, streamed through this PC (the browser never needs the key). */
export async function image(db, imagePath) {
  if (!/^[0-9a-f-]{36}\/[\w.-]+$/i.test(String(imagePath || ''))) throw new ChatError('bad picture', 400)
  const res = await call(db, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${imagePath}`, undefined, { raw: true })
  if (!res.ok) throw new ChatError('picture not found', 404)
  return { type: res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) }
}

/** The payment receipt goes to Adal: an unlock request + the picture in the inbox with Adal. */
export async function sendUnlockRequest(db, image) {
  const agency = await me(db)
  const image_path = await uploadImage(db, image.buffer, image.mimetype)
  await call(db, 'POST', '/rest/v1/unlock_requests', { pc_number: pcNumber(), image_path }, { headers: { Prefer: 'return=minimal' } })
  const convs = await rpc(db, 'my_conversations')
  const inbox = (convs || []).find(c => c.kind === 'admin')
  if (inbox) {
    await call(db, 'POST', '/rest/v1/messages',
      { conversation_id: inbox.id, body: `Payment receipt — PC number ${pcNumber()} (${agency.name})`, image_path },
      { headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
  return { ok: true }
}

/** The newest unlock request of this PC: pending / approved / rejected (+ note). */
export async function unlockStatus(db) {
  await me(db)
  const rows = await call(db, 'GET',
    `/rest/v1/unlock_requests?agency_id=eq.${sess.user_id}&pc_number=eq.${pcNumber()}&select=id,status,note,created_at,decided_at&order=id.desc&limit=1`)
  return rows?.[0] || null
}
