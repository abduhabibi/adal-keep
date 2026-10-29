/**
 * Cloud mode — the phone app when its PC cannot be reached (home, night, the
 * PC off). services/api.js swaps axios' adapter for `cloudAdapter`, so every
 * page works unchanged on the agency's online copy (Supabase, filled by the
 * PC: backend services/cloudSync.js).
 *   GET     → the answer the PC saved for that API path (keep_meta)
 *   PUT, POST, PATCH, DELETE → a request (keep_changes) the PC carries out
 *             when it is on again; the page sees it at once where it can
 *   uploads → the files go to online storage first, then a request
 * Documents open from online storage (/api/files/<id>/… links are rewritten).
 */
import { connectLive, liveCall, liveReady, pcLive, onLive } from './live.js'
import { mirrorReady, mirrorHas, mirrorGet, mirrorAt, mirrorAge, mirrorPut, mirrorSync, mirrorFetch, mirrorPrune, mirrorTake } from './mirror.js'

const SAVED = 'adal-pc'
// Adal Keep Admin opens one agency per window (window.__ADAL_CREDS): its own copies.
const SUFFIX = typeof window !== 'undefined' && window.__ADAL_CREDS ? `-${window.__ADAL_CREDS.agency}` : ''
const CACHE = 'adal-cloud-cache' + SUFFIX
const PENDING = 'adal-cloud-pending' + SUFFIX   // profile edits the PC has not copied back yet

export function cloudCreds() {
  if (typeof window !== 'undefined' && window.__ADAL_CREDS) return window.__ADAL_CREDS
  try { return JSON.parse(localStorage.getItem(SAVED) || 'null')?.cloud || null } catch { return null }
}
export const inCloudMode = () => typeof window !== 'undefined' && window.__ADAL_CLOUD === true

