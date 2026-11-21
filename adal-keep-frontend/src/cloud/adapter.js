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
import { mirrorReady, mirrorHas, mirrorGet, mirrorAt, mirrorAge, mirrorPut, mirrorSync, mirrorFetch, mirrorPrune, mirrorTake, mirrorLoad } from './mirror.js'

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
// One sign-in at a time: the pages ask for many things at once, and as many
// sign-ins at once got this device refused for a while (Supabase limits them),
// which looked like being logged out. A line that drops or a busy Supabase is
// "no internet" (tried again), never "removed" — only a real refusal is.
let signingIn = null
async function token() {
  const c = cloudCreds()
  if (!c) throw httpError(401, 'This phone is not paired. Pair it on the office Wi-Fi first.')
  if (sess?.access_token && sess.expires_at > Date.now()) return sess.access_token
  if (!signingIn) signingIn = signIn(c).finally(() => { signingIn = null })
  return signingIn
}
async function signIn(c) {
  const ask = (path, body) => fetch(`${c.url}/auth/v1/token?grant_type=${path}`, { method: 'POST', headers: { apikey: c.anon, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: timeUp(25000) })
    .catch(() => { throw httpError(503, 'No internet') })
  let r = sess?.refresh_token ? await ask('refresh_token', { refresh_token: sess.refresh_token }) : null
  if (!r?.ok) r = await ask('password', { email: c.email, password: c.password })
  const d = await r.json().catch(() => ({}))
  if (r.status === 429 || r.status >= 500) throw httpError(503, 'The online copy is busy — trying again.')
  if (!r.ok || !d.access_token) throw httpError(401, 'This phone was removed from the agency, or cannot sign in online.')
  sess = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (Number(d.expires_in || 3600) - 60) * 1000 }
  // The agency this device belongs to now (its PC may have a new online account):
  // the saved one follows it, so a phone or Companion never stays on an empty copy.
  if (!window.__ADAL_CREDS && d.user?.id) {
    try {
      const q = await fetch(`${c.url}/rest/v1/keep_devices?user_id=eq.${d.user.id}&select=agency_id`, { headers: { apikey: c.anon, Authorization: `Bearer ${d.access_token}` } })
      const now = (await q.json().catch(() => []))?.[0]?.agency_id
      if (q.ok && now && now !== c.agency) {
        const saved = JSON.parse(localStorage.getItem(SAVED) || 'null')
        if (saved?.cloud) { saved.cloud.agency = now; localStorage.setItem(SAVED, JSON.stringify(saved)); setTimeout(() => location.reload(), 50) }
      }
    } catch {}
  }
  return sess.access_token
}

export const getToken = () => token()

/**
 * This device suspended by the main PC (Settings → Connected devices): its own
 * keep_devices row says revoked (a device always sees its own row). Checked
 * every 20 s; then the pages give way to the "suspended" screen (App.jsx).
 */
export async function deviceSuspended() {
  const c = cloudCreds()
  if (!c?.device || window.__ADAL_CREDS) return false
  try {
    const r = await fetch(`${c.url}/rest/v1/keep_devices?user_id=eq.${c.device}&select=revoked`, { headers: { apikey: c.anon, Authorization: `Bearer ${await token()}` } })
    return r.ok && (await r.json().catch(() => []))?.[0]?.revoked === true
  } catch { return false }
}
export function watchSuspended() {
  const look = async () => { if (await deviceSuspended()) window.dispatchEvent(new Event('adal-suspended')) }
  look.__always = true
  setTimeout(look, 1500)
  setInterval(look, 20000)
}

/** A short-lived link to a file Adal published (adal-updates: the phone app). */
export async function updateLink(file) {
  const c = cloudCreds()
  const r = await rest('POST', `/storage/v1/object/sign/adal-updates/${file}`, { expiresIn: 900 })
  if (!r?.signedURL) throw new Error('no link')
  return `${c.url}/storage/v1${r.signedURL}`
}

export async function gunzipJSON(b64) {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  return JSON.parse(text)
}

const timeUp = (ms) => { try { return AbortSignal.timeout(ms) } catch { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal } }
/** A promise that gives up after ms (null instead of waiting for ever). */
export const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])

async function rest(method, p, body, headers = {}, again = false) {
  const c = cloudCreds()
  const r = await fetch(`${c.url}${p}`, {
    method,
    headers: { apikey: c.anon, Authorization: `Bearer ${await token()}`, ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    // A bad line never leaves a page waiting for ever.
    signal: timeUp(body instanceof Blob ? 180000 : 25000),
  }).catch(e => { throw httpError(503, /abort|timeout/i.test(e?.name + e?.message) ? 'The internet is too slow right now — try again.' : 'No internet') })
  // Its sign-in ran out early (the PC slept, its clock moved): signed in afresh and asked once more.
  if (r.status === 401 && !again && !(body instanceof Blob)) { sess = sess && { ...sess, expires_at: 0 }; return rest(method, p, body, headers, true) }
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

// Checklist changes made on this phone (PC off): shown at once, and kept on
// top of the online copy until the PC has carried them out (the copy is newer).
const LISTS = 'adal-cloud-pending-lists' + SUFFIX
let listOps = []
try { listOps = JSON.parse(localStorage.getItem(LISTS) || '[]') } catch {}
const saveListOps = () => { try { localStorage.setItem(LISTS, JSON.stringify(listOps)) } catch {} }
function applyListOps(lists, updatedAt) {
  if (!Array.isArray(lists)) return lists
  if (updatedAt) { const n = listOps.length; listOps = listOps.filter(o => new Date(o.at) >= new Date(updatedAt)); if (listOps.length !== n) saveListOps() }
  if (!listOps.length) return lists
  const people = new Map((mirrorGet('/profiles') || []).map(p => [Number(p.id), p]))
  let out = lists.map(c => ({ ...c, profiles: [...(c.profiles || [])], cells: [...(c.cells || [])] }))
  for (const o of listOps) {
    const c = out.find(x => Number(x.id) === Number(o.list))
    if (o.op === 'new') { if (!c) out = [{ id: o.list, name: o.name, columns: null, cells: [], profiles: [], created_at: o.at, queued: true }, ...out]; continue }
    if (o.op === 'delete') { out = out.filter(x => Number(x.id) !== Number(o.list)); continue }
    if (!c) continue
    if (o.op === 'add') for (const id of o.ids) { if (!c.profiles.some(p => Number(p.id) === Number(id)) && people.has(Number(id))) c.profiles.push(people.get(Number(id))) }
    if (o.op === 'remove') c.profiles = c.profiles.filter(p => Number(p.id) !== Number(o.id))
    if (o.op === 'cell') { c.cells = c.cells.filter(x => !(Number(x.profile_id) === Number(o.profile) && x.column === o.column)); if (o.value) c.cells.push({ profile_id: o.profile, column: o.column, value: o.value }) }
    if (o.op === 'columns') c.columns = o.columns
  }
  return out
}
/** A checklist change of this phone, as an op to show until the PC has it. */
function listOpOf(method, path, body) {
  const at = new Date().toISOString()
  let m
  if (method === 'post' && path === '/checklists' && body?.name) return { op: 'new', list: -Date.now(), name: String(body.name).trim(), at }
  if (method === 'delete' && (m = path.match(/^\/checklists\/(-?\d+)$/))) return { op: 'delete', list: Number(m[1]), at }
  if (method === 'post' && (m = path.match(/^\/checklists\/(-?\d+)\/profiles$/))) return { op: 'add', list: Number(m[1]), ids: (body?.profile_ids || []).map(Number), at }
  if (method === 'delete' && (m = path.match(/^\/checklists\/(-?\d+)\/profiles\/(\d+)$/))) return { op: 'remove', list: Number(m[1]), id: Number(m[2]), at }
  if (method === 'put' && (m = path.match(/^\/checklists\/(-?\d+)\/cells$/))) return { op: 'cell', list: Number(m[1]), profile: Number(body?.profile_id), column: body?.column, value: body?.value || '', at }
  if (['put', 'patch'].includes(method) && (m = path.match(/^\/checklists\/(-?\d+)$/)) && Array.isArray(body?.columns)) return { op: 'columns', list: Number(m[1]), columns: body.columns, at }
  return null
}

// ---------------------------------------------------------------- made here
// Asked on 2026-11-15: with the PC off a phone makes a profile, adds her
// documents and opens her CV at once — in a move's order: her text first
// (the profile is there at once, with its own number below 0), then each
// document. The PC does the same when it is on (keep_changes, in order) and
// says the profile's real number ("/phone-refs"); her documents show here
// from the phone itself until the PC's copy has them.
const NEWP = 'adal-cloud-new-profiles' + SUFFIX     // [{ ref, body, at }]
const PFILES = 'adal-cloud-pending-files' + SUFFIX  // [{ pid, fid, name, file, replace, at }]
const NOTES = 'adal-cloud-pending-notes' + SUFFIX   // [{ all } | { id }, at]
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d } catch { return d } }
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
let newProfiles = load(NEWP, []), pendingFiles = load(PFILES, []), noteOps = load(NOTES, [])

