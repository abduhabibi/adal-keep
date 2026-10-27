/**
 * cloudSync.js — the agency's online copy (Supabase), so its phones work
 * when the main PC is off (adal-admin/supabase/keep-sync.sql makes the tables).
 *
 * Every minute, on the main PC only:
 *   1. apply what phones asked while the PC was off (keep_changes): each one
 *      is a call to this PC's own API (or an upload), replayed as if the
 *      phone had made it here — same checks, same side effects;
 *   2. push the answers the pages read (the profile list, each profile, its
 *      documents list, runs, journey, tasks, brokers …) into keep_meta, keyed
 *      by the API path — only what changed since the last push;
 *   3. upload the documents themselves (bucket "keep", <agency>/<profile>/…),
 *      a few at a time, and list them in keep_files.
 * The phone app answers the same API paths from this copy (frontend
 * src/cloud/adapter.js). Secrets (passwords, tokens) never leave the PC.
 */
import crypto from 'crypto'
import { chatConfigured, cloudCall, cloudAuth, cloudAgencyId, cloudConfig } from './chatCloud.js'
import { isFollower } from './mainPC.js'

const PORT = () => Number(process.env.PORT) || 4000
const EVERY_MS = 60 * 1000
const FILES_PER_ROUND = 25
const MAX_FILE = 45 * 1024 * 1024

// The answers the pages read: once for the agency, and per profile.
const GLOBAL = ['/profiles', '/brokers', '/tasks', '/employees', '/settings', '/setup/status', '/subscription/status',
  '/automations/stages', '/automations/active', '/notifications', '/checklists', '/cv/templates', '/quick-links',
  '/dashboard', '/tasks/documents', '/wafid/settings', '/health', '/tutor/tour']
const PER_PROFILE = (id) => [`/profiles/${id}`, `/profiles/${id}/fields`, `/profiles/${id}/automations`,
  `/profiles/${id}/journey`, `/cv/profile-readiness/${id}`]
const SECRET = /pass|token|secret|otp|api[_-]?key|license|cookie/i

// Phone requests never replayed: they change the PC itself, not the agency's work.
const NOT_FROM_PHONES = /^\/(system|backup|branch|main-pc|mobile|subscription|setup|settings\/wallpaper|trash\/empty|trash\/\d+\/purge|chat)\b/

export const cloudStatus = { on: false, running: false, last: null, error: null, pushed: 0, files: 0, filesLeft: 0, applied: 0 }

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex')
const local = (method, p, { body, headers = {} } = {}) => fetch(`http://127.0.0.1:${PORT()}/api${p}`, {
  method,
  headers: { ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), 'X-Adal-Cloud': '1', ...headers },
  body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
})
const upsert = (db, table, rows, onConflict) => cloudCall(db, 'POST', `/rest/v1/${table}?on_conflict=${onConflict}`, rows,
  { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })

async function stateOf(db) {
  const rows = await db('cloud_sync').select('key', 'hash')
  return new Map(rows.map(r => [r.key, r.hash]))
}
async function setState(db, key, hash) {
  const at = new Date().toISOString()
  const n = await db('cloud_sync').where({ key }).update({ hash, at })
  if (!n) await db('cloud_sync').insert({ key, hash, at }).catch(() => {})
}

function clean(key, data) {
  if (key !== '/settings' || !data || typeof data !== 'object') return data
  return Object.fromEntries(Object.entries(data).filter(([k]) => !SECRET.test(k)))
}