// ---------------------------------------------------------------- session
let sess = null
async function token() {
  const c = cloudCreds()
  if (!c) throw httpError(401, 'This phone is not paired. Pair it on the office Wi-Fi first.')
  if (sess?.access_token && sess.expires_at > Date.now()) return sess.access_token
  const grant = sess?.refresh_token
    ? { path: 'refresh_token', body: { refresh_token: sess.refresh_token } }
    : { path: 'password', body: { email: c.email, password: c.password } }
  let r = await fetch(`${c.url}/auth/v1/token?grant_type=${grant.path}`, { method: 'POST', headers: { apikey: c.anon, 'Content-Type': 'application/json' }, body: JSON.stringify(grant.body) })
  if (!r.ok && grant.path === 'refresh_token') {
    r = await fetch(`${c.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: c.anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.email, password: c.password }) })
  }
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.access_token) throw httpError(401, 'This phone was removed from the agency, or cannot sign in online.')
  sess = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (Number(d.expires_in || 3600) - 60) * 1000 }
  return sess.access_token
}

export const getToken = () => token()

export async function gunzipJSON(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  return JSON.parse(text)
}

async function rest(method, p, body, headers = {}) {
  const c = cloudCreds()
  const r = await fetch(`${c.url}${p}`, {
    method,
    headers: { apikey: c.anon, Authorization: `Bearer ${await token()}`, ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  })
  if (!r.ok) throw httpError(r.status, (await r.text()).slice(0, 200) || 'Online copy not reachable')
  const t = await r.text()
  return t ? JSON.parse(t) : null
}

function httpError(status, message) {
  const e = new Error(message)
  e.response = { status, data: { error: message } }
  return e
}

// ---------------------------------------------------------------- answers
// Every answer comes from the phone's own copy (mirror.js); the old small
// copy in localStorage is not used any more.
try { localStorage.removeItem(CACHE) } catch {}
const cache = new Proxy({}, { get: (_, k) => mirrorGet(k), has: (_, k) => mirrorHas(k) })
const remember = (key, data) => mirrorPut(key, data)

let pending = {}
try { pending = JSON.parse(localStorage.getItem(PENDING) || '{}') } catch {}
const savePending = () => { try { localStorage.setItem(PENDING, JSON.stringify(pending)) } catch {} }

// This phone's edits stay visible until the online copy is newer than them.
function withPending(key, data, updatedAt) {
  const fresh = (id) => {
    const p = pending[id]
    if (p && updatedAt && new Date(updatedAt) > new Date(p.at)) { delete pending[id]; savePending(); return null }
    return p
  }
  const one = key.match(/^\/profiles\/(\d+)$/)
  if (one) { const p = fresh(one[1]); return p && data ? { ...data, ...p.body } : data }
  if (key === '/profiles' && Array.isArray(data)) return data.map(r => { const p = fresh(String(r.id)); return p ? { ...r, ...p.body } : r })
  return data
}

async function answer(key) {
  const c = cloudCreds()
  await mirrorReady(c.agency)
  if (mirrorHas(key)) return withPending(key, mirrorGet(key), mirrorAt(key))
  // Not on the phone yet (the first copy is still coming): just this one.
  const rows = await rest('GET', `/rest/v1/keep_meta?key=eq.${encodeURIComponent(key)}&select=data,updated_at`)
  if (!rows?.length) return undefined
  remember(key, rows[0].data)
  return withPending(key, rows[0].data, rows[0].updated_at)
}

const matchText = (p, q) => {
  const s = String(q || '').trim().toLowerCase()
  if (!s) return true
  return [p.full_name, p.passport_number, p.labor_id, p.phone_number, p.national_id, p.amharic_name]
    .some(v => String(v || '').toLowerCase().includes(s))
}

async function get(path, query) {
  if (path === '/auth/me') throw httpError(401, 'Not signed in')
  if (path === '/mobile/ping' || path === '/tasks/calls') return path === '/tasks/calls' ? [] : { ok: true, cloud: true }
  if (path === '/profiles') {
    const all = (await answer('/profiles')) || []
    return all.filter(p => (!query.broker_id || String(p.broker_id) === String(query.broker_id))
      && (!query.status || p.status === query.status) && matchText(p, query.q || query.search))
  }
  const files = path.match(/^\/profiles\/(\d+)\/fields\/(\d+)\/files$/)
  if (files) {
    const fields = (await answer(`/profiles/${files[1]}/fields`)) || []
    return fields.find(f => String(f.id) === files[2])?.files || []
  }
  if (path === '/cv/generated' && query.profile_id) return (await answer(`/cv/generated?profile_id=${query.profile_id}`)) || []
  const data = await answer(path)
  if (data === undefined) throw httpError(503, 'This needs the PC — it is not in the online copy.')
  return data
}

// ---------------------------------------------------------------- changes
const NEEDS_PC = /^\/(chat|system|backup|branch|main-pc|mobile|subscription|setup|automations\/\d+\/(input|screen))/
const QUIET = /^\/(tutor|employees\/device-(login|resume|logout)|chat\/ping)/

async function request(kind, payload, profileId = null) {
  const c = cloudCreds()
  await rest('POST', '/rest/v1/keep_changes', { agency_id: c.agency, kind, payload, profile_id: profileId }, { Prefer: 'return=minimal' })
}

async function uploadParts(form) {
  const c = cloudCreds()
  const fields = {}, files = []
  for (const [k, v] of form.entries()) {
    if (v instanceof Blob) {
      const name = v.name || 'file'
      const object = `${c.agency}/inbox/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name.replace(/[^\w.\-]+/g, '_').slice(-60)}`
      await rest('POST', `/storage/v1/object/keep/${object}`, v, { 'Content-Type': v.type || 'application/octet-stream' })
      files.push({ field: k, object, name, mimetype: v.type || '' })
    } else fields[k] = String(v)
  }
  return { form: fields, files }
}

// What the page sees right away for a change it made (the PC confirms later).
function optimistic(method, path, body) {
  const one = path.match(/^\/profiles\/(\d+)$/)
  if (one && ['put', 'patch'].includes(method) && body && typeof body === 'object') {
    pending[one[1]] = { body: { ...(pending[one[1]]?.body || {}), ...body }, at: new Date().toISOString() }
    savePending()
    if (cache[path]) remember(path, { ...cache[path], ...body })
    if (Array.isArray(cache['/profiles'])) remember('/profiles', cache['/profiles'].map(p => String(p.id) === one[1] ? { ...p, ...body } : p))
    return { ...(cache[path] || {}), ...body, success: true, queued: true }
  }
  return { ok: true, success: true, queued: true, message: 'Saved — the PC carries it out when it is on.' }
}

// Removed tasks leave the phone's copy at once (the PC confirms later).
function dropTasks(method, path, body) {
  const one = method === 'delete' && path.match(/^\/tasks\/(\d+)$/)?.[1]
  const ids = one ? [Number(one)] : path === '/tasks/clear' ? (body?.ids || []).map(Number) : null
  if (!ids || !Array.isArray(cache['/tasks'])) return
  remember('/tasks', cache['/tasks'].filter(t => !ids.includes(Number(t.id))))
}

async function change(method, path, body) {
  if (NEEDS_PC.test(path)) throw httpError(503, 'This needs the PC (it is off or far away). It works again when the phone reaches the PC.')
  if (QUIET.test(path)) return { ok: true }
  const pid = Number(path.match(/^\/profiles\/(\d+)/)?.[1]) || null
  if (body instanceof FormData) {
    await request('upload', { path, ...(await uploadParts(body)) }, pid)
    return { ok: true, success: true, queued: true, files: [], message: 'Uploaded — the PC files it when it is on.' }
  }
  await request('api', { method: method.toUpperCase(), path, body: body ?? null }, pid)
  return optimistic(method, path, body)
}

// ---------------------------------------------------------------- relay
// The PC is on (it says so every 15 s): the phone's calls go to the PC itself
// through keep_calls and come back in a second or two — live tabs, captchas,
// chat, everything. Off: the online copy above.
let alive = { at: 0, on: false }
export async function pcOnline() {
  if (pcLive()) return true
  if (Date.now() - alive.at < 10000) return alive.on
  let on = false
  try {
    const rows = await rest('GET', '/rest/v1/keep_meta?key=eq./_pc&select=data')
    on = !!rows?.[0] && Date.now() - new Date(rows[0].data.at).getTime() < 45000
  } catch {}
  alive = { at: Date.now(), on }
  try { window.dispatchEvent(new CustomEvent('adal-pc-online', { detail: on })) } catch {}
  return on
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))
async function relay(method, pathAndQuery, body, ms) {
  const c = cloudCreds()
  const [row] = await rest('POST', '/rest/v1/keep_calls?select=id', { agency_id: c.agency, method: method.toUpperCase(), path: pathAndQuery, body: body ?? null }, { Prefer: 'return=representation' })
  const end = Date.now() + ms
  for (let n = 0; Date.now() < end; n++) {
    await wait(n < 3 ? 350 : 500)
    const [a] = await rest('GET', `/rest/v1/keep_calls?id=eq.${row.id}&select=status,answer,answer_bin,answer_type,answer_head,answer_code`)
    if (!a || a.status === 'new') continue
    if (a.status === 'late') break
    return a
  }
  alive = { at: 0, on: false }      // no answer: ask again whether the PC is on
  return null
}

function relayed(a, config) {
  let data = a.answer
  if (a.answer_bin != null) {
    const bin = atob(a.answer_bin)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    data = new Blob([bytes], { type: a.answer_type || 'application/octet-stream' })
  } else if (config.responseType === 'blob' && data != null && !(data instanceof Blob)) {
    data = new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: a.answer_type || 'application/json' })
  }
  const headers = { 'content-type': a.answer_type || '', ...(a.answer_head || {}) }
  if (a.answer_code >= 400) {
    const msg = a.answer?.error || a.answer?.message || `Error ${a.answer_code}`
    const e = httpError(a.answer_code, msg)
    e.response = { status: a.answer_code, data: a.answer, headers }
    throw e
  }
  return { data, status: a.answer_code || 200, headers }
}

// ---------------------------------------------------------------- the copy
// Asked from the PC every time while it is live (they change by the second).
const LIVE_FIRST = /^\/(automations|chat|mobile|tasks\/calls|employees\/device|auth)\b/
// The copy's key for a page's GET: the path (a field's files live in its fields).
function baseKey(path, query) {
  const files = path.match(/^\/profiles\/(\d+)\/fields\/(\d+)\/files$/)
  if (files) return `/profiles/${files[1]}/fields`
  if (path === '/profiles') return path
  if (path === '/cv/generated' && query?.profile_id) return `/cv/generated?profile_id=${query.profile_id}`
  return Object.keys(query || {}).length ? null : path
}
// Right after a change, the touched answers come from the PC itself for a few
// seconds (the copy catches up within ~2 s: the PC says what changed).
const dirty = new Map()
function markDirty(path) {
  const id = path.match(/^\/profiles\/(\d+)/)?.[1]
  const until = Date.now() + 10000
  const keys = id ? [`/profiles/${id}`, `/profiles/${id}/fields`, `/profiles/${id}/automations`, `/profiles/${id}/journey`, `/cv/profile-readiness/${id}`, '/profiles']
    : [path.split('?')[0], '/profiles', '/tasks', '/checklists', '/brokers', '/notifications']
  keys.forEach(k => dirty.set(k, until))
}
const isDirty = (key) => (dirty.get(key) || 0) > Date.now()
const revalidating = new Set()
function revalidate(key) {
  if (revalidating.has(key)) return
  revalidating.add(key)
  liveCall('get', key, undefined, 9000).then(async (m) => {
    if (!m || m.code >= 300 || m.bin) return
    const data = m.gz ? await gunzipJSON(m.gz) : m.data
    if (data !== undefined && data !== null) remember(key, data)
  }).catch(() => {}).finally(() => revalidating.delete(key))
}

/** Keep the phone's copy current: now, every 20 s while open, at once when the PC says what changed. */
let mirrorOn = false
export function startMirror() {
  const c = cloudCreds()
  if (!c || mirrorOn) return
  mirrorOn = true
  const sync = () => { if (!document.hidden) mirrorSync(rest, c.agency).catch(() => {}) }
  sync()
  setInterval(sync, 20000)
  document.addEventListener('visibilitychange', sync)
  onLive((m) => {
    if (m.t !== 'changed') return
    if (Array.isArray(m.rows)) mirrorTake(m.rows, c.agency)
    if (Array.isArray(m.keys)) mirrorFetch(rest, c.agency, m.keys).catch(() => {})
  })
  const prune = () => mirrorPrune(rest, c.agency).catch(() => {})
  setTimeout(prune, 60000); setInterval(prune, 15 * 60000)
}

// ---------------------------------------------------------------- adapter
export async function cloudAdapter(config) {
  const method = (config.method || 'get').toLowerCase()
  const u = new URL(String(config.url || ''), 'http://cloud/api/')
  const path = (u.pathname.startsWith('/api') ? u.pathname.slice(4) : u.pathname) || '/'
  const query = { ...Object.fromEntries(u.searchParams), ...(config.params || {}) }
  let body = config.data
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch {} }
  const reply = (status, data, headers = {}) => ({ data, status, statusText: String(status), headers, config, request: {} })
  try {
    // Fast: pages read the phone's own copy at once; with the PC live, an
    // answer older than a minute is asked for behind it (the next look is newer).
    if (method === 'get' && config.responseType !== 'blob' && !LIVE_FIRST.test(path)) {
      const key = baseKey(path, query)
      const c = cloudCreds()
      if (key && !isDirty(key)) {
        await mirrorReady(c.agency)
        if (mirrorHas(key)) {
          if (key === path && pcLive() && mirrorAge(key) > 60000) revalidate(key)
          return reply(200, await get(path, query))
        }
      }
    }
    if (method !== 'get') { markDirty(path); dropTasks(method, path, body) }
    if (await pcOnline()) {
      const qs = u.search || (config.params ? '?' + new URLSearchParams(Object.entries(config.params).filter(([, v]) => v != null)).toString() : '')
      // Uploads: the files go online first; the PC files them at once.
      // A form: its text goes as it is; its files go online first and the PC
      // files them at once and answers (a chat message shows straight away).
      let sendBody = body
      if (body instanceof FormData) {
        const hasFile = [...body.values()].some(v => v instanceof Blob)
        sendBody = hasFile ? { __upload: { path, ...(await uploadParts(body)) } } : Object.fromEntries(body.entries())
      }
      let a = null
      // The live link first (a fraction of a second), else the slower way.
      if (liveReady()) {
        const m = await liveCall(method, path + qs, method === 'get' ? undefined : sendBody, method === 'get' ? 9000 : sendBody?.__upload ? 90000 : 20000)
        if (m?.row) a = (await rest('GET', `/rest/v1/keep_calls?id=eq.${m.row}&select=status,answer,answer_bin,answer_type,answer_head,answer_code`))?.[0] || null
        else if (m) a = { answer_code: m.code, answer_type: m.type, answer_head: m.head, answer: m.gz ? await gunzipJSON(m.gz) : m.data, answer_bin: m.bin }
        if (!m && method !== 'get') throw httpError(504, 'The PC did not answer in time — it may still do it. Look again in a moment.')
      }
      if (!a) {
        try { a = await relay(method, path + qs, method === 'get' ? undefined : sendBody, method === 'get' ? 12000 : sendBody?.__upload ? 90000 : 25000) }
        catch (e) { if (method !== 'get') throw e }
      }
      if (a) {
        const r = relayed(a, config)
        if (method === 'get' && !qs && r.status < 300 && !(r.data instanceof Blob) && /json/.test(r.headers['content-type'] || '') && !LIVE_FIRST.test(path)) remember(path, r.data)
        return reply(r.status, r.data, r.headers)
      }
      if (method !== 'get') throw httpError(504, 'The PC did not answer in time — it may still do it. Look again in a moment.')
      // A GET with no answer: the online copy below.
    }
    const data = method === 'get' ? await get(path, query) : await change(method, path, body)
    if (config.responseType === 'blob' && !(data instanceof Blob)) throw httpError(503, 'This needs the PC.')
    return reply(200, data)
  } catch (e) {
    // The last calls that failed (for looking into problems: window.__adalErrors).
    try { (window.__adalErrors ||= []).push({ at: new Date().toISOString(), method, path, error: e.message }); window.__adalErrors.splice(0, window.__adalErrors.length - 20) } catch {}
    const err = e.response ? e : httpError(503, e.message)
    err.config = config
    err.response = { ...err.response, config, headers: {}, statusText: String(err.response.status) }
    throw err
  }
}

// ---------------------------------------------------------------- documents
// <img src="/api/files/12/download">, <a href="/api/files/12/download"> … → a
// short-lived link to the same file in online storage.
// The agency's secrets: the documents' key and the Telegram bot that keeps them.
let secretsP = null
export const cloudSecrets = () => (secretsP ||= rest('GET', '/rest/v1/keep_secrets?select=file_key,live,bot').then(r => r?.[0] || null).catch(() => { secretsP = null; return null }))

/** "AK1" + iv + tag + data (AES-256-GCM with the agency's key) → the bytes. */
async function openAK1(buf, keyB64) {
  if (buf[0] !== 65 || buf[1] !== 75 || buf[2] !== 49) throw new Error('not locked by Adal Keep')
  const raw = Uint8Array.from(atob(keyB64), ch => ch.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const iv = buf.slice(3, 15), tag = buf.slice(15, 31), data = buf.slice(31)
  const joined = new Uint8Array(data.length + tag.length); joined.set(data); joined.set(tag, data.length)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, joined))
}

/** The portals' sign-ins (LMIS, Musaned …) with their passwords — "/vault", opened here. */
export async function openVault() {
  const c = cloudCreds()
  await mirrorReady(c.agency)
  let v = mirrorGet('/vault')
  if (!v) { const rows = await rest('GET', '/rest/v1/keep_meta?key=eq./vault&select=data'); v = rows?.[0]?.data; if (v) remember('/vault', v) }
  const s = await cloudSecrets()
  if (!v?.v || !s?.file_key) return {}
  const plain = await openAK1(Uint8Array.from(atob(v.v), ch => ch.charCodeAt(0)), s.file_key)
  return JSON.parse(new TextDecoder().decode(plain))
}

/** A document kept in Telegram: download, decrypt here (AES-GCM) — the file itself. */
async function telegramFile(object, mimetype) {
  const s = await cloudSecrets()
  if (!s?.bot) return null
  const fileId = object.split(':')[1]
  const f = await (await fetch(`https://api.telegram.org/bot${s.bot}/getFile?file_id=${encodeURIComponent(fileId)}`)).json()
  if (!f.ok) return null
  const buf = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${s.bot}/${f.result.file_path}`)).arrayBuffer())
  if (buf[0] !== 65 || buf[1] !== 75 || buf[2] !== 49) return null          // "AK1"
  const raw = Uint8Array.from(atob(s.file_key), ch => ch.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  // Node writes iv | tag | data; WebCrypto wants data | tag.
  const iv = buf.slice(3, 15), tag = buf.slice(15, 31), data = buf.slice(31)
  const joined = new Uint8Array(data.length + tag.length); joined.set(data); joined.set(tag, data.length)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, joined)
  return new Blob([plain], { type: mimetype || 'application/octet-stream' })
}

// Documents and pictures stay on the phone once opened (Cache Storage, up to
// ~400 MB; the ones not opened for longest go first).
const FILES = 'adal-files-v1', FILES_INDEX = 'adal-files-index', FILES_MAX = 400 * 1024 * 1024
const fileReq = (id) => new Request(`https://files.adal.local/${cloudCreds()?.agency || ''}/${id}`)
async function cachedFile(id) {
  try {
    const hit = await (await caches.open(FILES)).match(fileReq(id))
    if (!hit) return null
    const idx = JSON.parse(localStorage.getItem(FILES_INDEX) || '{}')
    if (idx[id]) { idx[id][1] = Date.now(); localStorage.setItem(FILES_INDEX, JSON.stringify(idx)) }
    return await hit.blob()
  } catch { return null }
}
async function keepFile(id, blob) {
  try {
    const c = await caches.open(FILES)
    await c.put(fileReq(id), new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } }))
    const idx = JSON.parse(localStorage.getItem(FILES_INDEX) || '{}')
    idx[id] = [blob.size, Date.now()]
    let total = Object.values(idx).reduce((n, [b]) => n + b, 0)
    for (const [k] of Object.entries(idx).sort((a, b) => a[1][1] - b[1][1])) {
      if (total <= FILES_MAX) break
      total -= idx[k][0]; delete idx[k]; await c.delete(fileReq(k))
    }
    localStorage.setItem(FILES_INDEX, JSON.stringify(idx))
  } catch {}
}