/** The real number of a profile made on this phone, once the PC made it. */
export const realId = (id) => {
  if (Number(id) >= 0) return Number(id)
  const r = (mirrorGet('/phone-refs') || {})[String(id)]
  return r ? Number(r) : null
}
const isNew = (id) => Number(id) < 0
/** A path with a profile made here: its real number (null: the PC has not made her yet). */
function realPathOf(path) {
  const m = path.match(/^\/profiles\/(-\d+)(\/.*)?$/)
  if (!m) return path
  const r = realId(m[1])
  return r ? `/profiles/${r}${m[2] || ''}` : null
}
const madeHere = (id) => newProfiles.find(n => String(n.ref) === String(id))

// The fields every profile has (from any profile on the phone), empty: a new profile's documents.
async function blankFields() {
  const p = mirrorGet('/profiles')
  for (const r of (Array.isArray(p) ? p : []).slice(0, 30)) {
    const k = `/profiles/${r.id}/fields`
    await mirrorLoad(k)
    const f = mirrorGet(k)
    if (Array.isArray(f) && f.length) return f.map((x, i) => ({ id: -(i + 1), name: x.name, data_type: x.data_type, is_permanent: x.is_permanent, field_template_id: x.field_template_id, files: [] }))
  }
  return ['Photo', 'Full Body Photo', 'Passport', 'Self Video'].map((name, i) => ({ id: -(i + 1), name, data_type: 'file', is_permanent: true, files: [] }))
}

/** Her documents added on this phone, on top of the copy (until the copy is newer). */
function withFiles(pid, fields, updatedAt) {
  if (!Array.isArray(fields)) return fields
  const n = pendingFiles.length
  // Gone from here once the PC's copy has the same file (its size) in that field — or,
  // newer than it by 15 minutes and still without it, it was not filed (the copy is right).
  const filed = (f) => fields.some(fl => fl.name === f.name && (fl.files || []).some(x => Number(x.size) === Number(f.file.size)))
  pendingFiles = pendingFiles.filter(f => !(updatedAt && new Date(updatedAt) > new Date(f.at) && (Number(f.pid) === Number(pid) || realId(f.pid) === Number(pid))
    && (filed(f) || new Date(updatedAt) - new Date(f.at) > 15 * 60000)))
  if (pendingFiles.length !== n) save(PFILES, pendingFiles)
  const mine = pendingFiles.filter(f => Number(f.pid) === Number(pid) || realId(f.pid) === Number(pid))
  if (!mine.length) return fields
  return fields.map(fl => {
    const add = mine.filter(f => f.name === fl.name)
    if (!add.length) return fl
    const replace = add.some(f => f.replace)
    return { ...fl, files: [...add.map(f => f.file).reverse(), ...(replace ? [] : (fl.files || []))] }
  })
}

/** What the CV page needs to know of her (the PC's /cv/profile-readiness, made here). */
function readinessOf(profile, fields) {
  const count = (name) => (fields || []).filter(f => f.name === name).reduce((n, f) => n + (f.files || []).length, 0)
  const required = ['full_name','first_name','last_name','passport_number','date_of_birth','place_of_birth','nationality','gender','religion','marital_status','children_count','weight','height','phone_number']  // living town: not asked (the CV uses her place of birth)
  const has_photo = count('Photo') > 0 || !!profile.photo_path
  const has_full_body_photo = count('Full Body Photo') > 0
  const cv_blockers = [!profile.broker_id && 'Broker not assigned', !has_photo && 'Photo missing', !has_full_body_photo && 'Full body photo missing', !profile.religion && 'Religion missing', !profile.marital_status && 'Marital status missing'].filter(Boolean)
  const field_file_counts = {}
  for (const f of fields || []) field_file_counts[f.name] = (field_file_counts[f.name] || 0) + (f.files || []).length
  return {
    profile, missing: required.filter(k => profile[k] == null || profile[k] === ''), has_photo, has_full_body_photo, field_file_counts,
    missing_photos: [!has_photo && 'Photo', !has_full_body_photo && 'Full Body Photo'].filter(Boolean), cv_blockers, can_generate: !cv_blockers.length,
  }
}

function newProfileView(n) {
  const brokers = mirrorGet('/brokers') || []
  const b = Array.isArray(brokers) ? brokers.find(x => String(x.id) === String(n.body.broker_id)) : null
  return { status: 'pending', created_by: 'phone', ...n.body, id: n.ref, broker_name: b?.name || null, created_at: n.at, updated_at: n.at, queued: true }
}