// ------------------------------------------------------------ 1. requests
let applying = null
const applyChanges = (db, agency) => (applying ||= applyChangesNow(db, agency).finally(() => { applying = null }))
async function applyChangesNow(db, agency) {
  const list = await cloudCall(db, 'GET', `/rest/v1/keep_changes?agency_id=eq.${agency}&applied_at=is.null&order=id.asc&limit=50`)
  let names = null
  for (const c of list || []) {
    let result = ''
    try {
      names ||= new Map(((await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&select=user_id,name`)) || []).map(d => [d.user_id, d.name]))
      const who = { 'X-Adal-Who': encodeURIComponent(`${names.get(c.device_id) || 'Phone'} (phone)`) }
      const p = c.payload || {}
      if (!String(p.path || '').startsWith('/') || NOT_FROM_PHONES.test(p.path)) throw new Error('not allowed from a phone')
      let r
      if (c.kind === 'upload') {
        const form = new FormData()
        for (const [k, v] of Object.entries(p.form || {})) form.append(k, String(v))
        for (const f of p.files || []) {
          const res = await cloudCall(db, 'GET', `/storage/v1/object/keep/${f.object}`, undefined, { raw: true })
          if (!res.ok) throw new Error(`file ${f.name} not found online`)
          form.append(f.field || 'file', new Blob([Buffer.from(await res.arrayBuffer())], { type: f.mimetype || 'application/octet-stream' }), f.name || 'file')
        }
        r = await local('POST', p.path, { body: form, headers: who })
      } else {
        r = await local(String(p.method || 'POST').toUpperCase(), p.path, { body: p.body, headers: who })
      }
      result = `${r.status}${r.ok ? '' : ' ' + (await r.text()).slice(0, 200)}`
    } catch (e) {
      result = `error: ${e.message}`
    }
    await cloudCall(db, 'PATCH', `/rest/v1/keep_changes?id=eq.${c.id}`, { applied_at: new Date().toISOString(), result }, { headers: { Prefer: 'return=minimal' } })
    cloudStatus.applied++
    console.log(`[cloud] phone request #${c.id} ${c.kind} ${c.payload?.method || ''} ${c.payload?.path || ''} → ${result}`)
  }
  return (list || []).length
}

// ------------------------------------------------------------ 2. answers
async function pushAnswers(db, agency, state) {
  const ids = (await db('profiles').select('id')).map(r => r.id)
  const keys = [...GLOBAL, ...ids.flatMap(PER_PROFILE)]
  const wanted = new Set(keys)
  let batch = []
  const flush = async () => {
    if (!batch.length) return
    await upsert(db, 'keep_meta', batch.map(b => b.row), 'agency_id,key')
    for (const b of batch) await setState(db, b.row.key, b.hash)
    cloudStatus.pushed += batch.length
    batch = []
  }
  for (const key of keys) {
    let r
    try { r = await local('GET', key) } catch { continue }
    if (!r.ok) continue
    const text = await r.text()
    let data
    try { data = clean(key, JSON.parse(text)) } catch { continue }
    const body = JSON.stringify(data)
    const hash = sha(body)
    if (state.get(key) === hash) continue
    batch.push({ row: { agency_id: agency, key, data, updated_at: new Date().toISOString() }, hash })
    if (batch.length >= 20) await flush()
  }
  await flush()
  // Profiles that are gone: their answers go too.
  for (const key of state.keys()) {
    if (!key.startsWith('/') || wanted.has(key)) continue
    await cloudCall(db, 'DELETE', `/rest/v1/keep_meta?agency_id=eq.${agency}&key=eq.${encodeURIComponent(key)}`, undefined, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
    await db('cloud_sync').where({ key }).del()
  }
}

// ------------------------------------------------------------ 3. documents
async function pushFiles(db, agency, state) {
  const rows = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .select('files.id', 'files.original_name', 'files.mimetype', 'files.size', 'files.created_at', 'files.updated_at',
      'profile_fields.profile_id', 'profile_fields.name as field')
  const live = new Set(rows.map(f => `file:${f.id}`))
  const todo = rows.filter(f => state.get(`file:${f.id}`) !== `${f.size}|${f.updated_at}`)
  cloudStatus.filesLeft = todo.length
  for (const f of todo.slice(0, FILES_PER_ROUND)) {
    const sig = `${f.size}|${f.updated_at}`
    try {
      if (Number(f.size) > MAX_FILE) { await setState(db, `file:${f.id}`, sig); continue }
      const r = await local('GET', `/files/${f.id}/download`)
      if (!r.ok) { await setState(db, `file:${f.id}`, sig); continue }   // not on disk: nothing to copy
      const buf = Buffer.from(await r.arrayBuffer())
      const safe = String(f.original_name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80)
      const object = `${agency}/${f.profile_id}/${f.id}-${safe}`
      await cloudCall(db, 'POST', `/storage/v1/object/keep/${object}`, buf,
        { headers: { 'Content-Type': f.mimetype || 'application/octet-stream', 'x-upsert': 'true' } })
      await upsert(db, 'keep_files', [{
        agency_id: agency, id: f.id, profile_id: f.profile_id, field: f.field, name: f.original_name,
        mimetype: f.mimetype, size: buf.length, object, created_at: f.created_at || null, updated_at: new Date().toISOString(), deleted: false,
      }], 'agency_id,id')
      await setState(db, `file:${f.id}`, sig)
      cloudStatus.files++
      cloudStatus.filesLeft--
    } catch (e) {
      console.warn(`[cloud] file ${f.id} (${f.original_name}): ${e.message}`)
      if (/exceeded|quota|too large|payload/i.test(e.message)) break
    }
  }
  // Documents deleted on the PC: gone online too.
  for (const key of state.keys()) {
    if (!key.startsWith('file:') || live.has(key)) continue
    const id = key.slice(5)
    try {
      const [row] = await cloudCall(db, 'GET', `/rest/v1/keep_files?agency_id=eq.${agency}&id=eq.${id}&select=object`) || []
      if (row?.object) await cloudCall(db, 'DELETE', `/storage/v1/object/keep/${row.object}`).catch(() => {})
      await cloudCall(db, 'DELETE', `/rest/v1/keep_files?agency_id=eq.${agency}&id=eq.${id}`, undefined, { headers: { Prefer: 'return=minimal' } })
    } catch {}
    await db('cloud_sync').where({ key }).del()
  }
}

// ------------------------------------------------------------ the loop
async function syncOnce(db) {
  if (cloudStatus.running) return
  cloudStatus.running = true
  try {
    const agency = await cloudAgencyId(db)
    if (!agency) throw new Error('this PC has no online account yet')
    const applied = await applyChanges(db, agency)
    const state = await stateOf(db)
    await pushAnswers(db, agency, state)
    await pushFiles(db, agency, await stateOf(db))
    cloudStatus.error = null
    cloudStatus.last = new Date().toISOString()
    if (applied) setTimeout(() => syncOnce(db).catch(() => {}), 3000)   // show the phone its own change soon
  } catch (e) {
    cloudStatus.error = /keep_(meta|changes|files|devices)|relation|schema cache|PGRST/i.test(e.message)
      ? 'The online tables are missing: run adal-admin/supabase/keep-sync.sql in Supabase (SQL Editor).'
      : e.message
    console.warn('[cloud]', cloudStatus.error)
  } finally {
    cloudStatus.running = false
  }
}

export async function cloudOn(db) {
  if (!chatConfigured() || isFollower()) return false
  const s = await db('settings').where({ key: 'cloud_sync' }).first().catch(() => null)
  return String(s?.value || 'on').toLowerCase() !== 'off'
}

let timer = null
export function startCloudSync(db) {
  if (timer) return
  const tick = async () => {
    cloudStatus.on = await cloudOn(db).catch(() => false)
    if (cloudStatus.on) await syncOnce(db)
  }
  setTimeout(tick, 45000)
  timer = setInterval(tick, EVERY_MS)
  startRelay(db)
  console.log('☁️  Online copy for phones: synced every minute (when on)')
}
export const syncNow = (db) => syncOnce(db)

// ------------------------------------------------------------ phones
/** A new phone: its own online account, allowed to see this agency's copy. */
export async function makeDevice(db, name = 'Phone') {
  const agency = await cloudAgencyId(db)
  const creds = {
    email: `phone-${crypto.randomBytes(5).toString('hex')}@agency.adalkeep.app`,
    password: crypto.randomBytes(24).toString('base64url'),
  }
  const up = await cloudAuth('signup', creds)
  const userId = up.data?.user?.id || up.data?.id
  if (!up.ok || !userId) throw new Error(`Could not make the phone's online account: ${up.data?.msg || up.data?.message || up.status}`)
  await cloudCall(db, 'POST', '/rest/v1/keep_devices', { user_id: userId, agency_id: agency, name: String(name).slice(0, 60) }, { headers: { Prefer: 'return=minimal' } })
  const { url, anon } = cloudConfig()
  return { url, anon, email: creds.email, password: creds.password, agency, device: userId }
}

export async function listDevices(db) {
  const agency = await cloudAgencyId(db)
  return cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&order=created_at.desc&select=user_id,name,created_at,last_seen,revoked`)
}

export async function setDeviceRevoked(db, userId, revoked = true) {
  const agency = await cloudAgencyId(db)
  await cloudCall(db, 'PATCH', `/rest/v1/keep_devices?agency_id=eq.${agency}&user_id=eq.${userId}`, { revoked: !!revoked }, { headers: { Prefer: 'return=minimal' } })
}

// ------------------------------------------------------------ relay
/**
 * Phones away from the office reach this PC through the online copy while it
 * is on (keep_calls): a phone writes a call — method + API path — and this PC
 * answers it on its own API within a second or two. Live run tabs (captcha,
 * codes), chat, starting runs: everything works as in the office, no
 * Tailscale. Calls are treated as NOT made on this PC (X-Adal-Cloud), so the
 * main-PC-only pages (Trash, system, phones) stay closed to them.
 */
export const relayStatus = { on: false, lastCall: 0, answered: 0, error: null }
const RELAY_FAST_MS = 600, RELAY_SLOW_MS = 2500, RELAY_LATE_MS = 30000, MAX_BIN = 8 * 1024 * 1024
const working = new Set()
let relayTimer = null, lastBeat = 0, lastClean = 0, deviceNames = new Map(), namesAt = 0

async function answerCall(db, agency, c) {
  const patch = { status: 'done', answered_at: new Date().toISOString() }
  try {
    if (Date.now() - new Date(c.created_at).getTime() > RELAY_LATE_MS) { patch.status = 'late'; return }
    const method = String(c.method || 'GET').toUpperCase()
    const p = String(c.path || '')
    if (!p.startsWith('/') || p.includes('..')) throw Object.assign(new Error('bad path'), { code: 400 })
    if (method !== 'GET' && NOT_FROM_PHONES.test(p) && !/^\/chat\b/.test(p)) throw Object.assign(new Error('Not from a phone: do this on the main PC.'), { code: 403 })
    if (Date.now() - namesAt > 60000) {
      deviceNames = new Map(((await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&select=user_id,name`)) || []).map(d => [d.user_id, d.name]))
      namesAt = Date.now()
    }
    const r = await local(method, p, { body: method === 'GET' ? undefined : (c.body ?? undefined), headers: { 'X-Adal-Who': encodeURIComponent(`${deviceNames.get(c.device_id) || 'Phone'} (phone)`) } })
    patch.answer_code = r.status
    const type = r.headers.get('content-type') || ''
    patch.answer_type = type
    patch.answer_head = Object.fromEntries(['x-tab-size', 'x-tab-url', 'content-disposition'].map(h => [h, r.headers.get(h)]).filter(([, v]) => v))
    if (/json/.test(type)) {
      let data = await r.json().catch(() => null)
      if (p.split('?')[0] === '/settings') data = clean('/settings', data)
      patch.answer = data
    } else if (/^text\//.test(type)) {
      patch.answer = await r.text()
    } else {
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > MAX_BIN) throw Object.assign(new Error('Too big to send to the phone.'), { code: 413 })
      patch.answer_bin = buf.toString('base64')
    }
  } catch (e) {
    patch.answer_code = e.code || 500
    patch.answer = { error: e.message }
  } finally {
    await cloudCall(db, 'PATCH', `/rest/v1/keep_calls?id=eq.${c.id}`, patch, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
    relayStatus.answered++
  }
}

