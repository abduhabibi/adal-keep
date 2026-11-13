/**
 * The chat on a phone with the office PC off (or far away): straight to the
 * chat server (Supabase), as the agency's own chat account — the same calls
 * the PC makes (backend services/chatCloud.js). The account comes from the
 * agency's locked vault ("/vault", opened only on the agency's own phones),
 * so nothing waits for the PC: messages, pictures, files, voice notes,
 * groups, search — everywhere.
 */
import { cloudCreds, openVault } from './adapter.js'

const BUCKET = 'chat'
const LINK_RE = /(https?:\/\/|www\.|t\.me\/|wa\.me\/|[a-z0-9-]+\.(com|net|org|io|me|et|sa|ae|kw|qa|info|biz|co|app|link|xyz|ly|gl|site|online|shop)(\/|\s|$))/i
const MSG_FIELDS = 'id,sender_id,body,image_path,created_at,reply_to,edited_at,deleted_at,updated_at,forwarded_from,kind,file_path,file_name,file_mime,file_size'
const EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'application/pdf': 'pdf', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' }

const fail = (status, message) => { const e = new Error(message); e.response = { status, data: { error: message } }; return e }

let sess = null   // { access_token, refresh_token, expires_at, user_id }
let account = null
async function chatAccount() {
  if (account) return account
  let v = await openVault().catch(() => ({}))
  // Not in the phone's own copy yet: the online one, fresh.
  if (!v?.['/chat-account']) v = await openVault({ fresh: true }).catch(() => ({}))
  const a = v?.['/chat-account']
  if (!a?.email || !a?.password) throw fail(503, 'The chat opens here once the office PC has been on once since this update.')
  account = a
  return a
}
async function token() {
  if (sess?.access_token && sess.expires_at > Date.now()) return sess.access_token
  const c = cloudCreds(), a = await chatAccount()
  const grant = sess?.refresh_token ? ['refresh_token', { refresh_token: sess.refresh_token }] : ['password', { email: a.email, password: a.password }]
  let r = await fetch(`${c.url}/auth/v1/token?grant_type=${grant[0]}`, { method: 'POST', headers: { apikey: c.anon, 'Content-Type': 'application/json' }, body: JSON.stringify(grant[1]) })
  if (!r.ok && grant[0] === 'refresh_token') r = await fetch(`${c.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: c.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: a.email, password: a.password }) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.access_token) { account = null; throw fail(503, 'The chat could not sign in — it works again when the office PC is on.') }
  sess = { access_token: d.access_token, refresh_token: d.refresh_token, user_id: d.user?.id || a.user_id, expires_at: Date.now() + (Number(d.expires_in || 3600) - 60) * 1000 }
  return sess.access_token
}

async function call(method, p, body, { headers = {}, raw = false } = {}) {
  const c = cloudCreds()
  const isBlob = body instanceof Blob
  const r = await fetch(`${c.url}${p}`, {
    method,
    headers: { apikey: c.anon, Authorization: `Bearer ${await token()}`, ...(body !== undefined && !isBlob ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
  })
  if (raw) return r
  const t = await r.text()
  let data = null
  try { data = t ? JSON.parse(t) : null } catch { data = t }
  if (!r.ok) {
    const msg = data?.message || data?.error || String(t).slice(0, 200)
    if (/row-level security|violates/i.test(msg)) throw fail(403, 'Not allowed (links are not allowed, or this agency was blocked by Adal).')
    throw fail(r.status, msg || `chat server answered ${r.status}`)
  }
  return data
}
const rpc = (name, args = {}) => call('POST', `/rest/v1/rpc/${name}`, args)

async function me() {
  await token()
  const rows = await call('GET', `/rest/v1/agencies?id=eq.${sess.user_id}&select=id,name,banned`)
  return rows?.[0] || { id: sess.user_id, name: 'This agency', banned: false }
}

async function messages(conversation, afterId = 0, since = null) {
  const conv = encodeURIComponent(conversation)
  const rows = await call('GET', `/rest/v1/messages?conversation_id=eq.${conv}&id=gt.${Number(afterId) || 0}&select=${MSG_FIELDS}&order=id.desc&limit=${afterId ? 200 : 100}`)
  const list = (rows || []).reverse()
  let changed = []
  if (afterId && since) changed = await call('GET', `/rest/v1/messages?conversation_id=eq.${conv}&id=lte.${Number(afterId)}&updated_at=gt.${encodeURIComponent(since)}&select=${MSG_FIELDS}`) || []
  if (list.length) {
    await call('PATCH', `/rest/v1/members?conversation_id=eq.${conv}&agency_id=eq.${sess.user_id}`, { last_read_id: list[list.length - 1].id }, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
  return { messages: list, changed, now: new Date().toISOString() }
}

async function upload(file) {
  await token()
  const type = file.type || 'application/octet-stream'
  const ext = EXT[type] || (String(file.name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'bin').toLowerCase()
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')
  const key = `${sess.user_id}/${Date.now()}-${rand}.${ext}`
  await call('POST', `/storage/v1/object/${BUCKET}/${key}`, file, { headers: { 'Content-Type': type } })
  return key
}

async function send(form) {
  const get = (k) => (form instanceof FormData ? form.get(k) : form?.[k]) ?? null
  const text = String(get('body') || '').trim()
  const file = get('file')
  const forward = get('forward'), replyTo = get('reply_to'), kind = get('kind')
  if (LINK_RE.test(text)) throw fail(400, 'Links are not allowed in the chat.')
  if (!text && !(file instanceof Blob) && !forward) throw fail(400, 'Nothing to send.')
  const row = { conversation_id: get('conversation'), body: text || null, kind: 'text' }
  if (replyTo) row.reply_to = Number(replyTo)
  if (forward) {
    const [orig] = await call('GET', `/rest/v1/messages?id=eq.${Number(forward)}&select=${MSG_FIELDS}`) || []
    if (!orig || orig.deleted_at) throw fail(404, 'That message is gone.')
    const names = Object.fromEntries((await rpc('list_agencies') || []).map(a => [a.id, a.is_admin ? 'Adal Keep' : a.name]))
    Object.assign(row, { body: orig.body, kind: orig.kind || 'text', image_path: orig.image_path, file_path: orig.file_path, file_name: orig.file_name, file_mime: orig.file_mime, file_size: orig.file_size, forwarded_from: orig.forwarded_from || names[orig.sender_id] || 'an agency' })
  } else if (file instanceof Blob) {
    const isImage = /^image\//.test(file.type || '')
    const k = kind === 'voice' ? 'voice' : isImage ? 'image' : 'file'
    const key = await upload(file)
    row.kind = k
    if (k === 'image') row.image_path = key
    else Object.assign(row, { file_path: key, file_name: String(file.name || (k === 'voice' ? 'voice.webm' : 'file')).slice(0, 200), file_mime: file.type, file_size: file.size })
  }
  const rows = await call('POST', '/rest/v1/messages', row, { headers: { Prefer: 'return=representation' } })
  return rows?.[0]
}

async function picture(path) {
  if (!/^[0-9a-f-]{36}\/[\w.-]+$/i.test(String(path || ''))) throw fail(400, 'bad file')
  const r = await call('GET', `/storage/v1/object/authenticated/${BUCKET}/${path}`, undefined, { raw: true })
  if (!r.ok) throw fail(404, 'picture not found')
  return r.blob()
}

/** One /api/chat/… call answered here; undefined when it is not a chat call this knows. */
export async function chatDirect(method, path, query = {}, body) {
  const m = method.toLowerCase()
  const id = (re) => path.match(re)?.[1]
  if (m === 'get') {
    if (path === '/chat/status') return { configured: true, me: await me(), direct: true }
    if (path === '/chat/agencies') return rpc('list_agencies')
    if (path === '/chat/conversations') { await token(); return rpc('my_conversations') }
    if (path === '/chat/messages') return messages(query.conversation, query.after, query.since)
    if (path === '/chat/typing') return rpc('typing_in', { conv: query.conversation }).catch(() => [])
    if (path === '/chat/search') {
      const term = String(query.q || '').trim().replace(/[%*,()]/g, ' ')
      if (term.length < 2) return []
      return await call('GET', `/rest/v1/messages?body=ilike.*${encodeURIComponent(term)}*&deleted_at=is.null&select=id,conversation_id,sender_id,body,created_at&order=id.desc&limit=50`) || []
    }
    if (path === '/chat/image' || path === '/chat/file') return picture(query.path)
    if (id(/^\/chat\/groups\/([^/]+)\/members$/)) return rpc('group_members', { conv: id(/^\/chat\/groups\/([^/]+)\/members$/) })
    if (path === '/chat/unlock-status') return { status: 'none' }
    return undefined
  }
  const b = body && !(body instanceof FormData) ? body : {}
  if (path === '/chat/send') return send(body)
  if (path === '/chat/ping') { await rpc('ping').catch(() => null); return { ok: true } }
  if (path === '/chat/typing') { await rpc('set_typing', { conv: b.conversation }).catch(() => null); return { ok: true } }
  if (id(/^\/chat\/direct\/([^/]+)$/)) return { id: await rpc('open_direct', { other: id(/^\/chat\/direct\/([^/]+)$/) }) }
  if (id(/^\/chat\/messages\/(\d+)\/edit$/)) {
    if (LINK_RE.test(String(b.body || ''))) throw fail(400, 'Links are not allowed in the chat.')
    return rpc('edit_message', { msg: Number(id(/^\/chat\/messages\/(\d+)\/edit$/)), p_body: String(b.body || '') })
  }
  if (id(/^\/chat\/messages\/(\d+)\/delete$/)) return rpc('delete_message', { msg: Number(id(/^\/chat\/messages\/(\d+)\/delete$/)) })
  if (id(/^\/chat\/conversations\/([^/]+)\/pin$/)) return rpc('pin_message', { conv: id(/^\/chat\/conversations\/([^/]+)\/pin$/), msg: b.message ? Number(b.message) : null })
  if (path === '/chat/groups') return { id: await rpc('create_group', { p_title: String(b.title || ''), p_members: b.members || [] }) }
  const g = path.match(/^\/chat\/groups\/([^/]+)\/(members|remove|admin|rename)$/)
  if (g) {
    if (g[2] === 'members') return rpc('add_group_members', { conv: g[1], p_members: b.members || [] })
    if (g[2] === 'remove') return rpc('remove_group_member', { conv: g[1], who: b.agency })
    if (g[2] === 'admin') return rpc('set_group_admin', { conv: g[1], who: b.agency, make_admin: !!b.admin })
    if (g[2] === 'rename') return rpc('rename_group', { conv: g[1], p_title: String(b.title || '') })
  }
  return undefined
}