// This phone's edits stay visible until the online copy is newer than them.
function withPending(key, data, updatedAt) {
  if (key === '/checklists') return applyListOps(data, updatedAt)
  if (key === '/notifications' && Array.isArray(data)) {
    const n = noteOps.length
    noteOps = noteOps.filter(o => !(updatedAt && new Date(updatedAt) > new Date(o.at)))
    if (noteOps.length !== n) save(NOTES, noteOps)
    return data.filter(r => !noteOps.some(o => (o.all && new Date(r.created_at || 0) <= new Date(o.at)) || String(o.id) === String(r.id)))
  }
  const fieldsOf = key.match(/^\/profiles\/(\d+)\/fields$/)
  if (fieldsOf) return withFiles(fieldsOf[1], data, updatedAt)
  if (key === '/profiles' && Array.isArray(data) && newProfiles.length) {
    // Made on this phone: on top of the list until the PC's list has her.
    const have = new Set(data.map(r => Number(r.id)))
    const n = newProfiles.length
    newProfiles = newProfiles.filter(x => !(realId(x.ref) && have.has(realId(x.ref))) && Date.now() - new Date(x.at).getTime() < 30 * 86400000)
    if (newProfiles.length !== n) save(NEWP, newProfiles)
    data = [...newProfiles.map(newProfileView).reverse(), ...data]
  }
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
  await mirrorLoad(key)   // (one profile's answer is read from the phone's database when asked)
  if (mirrorHas(key) && mirrorGet(key) !== undefined) return withPending(key, mirrorGet(key), mirrorAt(key))
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
  // A profile made on this phone: her real one once the PC made it, else what the phone has.
  if (/^\/profiles\/-\d+/.test(path)) {
    const real = realPathOf(path)
    if (real) return get(real, query)
    const [, ref, rest = ''] = path.match(/^\/profiles\/(-\d+)(\/.*)?$/)
    const n = madeHere(ref)
    if (!n) throw httpError(404, 'Profile not found')
    if (!rest) return newProfileView(n)
    if (rest === '/fields') return withFiles(ref, await blankFields(), null)
    const files = rest.match(/^\/fields\/(-?\d+)\/files$/)
    if (files) return withFiles(ref, await blankFields(), null).find(f => String(f.id) === files[1])?.files || []
    if (rest === '/days') return { days: [] }
    if (/^\/(automations|whatsapp|notes)$/.test(rest)) return []
    throw httpError(503, 'Made on this phone — the PC adds this when it is on.')
  }
  if (query?.profile_id && isNew(query.profile_id)) {
    const r = realId(query.profile_id)
    if (r) return get(path, { ...query, profile_id: r })
    if (path === '/cv/generated') return []
  }
  const ready = path.match(/^\/cv\/profile-readiness\/(-?\d+)$/)
  if (ready) {
    const id = realId(ready[1]) ?? ready[1]
    const profile = await get(`/profiles/${id}`, {})
    const fields = await get(`/profiles/${id}/fields`, {}).catch(() => [])
    return readinessOf(profile, fields)
  }
  // A document (or a made CV) as a file: from this phone's copy, else Telegram / online storage.
  const doc = path.match(/^\/files\/(-?\d+)\/(download|thumbnail|view)$/)
  if (doc) { const b = await fileBlob(doc[1]); if (b) return b; throw httpError(404, 'This document is not online yet.') }
  const made = path.match(/^\/cv\/generated\/(\d+)\/(download|view)$/)
  if (made) {
    const row = ((await answer('/cv/generated')) || []).find(c => String(c.id) === made[1])
    const fields = row ? (await answer(`/profiles/${row.profile_id}/fields`)) || [] : []
    const f = fields.flatMap(x => x.files || []).find(x => x.path === row?.pdf_path || String(x.path || '').endsWith(String(row?.pdf_path || '-')))
    const b = f ? await fileBlob(f.id) : null
    if (b) return b
    throw httpError(404, 'This CV is not online yet.')
  }
  if (path === '/auth/me') throw httpError(401, 'Not signed in')
  if (path === '/mobile/ping' || path === '/tasks/calls') return path === '/tasks/calls' ? [] : { ok: true, cloud: true }
  // The dashboard's counts from the phone's own list of profiles: never older than the list.
  if (path === '/dashboard') {
    const d = (await answer('/dashboard')) || {}
    const all = await answer('/profiles')
    if (!Array.isArray(all)) return d
    const statusCounts = {}
    for (const p of all) statusCounts[p.status || 'pending'] = (statusCounts[p.status || 'pending'] || 0) + 1
    return { ...d, totalProfiles: all.length, statusCounts: { ...(d.statusCounts || {}), ...statusCounts } }
  }
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
  // A checklist's girls and their documents, from the list and each one's fields.
  const live = path.match(/^\/checklists\/(-?\d+)\/live$/)
  if (live) {
    const me = ((await answer('/checklists')) || []).find(c => String(c.id) === live[1])
    const profiles = me?.profiles || []
    const fields = {}
    for (const p of profiles) fields[p.id] = (await answer(`/profiles/${p.id}/fields`)) || []
    return { profiles, fields }
  }
  // (The PC's "needs you" list is online for the phone's background notifications;
  // with the PC off nothing is calling now, whatever the last copy says.)
  if (path === '/automations/attention') return []
  const data = await answer(path)
  // Live lists the PC makes as things happen: with the PC off, nothing waits on a person.
  if (data === undefined && /^\/(automations\/attention|whatsapp\/(bulk|notify)|sessions|tasheer\/session|system\/update\/notice|musaned\/authenticators|musaned\/epro-signature|wafid\/check|mobile\/cloud|profiles\/\d+\/whatsapp)$/.test(path)) {
    if (path === '/system/update/notice') return { hasUpdate: false, count: 0, changes: [] }
    // (The authenticator codes stay on the PC: secrets never go to the online copy.)
    if (/^\/(musaned\/epro-signature|wafid\/check|mobile\/cloud)$/.test(path)) return { phone: true }
    return path === '/whatsapp/bulk' || path === '/whatsapp/notify' ? { running: false } : []
  }
  // What runs are doing (only the PC knows): with the PC off, none — at once, no error.
  if (data === undefined && /^\/(automations\/(active|ready-for-submit)|tasks\/reading)$/.test(path)) return []
  if (data === undefined && path === '/automations/stages') return {}
  // (A PC that does not copy it yet: the order is in its settings too.)
  if (data === undefined && path === '/settings/journey-order') {
    let order = []
    try { order = JSON.parse((await answer('/settings'))?.journey_order || '[]') } catch {}
    return { order: Array.isArray(order) ? order : [] }
  }
  if (data === undefined) throw httpError(503, 'This needs the PC — it is not in the online copy.')
  return data
}