async function relayOnce(db) {
  const agency = await cloudAgencyId(db)
  if (!agency) return
  const calls = await cloudCall(db, 'GET', `/rest/v1/keep_calls?agency_id=eq.${agency}&status=eq.new&order=id.asc&limit=12&select=id,device_id,method,path,body,created_at`)
  // "The PC is on": (only once keep_calls answers) phones send their calls here instead of queueing them.
  if (Date.now() - lastBeat > 15000) {
    await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_pc', data: { at: new Date().toISOString() }, updated_at: new Date().toISOString() }], 'agency_id,key')
    lastBeat = Date.now()
  }
  // A phone is busy: its uploads are filed at once too, not at the next minute.
  if (Date.now() - relayStatus.lastCall < 3 * 60000) await applyChanges(db, agency).catch(() => {})
  const todo = (calls || []).filter(c => !working.has(c.id))
  if (todo.length) relayStatus.lastCall = Date.now()
  await Promise.all(todo.map(async c => {
    working.add(c.id)
    try { await answerCall(db, agency, c) } finally { setTimeout(() => working.delete(c.id), 10000) }
  }))
  if (Date.now() - lastClean > 5 * 60000) {
    lastClean = Date.now()
    const old = new Date(Date.now() - 10 * 60000).toISOString()
    await cloudCall(db, 'DELETE', `/rest/v1/keep_calls?agency_id=eq.${agency}&created_at=lt.${old}`, undefined, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
  }
}

export function startRelay(db) {
  if (relayTimer) return
  const loop = async () => {
    let wait = RELAY_SLOW_MS
    try {
      relayStatus.on = await cloudOn(db)
      if (relayStatus.on) {
        await relayOnce(db)
        relayStatus.error = null
        if (Date.now() - relayStatus.lastCall < 3 * 60000) wait = RELAY_FAST_MS
      } else wait = 30000
    } catch (e) {
      relayStatus.error = e.message
      wait = /keep_calls|schema cache|PGRST/i.test(e.message) ? 60000 : 10000
    }
    relayTimer = setTimeout(loop, wait)
  }
  relayTimer = setTimeout(loop, 15000)
}
