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
const SAVED = 'adal-pc'
const CACHE = 'adal-cloud-cache'
const PENDING = 'adal-cloud-pending'   // profile edits the PC has not copied back yet

export function cloudCreds() {
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
let cache = {}
try { cache = JSON.parse(localStorage.getItem(CACHE) || '{}') } catch {}
function remember(key, data) {
  cache[key] = data
  try { localStorage.setItem(CACHE, JSON.stringify(cache)) } catch {
    // Full: keep only the lists and this answer.
    cache = Object.fromEntries(Object.entries(cache).filter(([k]) => !/^\/profiles\/\d+/.test(k)))
    cache[key] = data
    try { localStorage.setItem(CACHE, JSON.stringify(cache)) } catch {}
  }
}

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
  try {
    const rows = await rest('GET', `/rest/v1/keep_meta?key=eq.${encodeURIComponent(key)}&select=data,updated_at`)
    if (rows?.length) { const d = withPending(key, rows[0].data, rows[0].updated_at); remember(key, d); return d }
    if (key in cache) return cache[key]
    return undefined
  } catch (e) {
    if (key in cache) return cache[key]          // no internet: the last copy on the phone
    throw e
  }
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

// ---------------------------------------------------------------- adapter
export async function cloudAdapter(config) {
  const method = (config.method || 'get').toLowerCase()
  const u = new URL(String(config.url || ''), 'http://cloud/api/')
  const path = (u.pathname.startsWith('/api') ? u.pathname.slice(4) : u.pathname) || '/'
  const query = { ...Object.fromEntries(u.searchParams), ...(config.params || {}) }
  let body = config.data
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch {} }
  const reply = (status, data) => ({ data, status, statusText: String(status), headers: {}, config, request: {} })
  try {
    const data = method === 'get' ? await get(path, query) : await change(method, path, body)
    if (config.responseType === 'blob' && !(data instanceof Blob)) throw httpError(503, 'This needs the PC.')
    return reply(200, data)
  } catch (e) {
    const err = e.response ? e : httpError(503, e.message)
    err.config = config
    err.response = { ...err.response, config, headers: {}, statusText: String(err.response.status) }
    throw err
  }
}

// ---------------------------------------------------------------- documents
// <img src="/api/files/12/download">, <a href="/api/files/12/download"> … → a
// short-lived link to the same file in online storage.
const signed = new Map()
async function signedUrl(fileId) {
  if (signed.has(fileId)) return signed.get(fileId)
  const p = (async () => {
    const rows = await rest('GET', `/rest/v1/keep_files?id=eq.${fileId}&select=object`)
    if (!rows?.[0]?.object) return null
    const c = cloudCreds()
    const s = await rest('POST', `/storage/v1/object/sign/keep/${rows[0].object}`, { expiresIn: 6 * 3600 })
    return s?.signedURL ? `${c.url}/storage/v1${s.signedURL.startsWith('/') ? '' : '/'}${s.signedURL}` : null
  })().catch(() => null)
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