// ---------------------------------------------------------------- changes
// (A CV preview is drawn by the PC: with it off the page says so, nothing waits in line.)
const NEEDS_PC = /^\/(chat|system|backup|branch|main-pc|mobile|subscription|setup|cv\/preview|automations\/\d+\/(input|screen))/
// (A profile opened on the phone: only the PC's list order — never queued for later.)
const QUIET = /^\/(tutor|employees\/device-(login|resume|logout)|chat\/ping|profiles\/-?\d+\/opened$)/

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
  // A profile given to a broker (or taken off): her broker changes at once.
  if (method === 'post' && /^\/brokers\/(un)?assign$/.test(path) && Number(body?.profileId) > 0) {
    const pid = String(Number(body.profileId))
    return optimistic('put', `/profiles/${pid}`, { broker_id: path.endsWith('/unassign') ? null : Number(body.brokerId) || null })
  }
  const one = path.match(/^\/profiles\/(\d+)$/)
  if (one && ['put', 'patch'].includes(method) && body && typeof body === 'object') {
    pending[one[1]] = { body: { ...(pending[one[1]]?.body || {}), ...body }, at: new Date().toISOString() }
    savePending()
    if (cache[path]) remember(path, { ...cache[path], ...body })
    if (Array.isArray(cache['/profiles'])) remember('/profiles', cache['/profiles'].map(p => String(p.id) === one[1] ? { ...p, ...body } : p))
    return { ...(cache[path] || {}), ...body, success: true, queued: true }
  }
  // A profile deleted: off this phone's list at once (the PC moves her to the Trash).
  const gone = method === 'delete' && path.match(/^\/profiles\/(-?\d+)$/)?.[1]
  if (gone) {
    if (Array.isArray(cache['/profiles'])) remember('/profiles', cache['/profiles'].filter(p => String(p.id) !== gone))
    if (Number(gone) < 0) { newProfiles = newProfiles.filter(n => String(n.ref) !== gone); save(NEWP, newProfiles) }
    return { ok: true, success: true, queued: true }
  }
  // A new broker shows on the phone at once (the PC gives it its number when it is on).
  if (method === 'post' && path === '/brokers' && body && typeof body === 'object') {
    const b = { id: -Date.now(), ...body, created_at: new Date().toISOString(), queued: true }
    remember('/brokers', [...(Array.isArray(cache['/brokers']) ? cache['/brokers'] : []), b])
    return { ...b, success: true }
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

/** Her CV page drawn on this phone (lib/cvLocal.js), from what the phone has. */
async function cvHere(body) {
  const { cvHtml } = await import('../lib/cvLocal.js')
  const pid = realId(body?.profile_id) ?? body?.profile_id
  return cvHtml({
    profile: (id) => get(`/profiles/${id}`, {}),
    fields: (id) => get(`/profiles/${id}/fields`, {}).catch(() => []),
    template: async (id) => (await answer(`/cv/templates/${id}`)) || ((await answer('/cv/templates')) || []).find(t => String(t.id) === String(id)),
    banners: async (id) => (await answer(`/cv/templates/${id}/banners`).catch(() => null)) || null,
    broker: async (id) => (await answer(`/brokers/${id}`).catch(() => null)) || ((await answer('/brokers')) || []).find(b => String(b.id) === String(id)),
    blob: (id) => fileBlob(id),
  }, pid, body?.template_id, body?.overrides || {})
}

async function change(method, path, body) {
  // The CV with the PC off: drawn here; made into a PDF by the phone itself.
  if (method === 'post' && path === '/cv/preview') return cvHere(body)
  if (method === 'post' && path === '/cv/generate') {
    const profile = await get(`/profiles/${realId(body?.profile_id) ?? body?.profile_id}`, {})
    if (!String(profile?.religion || body?.overrides?.religion || '').trim()) throw httpError(400, `Religion is missing for ${profile?.full_name || 'her'}: fill it in on the profile, then make the CV.`)
    const html = await cvHere(body)
    // The PC makes and files the same CV when it is on (it then shows under CVs).
    await request('api', { method: 'POST', path, body: body ?? null }, Number(body?.profile_id) || null).catch(() => {})
    const tpl = ((await answer('/cv/templates')) || []).find(t => String(t.id) === String(body?.template_id))
    const name = `${String(profile?.full_name || 'CV').replace(/[\\/:*?"<>|]+/g, ' ').trim()}${tpl?.name ? ' - ' + tpl.name : ''}.pdf`
    return { ok: true, queued: true, local_html: html, filename: name }
  }
  // Notifications removed here are gone from this phone at once.
  if (method === 'delete' && /^\/notifications\/(all|\d+)$/.test(path)) {
    const which = path.split('/').pop()
    noteOps.push(which === 'all' ? { all: true, at: new Date().toISOString() } : { id: which, at: new Date().toISOString() }); save(NOTES, noteOps)
  }
  // A new profile: there at once, with this phone's own number until the PC makes her.
  const makes = method === 'post' && (path === '/profiles' || path === '/new-profile/with-passport')
  if (makes) {
    // Her number on this phone: the same one the PC was asked with (made once only).
    const ref = Number(body instanceof FormData ? body.get('phone_ref') : body?.phone_ref) || -Date.now()
    let fields = body
    if (body instanceof FormData) {
      try { fields = JSON.parse(body.get('profile') || '{}') } catch { fields = {} }
      body.set('phone_ref', String(ref))
      const file = body.get('file')
      if (file instanceof Blob) await keepHere(ref, -1, 'Passport', file, true)
      await request('upload', { path, ...(await uploadParts(body)) }, null)
    } else {
      await request('api', { method: 'POST', path, body: { ...(body || {}), phone_ref: ref } }, null)
    }
    newProfiles.push({ ref, body: fields || {}, at: new Date().toISOString() }); save(NEWP, newProfiles)
    try { window.dispatchEvent(new CustomEvent('adal-data-change', { detail: { paths: ['/profiles'] } })) } catch {}
    return { ...newProfileView(madeHere(ref)), success: true, message: 'Saved on this phone — the PC adds her when it is on.' }
  }
  // Her details changed before the PC made her: kept with her.
  const one = path.match(/^\/profiles\/(-\d+)$/)
  if (one && ['put', 'patch'].includes(method) && madeHere(one[1]) && body && typeof body === 'object') {
    const n = madeHere(one[1]); n.body = { ...n.body, ...body }; save(NEWP, newProfiles)
  }
  // Check for updates / Install in an Adal Keep Companion's window: this PC updates
  // itself (adal-companion /update/check and /update/apply), not the main PC.
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && path === '/system/update/check' && method === 'get') {
    const r = await fetch('http://127.0.0.1:47810/update/check', { signal: AbortSignal.timeout(20000) }).then(x => x.json()).catch(() => null)
    if (!r) throw httpError(503, 'The Adal Keep Companion on this PC did not answer — open Adal Keep again.')
    if (r.error) throw httpError(503, r.error)
    return { ...r, installed: { short: r.current }, latest: { short: r.latest } }
  }
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && path === '/system/update/apply' && method === 'post') {
    const r = await fetch('http://127.0.0.1:47810/update/apply', { method: 'POST', signal: AbortSignal.timeout(15 * 60000) }).then(x => x.json()).catch(() => null)
    if (!r) throw httpError(503, 'The Adal Keep Companion on this PC did not answer — open Adal Keep again.')
    if (!r.ok) throw httpError(503, r.error || 'The update did not install.')
    return { message: r.message }
  }
  // "Back up now" with the PC off: kept online once; the PC backs up as soon as it is on
  // (and it backs up by itself every 2 hours anyway). Never a second request waiting.
  if (method === 'post' && path === '/backup/run') {
    // In an Adal Keep Companion's window (2026-11-19): the locked copy kept on
    // this PC goes to the agency's Telegram now (adal-companion /backup/now).
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
      const here = await fetch('http://127.0.0.1:47810/backup/now', { method: 'POST', signal: AbortSignal.timeout(4000) })
        .then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (here?.started || here?.done) return { queued: !here.done, message: here.message }
    }
    const c = cloudCreds()
    const waiting = await rest('GET', `/rest/v1/keep_changes?agency_id=eq.${c.agency}&applied_at=is.null&kind=eq.api&payload->>path=eq./backup/run&select=id&limit=1`).catch(() => [])
    if (!waiting?.length) await request('api', { method: 'POST', path: '/backup/run', body: null }, null)
    return { queued: true, message: 'The PC is off: it backs up as soon as it is on (Telegram, or the online storage).' }
  }
  if (NEEDS_PC.test(path)) throw httpError(503, 'This needs the PC (it is off or far away). It works again when the phone reaches the PC.')
  const lop = listOpOf(method, path, body)
  if (lop) {
    // A checklist made on this phone has its own number (below 0) until the PC
    // makes it: the PC puts the real number in its place (backend cloudSync.js).
    const sent = lop.op === 'new' ? { ...body, phone_ref: lop.list } : body
    await request('api', { method: method.toUpperCase(), path, body: sent ?? null }, null)
    listOps.push(lop); saveListOps()
    if (lop.op === 'new') return { id: lop.list, name: lop.name, queued: true, success: true }
    return { ok: true, success: true, queued: true }
  }
  if (QUIET.test(path)) return { ok: true }
  const pid = Number(path.match(/^\/profiles\/(\d+)/)?.[1]) || null
  if (body instanceof FormData) {
    // Her document shows on this phone at once (the PC files it when it is on).
    const fieldUp = path.match(/^\/profiles\/(-?\d+)\/fields\/(-?\d+)\/(upload|files)$/)
    let field_name, kept = []
    if (fieldUp) {
      const fields = await get(`/profiles/${fieldUp[1]}/fields`, {}).catch(() => [])
      field_name = (fields || []).find(f => String(f.id) === fieldUp[2])?.name
      const blobs = [...body.entries()].filter(([, v]) => v instanceof Blob).map(([, v]) => v)
      for (const [i, b] of blobs.entries()) kept.push(await keepHere(fieldUp[1], fieldUp[2], field_name, b, fieldUp[3] === 'upload' && i === 0))
    }
    await request('upload', { path, ...(field_name ? { field_name } : {}), ...(await uploadParts(body)) }, pid > 0 ? pid : null)
    return { ok: true, success: true, queued: true, files: kept, message: 'Saved on this phone — the PC files it when it is on.' }
  }
  await request('api', { method: method.toUpperCase(), path, body: body ?? null }, pid)
  return optimistic(method, path, body)
}

