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

const MSG_FIELDS_V2 = 'id,sender_id,body,image_path,created_at,reply_to,edited_at,deleted_at,updated_at,forwarded_from,kind,file_path,file_name,file_mime,file_size'
const MSG_FIELDS_V1 = 'id,sender_id,body,image_path,created_at'
// Until Adal runs the new schema.sql in Supabase the v2 columns are missing:
// the chat keeps working with the old ones.
let v2 = true
let MSG_FIELDS = MSG_FIELDS_V2
const missingColumn = (e) => /column|schema cache|could not find/i.test(String(e?.message || ''))
function dropToV1() { v2 = false; MSG_FIELDS = MSG_FIELDS_V1; console.warn('[chat] Supabase has the old chat schema — run adal-admin/supabase/schema.sql again for groups, replies, files…') }

/**
 * New messages after `afterId`, plus older ones changed (edited, deleted)
 * since `since`. Marks the chat read up to the newest.
 */
export async function messages(db, conversationId, afterId = 0, since = null) {
  try { return await messagesOnce(db, conversationId, afterId, since) }
  catch (e) { if (v2 && missingColumn(e)) { dropToV1(); return messagesOnce(db, conversationId, afterId, since) } throw e }
}

async function messagesOnce(db, conversationId, afterId = 0, since = null) {
  const conv = encodeURIComponent(conversationId)
  const rows = await call(db, 'GET',
    `/rest/v1/messages?conversation_id=eq.${conv}&id=gt.${Number(afterId) || 0}` +
    `&select=${MSG_FIELDS}&order=id.desc&limit=${afterId ? 200 : 100}`)
  const list = (rows || []).reverse()
  let changed = []
  if (v2 && afterId && since) {
    changed = await call(db, 'GET',
      `/rest/v1/messages?conversation_id=eq.${conv}&id=lte.${Number(afterId)}&updated_at=gt.${encodeURIComponent(since)}&select=${MSG_FIELDS}`) || []
  }
  if (list.length) {
    await call(db, 'PATCH',
      `/rest/v1/members?conversation_id=eq.${conv}&agency_id=eq.${sess.user_id}`,
      { last_read_id: list[list.length - 1].id }, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
  return { messages: list, changed, now: new Date().toISOString() }
}

const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'application/pdf': 'pdf', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' }
async function uploadFile(db, buffer, mimetype, name = '') {
  const ext = EXT[mimetype] || (String(name).match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase()
  const key = `${sess.user_id}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
  await call(db, 'POST', `/storage/v1/object/${BUCKET}/${key}`, buffer, { headers: { 'Content-Type': mimetype || 'application/octet-stream' } })
  return key
}
const uploadImage = (db, buffer, mimetype) => uploadFile(db, buffer, mimetype)

/**
 * Send a message: text, a picture, a file or a voice note; optionally a reply
 * (`replyTo`) or a forward (`forward`: the original message — its picture or
 * file is reused, not uploaded again).
 */
export async function send(db, conversationId, body, file, { kind = null, replyTo = null, forward = null } = {}) {
  const text = String(body || '').trim()
  if (LINK_RE.test(text)) throw new ChatError('Links are not allowed in the chat.', 400)
  if (!text && !file && !forward) throw new ChatError('Nothing to send.', 400)
  await me(db)
  const row = { conversation_id: conversationId, body: text || null, kind: 'text' }
  if (replyTo) row.reply_to = Number(replyTo)
  if (forward) {
    const [orig] = await call(db, 'GET', `/rest/v1/messages?id=eq.${Number(forward)}&select=${MSG_FIELDS}`) || []
    if (!orig || orig.deleted_at) throw new ChatError('That message is gone.', 404)
    const names = Object.fromEntries((await agencies(db) || []).map(a => [a.id, a.is_admin ? 'Adal Keep' : a.name]))
    Object.assign(row, {
      body: orig.body, kind: orig.kind || 'text', image_path: orig.image_path, file_path: orig.file_path,
      file_name: orig.file_name, file_mime: orig.file_mime, file_size: orig.file_size,
      forwarded_from: orig.forwarded_from || names[orig.sender_id] || 'an agency',
    })
  } else if (file) {
    const isImage = /^image\//.test(file.mimetype || '')
    const k = kind === 'voice' ? 'voice' : isImage ? 'image' : 'file'
    const key = await uploadFile(db, file.buffer, file.mimetype, file.name)
    row.kind = k
    if (k === 'image') row.image_path = key
    else Object.assign(row, { file_path: key, file_name: String(file.name || (k === 'voice' ? 'voice.webm' : 'file')).slice(0, 200), file_mime: file.mimetype, file_size: file.buffer.length })
  }
  if (!v2) {
    if (row.kind !== 'text' && row.kind !== 'image') throw new ChatError('Files and voice messages need the new chat database (Adal runs schema.sql once more).', 400)
    for (const k of ['kind', 'reply_to', 'forwarded_from', 'file_path', 'file_name', 'file_mime', 'file_size']) delete row[k]
  }
  try {
    const rows = await call(db, 'POST', '/rest/v1/messages', row, { headers: { Prefer: 'return=representation' } })
    return rows?.[0]
  } catch (e) {
    if (v2 && missingColumn(e)) { dropToV1(); return send(db, conversationId, body, file, { replyTo, forward }) }
    throw e
  }
}

export const editMessage = (db, id, body) => {
  if (LINK_RE.test(String(body || ''))) throw new ChatError('Links are not allowed in the chat.', 400)
  return rpc(db, 'edit_message', { msg: Number(id), p_body: String(body || '') })
}
export const deleteMessage = (db, id) => rpc(db, 'delete_message', { msg: Number(id) })
export const pinMessage = (db, conv, id) => rpc(db, 'pin_message', { conv, msg: id ? Number(id) : null })
export const createGroup = (db, title, members) => rpc(db, 'create_group', { p_title: String(title || ''), p_members: members || [] })
export const addMembers = (db, conv, members) => rpc(db, 'add_group_members', { conv, p_members: members || [] })
export const removeMember = (db, conv, who) => rpc(db, 'remove_group_member', { conv, who })
export const setAdmin = (db, conv, who, makeAdmin) => rpc(db, 'set_group_admin', { conv, who, make_admin: !!makeAdmin })
export const renameGroup = (db, conv, title) => rpc(db, 'rename_group', { conv, p_title: String(title || '') })
export const groupMembers = (db, conv) => rpc(db, 'group_members', { conv })
export const setTyping = (db, conv) => rpc(db, 'set_typing', { conv }).catch(() => null)
export const typingIn = (db, conv) => rpc(db, 'typing_in', { conv }).catch(() => [])
export const ping = (db) => rpc(db, 'ping').catch(() => null)

/** Messages in any of my chats containing `q` (the database only shows my chats). */
export async function search(db, q) {
  const term = String(q || '').trim().replace(/[%*,()]/g, ' ')
  if (term.length < 2) return []
  await me(db)
  return await call(db, 'GET', `/rest/v1/messages?body=ilike.*${encodeURIComponent(term)}*&deleted_at=is.null&select=id,conversation_id,sender_id,body,created_at&order=id.desc&limit=50`) || []
}

/** A picture from the chat, streamed through this PC (the browser never needs the key). */
export async function image(db, imagePath) {
  if (!/^[0-9a-f-]{36}\/[\w.-]+$/i.test(String(imagePath || ''))) throw new ChatError('bad file', 400)
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

/** Adal added this PC (by its number) in the admin panel and marked it paid. */
export async function paidByAdal(db) {
  await me(db)
  return (await rpc(db, 'my_invite_paid').catch(() => false)) === true
}

/** The newest unlock request of this PC: pending / approved / rejected (+ note). */
export async function unlockStatus(db) {
  if (await paidByAdal(db)) return { status: 'approved', note: 'Marked paid by Adal' }
  const rows = await call(db, 'GET',
    `/rest/v1/unlock_requests?agency_id=eq.${sess.user_id}&pc_number=eq.${pcNumber()}&select=id,status,note,created_at,decided_at&order=id.desc&limit=1`)
  return rows?.[0] || null
}

// The same Supabase connection, for the agency's online copy (cloudSync.js).
export const cloudCall = (db, method, pathAndQuery, body, opts) => call(db, method, pathAndQuery, body, opts)
export const cloudAuth = (pathAndQuery, body) => auth(pathAndQuery, body)
export async function cloudAgencyId(db) { await token(db); return sess?.user_id || null }
export const cloudConfig = () => cfg()