const signed = new Map()
async function signedUrl(fileId) {
  if (signed.has(fileId)) return signed.get(fileId)
  const p = (async () => {
    // On the phone already: no download at all.
    let blob = await cachedFile(fileId)
    if (!blob) {
      const rows = await rest('GET', `/rest/v1/keep_files?id=eq.${fileId}&select=object,mimetype`)
      if (!rows?.[0]?.object) return null
      if (rows[0].object.startsWith('tg:')) blob = await telegramFile(rows[0].object, rows[0].mimetype)
      else {
        const c = cloudCreds()
        const s = await rest('POST', `/storage/v1/object/sign/keep/${rows[0].object}`, { expiresIn: 6 * 3600 })
        if (!s?.signedURL) return null
        const r = await fetch(`${c.url}/storage/v1${s.signedURL.startsWith('/') ? '' : '/'}${s.signedURL}`)
        if (!r.ok) return null
        blob = await r.blob()
        if (rows[0].mimetype && !blob.type) blob = new Blob([blob], { type: rows[0].mimetype })
      }
      if (!blob) return null
      keepFile(fileId, blob)
    }
    return URL.createObjectURL(blob)
  })().catch(() => { signed.delete(fileId); return null })
  signed.set(fileId, p)
  return p
}

function fixNode(el) {
  for (const attr of ['src', 'href']) {
    const v = el.getAttribute?.(attr)
    const m = v && v.match(/^\/api\/files\/(\d+)\b/)
    if (!m || el.dataset.cloudFixed === v) continue
    el.dataset.cloudFixed = v
    signedUrl(m[1]).then(url => { if (url && el.getAttribute(attr) === v) el.setAttribute(attr, url) })
  }
}

/** The live link to the PC (phones; Admin windows use the slower way). */
export async function startLive() {
  const c = cloudCreds()
  if (!c || !/^https:/.test(c.url)) return
  const s = await cloudSecrets()
  if (s?.live) connectLive({ url: c.url, anon: c.anon, live: s.live, token })
}

export function startCloudDocuments() {
  const scan = (root) => { if (root.querySelectorAll) { fixNode(root); root.querySelectorAll('img[src^="/api/files/"], a[href^="/api/files/"]').forEach(fixNode) } }
  scan(document.body)
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') fixNode(m.target)
      else m.addedNodes.forEach(scan)
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] })
}