// ---------------------------------------------------------------- relay
// The PC is on (it says so every 15 s): the phone's calls go to the PC itself
// through keep_calls and come back in a second or two — live tabs, captchas,
// chat, everything. Off: the online copy above.
let alive = { at: 0, on: false }
// The PC's office addresses (it sends them every 15 s): an Adal Companion opens
// the PC directly from one of them (lib/companionDirect.js).
export async function pcAddresses() {
  try {
    const d = (await rest('GET', '/rest/v1/keep_meta?key=eq./_pc&select=data'))?.[0]?.data
    if (d && Date.now() - new Date(d.at).getTime() < 45000 && Array.isArray(d.lan)) return { list: d.lan, port: Number(d.port) || 4000 }
  } catch {}
  return { list: [], port: 4000 }
}
export async function pcOnline() {
  // For trying a phone as if the office PC were off (support, tests).
  try { if (localStorage.getItem('adal-pretend-pc-off') === '1') return false } catch {}
  if (pcLive()) return true
  if (Date.now() - alive.at < 10000) return alive.on
  let on = false
  try {
    const rows = await rest('GET', '/rest/v1/keep_meta?key=eq./_pc&select=data')
    on = !!rows?.[0] && Date.now() - new Date(rows[0].data.at).getTime() < 45000  } catch {}
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
  startLanCompanion()   // an Adal Companion: the main PC over the office network
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
  let path = (u.pathname.startsWith('/api') ? u.pathname.slice(4) : u.pathname) || '/'
  const query = { ...Object.fromEntries(u.searchParams), ...(config.params || {}) }
  let body = config.data
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch {} }
  // A profile made on this phone: once the PC made her, her real number; until
  // then everything about her stays on this phone (and waits for the PC in order).
  let onlyHere = false
  if (/^\/profiles\/-\d+/.test(path)) { const r = realPathOf(path); if (r) path = r; else onlyHere = true }
  else if (/\/-\d+(\/|$)/.test(path)) {
    // Any other page about her (/cv/profile-readiness/-123 …): the same.
    const m = path.match(/\/(-\d+)(?=\/|$)/); const r = realId(m[1])
    if (r) path = path.replace(m[0], `/${r}`); else onlyHere = true
  }
  if (body && typeof body === 'object' && !(body instanceof FormData) && isNew(body.profile_id)) {
    const r = realId(body.profile_id); if (r) body = { ...body, profile_id: r }; else onlyHere = true
  }
  if (isNew(query.profile_id)) { const r = realId(query.profile_id); if (r) query.profile_id = r; else onlyHere = true }
  const reply = (status, data, headers = {}) => ({ data, status, statusText: String(status), headers, config, request: {} })
  try {
    // An Adal Companion: the main PC over the office network first (fast, not
    // through the internet); a document waits here while the main PC is away.
    if (ON_COMPANION && !onlyHere && !config.__noLan) {
      const r = await viaLan(method, path, query, body, config)
      if (r) return reply(r.status, r.data, r.headers)
      const fieldUp = method === 'post' && body instanceof FormData && [...body.values()].some(v => v instanceof Blob) && path.match(/^\/profiles\/(\d+)\/fields\/(\d+)\/(upload|files)$/)
      if (fieldUp) return reply(200, await queueForMain(path, body, fieldUp))
      // Her details, fields, notes, tasks …: kept here and shown at once, sent to
      // the main PC when it answers — never waiting on the internet.
      if (method !== 'get' && !(body instanceof FormData) && LAN_QUEUEABLE.test(path)) {
        queueJsonForMain(method, path, query, body)
        dropTasks(method, path, body)
        return reply(200, optimistic(method, path, body))
      }
    }
    // Fast: pages read the phone's own copy at once; with the PC live, an
    // answer older than a minute is asked for behind it (the next look is newer).
    if (method === 'get' && config.responseType !== 'blob' && !LIVE_FIRST.test(path)) {
      const key = baseKey(path, query)
      const c = cloudCreds()
      if (key && !isDirty(key)) {
        await mirrorReady(c.agency)
        await mirrorLoad(key)
        if (mirrorHas(key) && mirrorGet(key) !== undefined) {
          if (key === path && pcLive() && mirrorAge(key) > 60000) revalidate(key)
          return reply(200, await get(path, query))
        }
      }
    }
    // The Musaned codes: made right here from the agency's locked vault (no
    // call to the PC every 2 s; works with the PC off). Keys not in the vault
    // yet (an older PC): asked of the PC as before.
    if (method === 'get' && path === '/musaned/authenticators') {
      const keys = await vaultSoon().then(v => v['/musaned-totp']).catch(() => null)
      if (keys && Object.keys(keys).length) { const { codesOf } = await import('../lib/totp.js'); return reply(200, await codesOf(keys)) }
    }
    // A CV is drawn on this phone at once, from its own copy (no wait for the PC,
    // never made twice); the PC files the same CV when it hears of it. Only when
    // the phone cannot draw it (a template it does not have yet) the PC is asked.
    if (method === 'post' && /^\/cv\/(preview|generate)$/.test(path) && window.Capacitor?.Plugins?.AdalDiscovery?.htmlToPdf) {
      const here = await within(change(method, path, body).catch(e => { if (e.response?.status === 400) throw e; console.warn('[cv] not drawn here:', e.message); return null }), 25000)
      if (here) return reply(200, here)
    }
    if (method !== 'get') { markDirty(path); dropTasks(method, path, body) }
    // A new profile gets this phone's number for her before the PC is asked: if
    // the PC answers late and she is also kept for later, the PC makes her once.
    if (method === 'post' && (path === '/profiles' || path === '/new-profile/with-passport') && !onlyHere) {
      const ref = -Date.now()
      if (body instanceof FormData) { if (!body.get('phone_ref')) body.set('phone_ref', String(ref)) }
      else if (body && typeof body === 'object' && !body.phone_ref) body = { ...body, phone_ref: ref }
    }
    // A new profile with her passport can wait online when the PC does not answer
    // (the PC makes it when it is back; it never makes two).
    const canWait = method === 'post' && path === '/new-profile/with-passport'
    // A CV the PC cannot make (it has no such profile, or does not answer): drawn on
    // this phone from its own copy instead (asked on 2026-11-17: "Profile not found").
    // A profile deleted when the PC does not answer: gone from the phone at once,
    // and the PC moves her to its Trash when it is back (asked on 2026-11-17: "Delete failed").
    const soft = (method === 'post' && /^\/cv\/(preview|generate)$/.test(path)) || (method === 'delete' && /^\/profiles\/-?\d+$/.test(path))
    if (!onlyHere && await pcOnline()) {
      const qs = Object.keys(query).length ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : ''
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
        if (!m && method !== 'get' && !canWait && !soft) throw httpError(504, 'The PC did not answer in time — it may still do it. Look again in a moment.')
      }
      if (!a) {
        try { a = await relay(method, path + qs, method === 'get' ? undefined : sendBody, method === 'get' ? 12000 : sendBody?.__upload ? 90000 : 25000) }
        catch (e) { if (method !== 'get' && !canWait && !soft) throw e }
      }
      let r = null
      if (a) { try { r = relayed(a, config) } catch (e) { if (!soft) throw e; console.warn('[cv] the PC could not make it — drawn here:', e.message) } }
      if (r) {
        if (method === 'get' && !qs && r.status < 300 && !(r.data instanceof Blob) && /json/.test(r.headers['content-type'] || '') && !LIVE_FIRST.test(path)) remember(path, r.data)
        return reply(r.status, r.data, r.headers)
      }
      if (method !== 'get' && !canWait && !soft) throw httpError(504, 'The PC did not answer in time — it may still do it. Look again in a moment.')
      // A GET with no answer (or a new profile that waits): the online copy below.
    }
    // The chat with the PC off: straight to the chat server (cloud/chatDirect.js).
    if (path.startsWith('/chat')) {
      const { chatDirect } = await import('./chatDirect.js')
      const d = await chatDirect(method, path, query, body)
      if (d !== undefined) return reply(200, d)
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
export async function openVault({ fresh = false } = {}) {
  const c = cloudCreds()
  await mirrorReady(c.agency)
  let v = fresh ? null : mirrorGet('/vault')
  if (!v) { const rows = await rest('GET', '/rest/v1/keep_meta?key=eq./vault&select=data'); v = rows?.[0]?.data; if (v) remember('/vault', v) }
  const s = await cloudSecrets()
  if (!v?.v || !s?.file_key) return {}
  const plain = await openAK1(Uint8Array.from(atob(v.v), ch => ch.charCodeAt(0)), s.file_key)
  return JSON.parse(new TextDecoder().decode(plain))
}

// The vault opened at most once a minute (the Musaned codes ask every 2 s).
let vaultAt = 0, vaultP = null
function vaultSoon() {
  if (!vaultP || Date.now() - vaultAt > 60000) { vaultAt = Date.now(); vaultP = openVault().catch(() => { vaultAt = 0; return {} }) }
  return vaultP
}

/**
 * Bytes from an address. Telegram's file downloads do not allow pages to read
 * them (no CORS); inside the phone app its own (native) HTTP has no such rule.
 */
async function fetchBytes(url) {
  const H = window.Capacitor?.Plugins?.CapacitorHttp
  if (H && window.Capacitor?.isNativePlatform?.()) {
    const r = await H.request({ url, method: 'GET', responseType: 'arraybuffer', connectTimeout: 15000, readTimeout: 45000 })
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`)
    // Files come as base64; a JSON answer comes already read (an object).
    if (typeof r.data === 'string') return Uint8Array.from(atob(r.data), ch => ch.charCodeAt(0))
    if (r.data instanceof ArrayBuffer) return new Uint8Array(r.data)
    return new TextEncoder().encode(JSON.stringify(r.data))
  }
  // An employee PC's Adal Keep (adal-launcher/online.go) fetches Telegram's files for the page.
  const viaPC = location.port === '47801' && /^https:\/\/api\.telegram\.org\//.test(url)
  const r = await fetch(viaPC ? `/tg?u=${encodeURIComponent(url)}` : url, { signal: timeUp(60000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

/** A document kept in Telegram: download, decrypt here (AES-GCM) — the file itself. */
async function telegramFile(object, mimetype) {
  const s = await cloudSecrets()
  if (!s?.bot) return null
  const fileId = object.split(':')[1]
  const f = JSON.parse(new TextDecoder().decode(await fetchBytes(`https://api.telegram.org/bot${s.bot}/getFile?file_id=${encodeURIComponent(fileId)}`)))
  if (!f.ok) return null
  const buf = await fetchBytes(`https://api.telegram.org/file/bot${s.bot}/${f.result.file_path}`)
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

/** A document added on this phone with the PC off: kept here (own number below 0) and shown in her field. */
let lastHere = 0
async function keepHere(pid, fid, name, blob, replace) {
  lastHere = Math.min(lastHere - 1, -Date.now() * 10)
  const file = { id: lastHere, original_name: blob.name || `${name || 'document'}`, mimetype: blob.type || 'application/octet-stream', size: blob.size, path: '', queued: true }
  await keepFile(String(lastHere), blob)
  pendingFiles.push({ pid: Number(pid), fid: Number(fid), name, file, replace: !!replace, at: new Date().toISOString() }); save(PFILES, pendingFiles)
  return file
}

const signed = new Map()
async function signedUrl(fileId) {
  if (signed.has(fileId)) return signed.get(fileId)
  const p = (async () => {
    // On the phone already: no download at all.
    let blob = await cachedFile(fileId)
    // An Adal Companion: from the main PC over the office network (as on the main PC itself).
    if (!blob && ON_COMPANION && Number(fileId) > 0 && await lanUp()) {
      try {
        const r = await fetch(`/lan-api/files/${fileId}/download`, { headers: { 'X-Adal': '1' }, signal: timeUp(60000) })
        if (r.ok && r.headers.get('X-Adal-Via') === 'lan') blob = await r.blob()
      } catch {}
    }
    if (!blob) {
      const rows = await rest('GET', `/rest/v1/keep_files?id=eq.${fileId}&select=object,mimetype`)
      // Not online yet (just added: the PC sends documents to the online copy a
      // little later) — with the PC on, it is asked for the file itself, so a
      // picture taken a moment ago shows at once instead of a broken image.
      if (!rows?.[0]?.object) {
        blob = Number(fileId) > 0 ? await fromPC(fileId) : null
        if (blob) keepFile(fileId, blob)
        return blob ? URL.createObjectURL(blob) : null
      }
      if (rows[0].object.startsWith('tg:')) blob = await telegramFile(rows[0].object, rows[0].mimetype)
      else {
        const c = cloudCreds()
        const s = await rest('POST', `/storage/v1/object/sign/keep/${rows[0].object}`, { expiresIn: 6 * 3600 })
        if (!s?.signedURL) return null
        const r = await fetch(`${c.url}/storage/v1${s.signedURL.startsWith('/') ? '' : '/'}${s.signedURL}`, { signal: timeUp(60000) })
        if (!r.ok) return null
        blob = await r.blob()
        if (rows[0].mimetype && !blob.type) blob = new Blob([blob], { type: rows[0].mimetype })
      }
      if (!blob) return null
      keepFile(fileId, blob)
    }
    return URL.createObjectURL(blob)
  })().catch(() => null).then(u => { if (!u) signed.delete(fileId); return u })
  signed.set(fileId, p)
  return p
}

/** A document straight from the PC (it is on), through the live link or keep_calls; null when it does not answer. */
async function fromPC(fileId) {
  try {
    if (!(await pcOnline())) return null
    const path = `/files/${Number(fileId)}/download`
    const m = liveReady() ? await liveCall('get', path, undefined, 30000) : null
    const a = m ? (m.row ? (await rest('GET', `/rest/v1/keep_calls?id=eq.${m.row}&select=status,answer,answer_bin,answer_type,answer_head,answer_code`))?.[0] : { answer_code: m.code, answer_type: m.type, answer_head: m.head, answer_bin: m.bin, answer: m.data })
      : await relay('get', path, undefined, 30000)
    if (!a || a.answer_code >= 300) return null
    const d = relayed(a, { responseType: 'blob' }).data
    return d instanceof Blob && d.size ? d : null
  } catch { return null }
}

/** A document of Adal Keep as a Blob (from this phone's copy, else downloaded). */
export async function fileBlob(fileId) {
  const u = await signedUrl(String(fileId))
  if (!u) return null
  return (await fetch(u)).blob()
}

// A chat picture, file or voice note (/api/chat/file?path=…): fetched through
// the API (the PC, or straight from the chat server) and shown from memory.
const chatBlobs = new Map()
function fixChat(el, attr, v) {
  if (el.dataset.cloudFixed === v) return
  el.dataset.cloudFixed = v
  const u = new URL(v, location.origin)
  const p = chatBlobs.get(v) || import('../services/api.js').then(m => m.default.get(u.pathname.replace(/^\/api/, ''), { params: Object.fromEntries(u.searchParams), responseType: 'blob' }))
    .then(r => URL.createObjectURL(r.data)).catch(() => { chatBlobs.delete(v); return null })
  chatBlobs.set(v, p)
  p.then(url => { if (url && el.getAttribute(attr) === v) el.setAttribute(attr, url) })
}
function fixNode(el) {
  for (const attr of ['src', 'href']) {
    const v = el.getAttribute?.(attr)
    if (v && /^\/api\/chat\/(file|image)\?/.test(v)) { fixChat(el, attr, v); continue }
    const m = v && v.match(/^\/api\/files\/(-?\d+)\b/)
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
  const scan = (root) => { if (root.querySelectorAll) { fixNode(root); root.querySelectorAll('img[src^="/api/files/"], a[href^="/api/files/"], img[src^="/api/chat/"], a[href^="/api/chat/"], audio[src^="/api/chat/"], source[src^="/api/chat/"]').forEach(fixNode) } }
  scan(document.body)
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') fixNode(m.target)
      else m.addedNodes.forEach(scan)
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] })
}

// ---------------------------------------------------------------- office network
// An Adal Companion's own online pages (127.0.0.1:47801): whenever the main PC
// answers on the office network, every call, document and upload goes to it
// straight over the network — AdalKeep.exe /lan-api → adal-companion.exe
// (mainproxy.go) → the main PC, with this Companion's key — as fast as on the
// main PC, and nothing goes through the internet first (asked on 2026-11-19:
// "make the Companion really fast, like on Main; it will back up later").
// With the main PC out of reach, a document waits here and goes to the main PC
// when it is back; only after LAN_WAIT_MS without it, through the internet.
export const ON_COMPANION = typeof location !== 'undefined' && location.host === '127.0.0.1:47801'
const LAN_WAIT_MS = 30 * 60 * 1000
const LANQ = 'adal-lan-queue' + SUFFIX   // [{ id, path, parts: [[k, v] | [k, { blob, name, type }]], at, shown }]
const LANQ_CACHE = 'adal-lan-queue-v1'
let lan = { at: 0, ok: false, p: null }
let lanOkAt = 0
const lanDown = () => { lan = { at: Date.now(), ok: false, p: null } }

/** The main PC answers on the office network now (asked at most every few seconds). */
export async function lanUp(fresh = false) {
  if (!ON_COMPANION) return false
  if (!fresh && Date.now() - lan.at < (lan.ok ? 20000 : 6000)) return lan.ok
  if (!lan.p) {
    lan.p = fetch('/lan-api/health', { headers: { 'X-Adal': '1' }, cache: 'no-store', signal: timeUp(2500) })
      .then(r => r.ok && r.headers.get('X-Adal-Via') === 'lan').catch(() => false)
      .then(ok => { lan = { at: Date.now(), ok, p: null }; if (ok) lanOkAt = Date.now(); return ok })
  }
  return lan.p
}

/** One call to the main PC over the network; null when it cannot be reached that way. */
async function viaLan(method, path, query, body, config) {
  if (!(await lanUp())) return null
  const qs = Object.keys(query || {}).length ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : ''
  const headers = { 'X-Adal': '1' }
  let send
  if (method !== 'get' && method !== 'head' && body != null) {
    if (body instanceof FormData || body instanceof Blob) send = body
    else { send = JSON.stringify(body); headers['Content-Type'] = 'application/json' }
  }
  let r
  try {
    r = await fetch(`/lan-api${path}${qs}`, { method: method.toUpperCase(), headers, body: send, cache: 'no-store', signal: timeUp(send instanceof FormData ? 180000 : 30000) })
  } catch { lanDown(); return null }
  if (r.headers.get('X-Adal-Via') !== 'lan') { lanDown(); return null }
  lanOkAt = Date.now()
  const type = r.headers.get('content-type') || ''
  let data
  if (config?.responseType === 'blob') data = await r.blob()
  else if (/json/.test(type)) data = await r.json().catch(() => null)
  else if (/^text\//.test(type)) data = await r.text()
  else data = await r.blob()
  // This Companion is not let in on the main PC (yet): the online way, as before.
  if (r.status === 401 && data?.pc_access) { lanDown(); return null }
  const head = Object.fromEntries(r.headers.entries())
  if (r.status >= 400) {
    const e = httpError(r.status, data?.error || data?.message || `Error ${r.status}`)
    e.response = { status: r.status, data, headers: head }
    throw e
  }
  if (method !== 'get') markDirty(path)
  return { status: r.status, data, headers: head }
}

// The changes a Companion keeps for the main PC while it is out of reach (the rest go as before).
const LAN_QUEUEABLE = /^\/(profiles\/\d+(\/(fields|notes|days|journey)(\/[\w/-]*)?)?|brokers\/(un)?assign|tasks(\/[\w/-]*)?|notifications(\/[\w/-]*)?|checklists\/\d+\/cells)$/

function queueJsonForMain(method, path, query, body) {
  const qs = Object.keys(query || {}).length ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : ''
  lanQueue.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, json: true, method, path: path + qs, body: body ?? null, at: new Date().toISOString() })
  save(LANQ, lanQueue)
  setTimeout(() => flushLanQueue().catch(() => {}), 3000)
}

async function lanQueueCache() { return caches.open(LANQ_CACHE) }
const lanQueueReq = (id) => new Request(`https://lan-queue.adal.local/${id}`)
let lanQueue = load(LANQ, [])
let lanFlushing = false

/** A document for the main PC while it is out of reach: kept here, shown at once, sent when it is back. */
async function queueForMain(path, form, fieldUp) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const parts = [], shown = []
  let n = 0
  const c = await lanQueueCache()
  let fieldName
  try { fieldName = ((await get(`/profiles/${fieldUp[1]}/fields`, {}).catch(() => [])) || []).find(f => String(f.id) === fieldUp[2])?.name } catch {}
  for (const [k, v] of form.entries()) {
    if (v instanceof Blob) {
      const key = `${id}-${n++}`
      await c.put(lanQueueReq(key), new Response(v, { headers: { 'Content-Type': v.type || 'application/octet-stream' } }))
      parts.push([k, { blob: key, name: v.name || 'file', type: v.type || '' }])
      const kept = await keepHere(fieldUp[1], fieldUp[2], fieldName, v, fieldUp[3] === 'upload' && shown.length === 0)
      shown.push(kept)
    } else parts.push([k, String(v)])
  }
  lanQueue.push({ id, path, parts, at: new Date().toISOString(), shown: shown.map(f => f.id) })
  save(LANQ, lanQueue)
  return { ok: true, success: true, queued: true, files: shown, message: 'Kept on this PC — it goes to the main PC as soon as the main PC is reachable.' }
}

async function formOf(item) {
  const c = await lanQueueCache()
  const form = new FormData()
  for (const [k, v] of item.parts) {
    if (v && typeof v === 'object' && v.blob) {
      const hit = await c.match(lanQueueReq(v.blob))
      if (!hit) return null
      const b = await hit.blob()
      form.append(k, new File([b], v.name, { type: v.type || b.type }))
    } else form.append(k, v)
  }
  return form
}

async function dropQueued(item) {
  lanQueue = lanQueue.filter(x => x.id !== item.id); save(LANQ, lanQueue)
  if (item.json) return
  pendingFiles = pendingFiles.filter(f => !(item.shown || []).includes(f.file?.id)); save(PFILES, pendingFiles)
  try { const c = await lanQueueCache(); for (const [, v] of item.parts) if (v?.blob) await c.delete(lanQueueReq(v.blob)) } catch {}
}

/** The documents that waited: to the main PC when it answers; through the internet only after LAN_WAIT_MS without it. */
async function flushLanQueue() {
  if (lanFlushing || !lanQueue.length) return
  lanFlushing = true
  try {
    for (const item of [...lanQueue]) {
      const form = item.json ? item.body : await formOf(item)
      if (!item.json && !form) { await dropQueued(item); continue }
      if (await lanUp(true)) {
        try {
          const r = await viaLan(item.json ? item.method : 'post', item.path, {}, form, {})
          if (!r) break
        } catch (e) {
          // The main PC refused it (it will never take it): not tried for ever.
          if (!(e.response?.status >= 400 && e.response.status < 500)) break
          console.warn('[lan] the main PC refused a document that waited:', e.message)
        }
        await dropQueued(item)
        const pid = item.path.match(/^\/profiles\/(\d+)/)?.[1]
        try { window.dispatchEvent(new CustomEvent('adal-data-change', { detail: { paths: pid ? [`/profiles/${pid}`, `/profiles/${pid}/fields`] : ['/profiles'] } })) } catch {}
        continue
      }
      const away = Date.now() - Math.max(lanOkAt, new Date(item.at).getTime())
      if (away < LAN_WAIT_MS) break
      // Out of reach for a long time: through the internet after all (the main PC files it from there).
      await dropQueued(item)
      try { await cloudAdapter({ method: item.json ? item.method : 'post', url: `/api${item.path}`, data: form, __noLan: true }) } catch (e) { console.warn('[lan] online upload failed:', e.message) }
    }
  } finally { lanFlushing = false }
}

let lanStarted = false
export function startLanCompanion() {
  if (!ON_COMPANION || lanStarted) return
  lanStarted = true
  lanUp(true).then(() => flushLanQueue()).catch(() => {})
  setInterval(() => { flushLanQueue().catch(() => {}) }, 10000)
}
