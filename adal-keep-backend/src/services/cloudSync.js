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
import { me as joinAgency, chatConfigured, cloudCall, cloudAuth, cloudAgencyId, cloudConfig } from './chatCloud.js'
import { isFollower } from './mainPC.js'
import { tgReady, tgPut, tgDelete, TG_MAX_DOWNLOAD, findStorageChat } from './tgStore.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PORT = () => Number(process.env.PORT) || 4000
const EVERY_MS = 60 * 1000
const FILES_PER_ROUND = 25
const MAX_FILE = 45 * 1024 * 1024

// The answers the pages read: once for the agency, and per profile.
const GLOBAL = ['/profiles', '/brokers', '/tasks', '/employees', '/settings', '/setup/status', '/subscription/status',
  '/automations/stages', '/automations/active', '/notifications', '/checklists', '/cv/templates', '/quick-links',
  '/dashboard', '/tasks/documents', '/wafid/settings', '/health', '/tutor/tour', '/trash', '/cv/generated',
  '/lmis/accounts', '/musaned/accounts', '/tasheer/accounts', '/insurance/accounts', '/visa/accounts']
const PER_PROFILE = (id) => [`/profiles/${id}`, `/profiles/${id}/fields`, `/profiles/${id}/automations`,
  `/profiles/${id}/journey`, `/cv/profile-readiness/${id}`, `/cv/generated?profile_id=${id}`]
const PER_BROKER = (id) => [`/brokers/${id}`]
// The portals' sign-ins (LMIS, Musaned …): the lists go online without their
// passwords; the passwords go in "/vault", locked with the agency's own key
// (keep_secrets.file_key) — the agency's phones open it to sign in themselves.
const ACCOUNT_LISTS = ['/lmis/accounts', '/musaned/accounts', '/tasheer/accounts', '/insurance/accounts', '/visa/accounts']
const SECRET = /pass|token|secret|otp|api[_-]?key|license|cookie/i

// Phone requests never replayed: they change the PC itself, not the agency's work.
const NOT_FROM_PHONES = /^\/(system|backup|branch|main-pc|mobile|subscription|setup|settings\/wallpaper|trash\/empty|trash\/\d+\/purge|chat)\b/

export const cloudStatus = { on: false, running: false, last: null, error: null, pushed: 0, files: 0, filesLeft: 0, applied: 0 }

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex')
// (No body — undefined or null, e.g. a phone's DELETE — is sent as none: "null" is refused as JSON.)
const local = (method, p, { body, headers = {} } = {}) => fetch(`http://127.0.0.1:${PORT()}/api${p}`, {
  method,
  headers: { ...(body != null && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), 'X-Adal-Cloud': '1', ...headers },
  body: body == null || method === 'GET' ? undefined : body instanceof FormData ? body : JSON.stringify(body),
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
  if (!data || typeof data !== 'object') return data
  const strip = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !SECRET.test(k))) : o)
  if (key === '/settings') return strip(data)
  if (ACCOUNT_LISTS.includes(key) && Array.isArray(data)) return data.map(strip)
  // A generated CV's list entry without its full copy of the data (1–2 MB each).
  if (key.startsWith('/cv/generated') && Array.isArray(data)) return data.map(({ data_snapshot, ...c }) => c)
  return data
}

/** "/vault": the portals' sign-ins with their passwords, locked with the agency's key. */
async function pushVault(db, agency, state) {
  const vault = {}
  for (const key of ACCOUNT_LISTS) {
    try { const r = await local('GET', key); if (r.ok) vault[key] = await r.json() } catch {}
  }
  const hash = sha(JSON.stringify(vault))
  if (state.get('/vault') === hash) return
  const { encrypt } = await import('./tgStore.js')
  const { file_key } = await agencySecrets(db, agency)
  await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/vault', data: { v: encrypt(Buffer.from(JSON.stringify(vault)), file_key).toString('base64') }, updated_at: new Date().toISOString() }], 'agency_id,key')
  await setState(db, '/vault', hash)
}

// ------------------------------------------------------------ 1. requests
// A phone's form with files: the files wait in Supabase storage, the rest is text.
async function formOf(db, p) {
  const form = new FormData()
  for (const [k, v] of Object.entries(p.form || {})) form.append(k, String(v))
  for (const f of p.files || []) {
    const res = await cloudCall(db, 'GET', `/storage/v1/object/keep/${f.object}`, undefined, { raw: true })
    if (!res.ok) throw new Error(`file ${f.name} not found online`)
    form.append(f.field || 'file', new Blob([Buffer.from(await res.arrayBuffer())], { type: f.mimetype || 'application/octet-stream' }), f.name || 'file')
  }
  return form
}

let applying = null
const applyChanges = (db, agency) => (applying ||= applyChangesNow(db, agency).finally(() => { applying = null }))
async function applyChangesNow(db, agency) {
  const list = await cloudCall(db, 'GET', `/rest/v1/keep_changes?agency_id=eq.${agency}&applied_at=is.null&order=id.asc&limit=50`)
  let names = null
  for (const c of list || []) {
    let result = ''
    try {
      names ||= new Map(((await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&select=user_id,name`)) || []).map(d => [d.user_id, d.name]))
      const who = { 'X-Adal-Who': encodeURIComponent(names.has(c.device_id) ? `${names.get(c.device_id)} (phone)` : 'Adal support') }
      const p = c.payload || {}
      // (Chat messages written while the PC was off are sent now.)
      if (!String(p.path || '').startsWith('/') || (NOT_FROM_PHONES.test(p.path) && !/^\/chat\b/.test(p.path))) throw new Error('not allowed from a phone')
      let r
      if (c.kind === 'upload') {
        r = await local('POST', p.path, { body: await formOf(db, p), headers: who })
        // Filed on this PC: the phone's upload leaves Supabase storage.
        if (r.ok) for (const f of p.files || []) await cloudCall(db, 'DELETE', `/storage/v1/object/keep/${f.object}`).catch(() => {})
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
const daysTo = (d) => d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400000) : null
/**
 * How this agency's work stands, for Adal Keep Admin's "Agencies' work":
 * runs waiting for a person, failures, open tasks, medicals running out,
 * profiles per journey stage.
 */
async function summary(db) {
  const names = new Map((await db('profiles').select('id', 'full_name')).map(p => [p.id, p.full_name]))
  const runs = await db('automation_queue').select('id', 'profile_id', 'workflow_id', 'status', 'pause_reason', 'current_step', 'updated_at')
  const weekAgo = Date.now() - 7 * 86400000
  const run = (r) => ({ id: r.id, profile_id: r.profile_id, name: names.get(r.profile_id) || null, workflow: r.workflow_id, reason: r.pause_reason || r.current_step || null, at: r.updated_at })
  const by = (s) => runs.filter(r => r.status === s)
  const failed = by('failed').filter(r => new Date(r.updated_at).getTime() > weekAgo)
  const tasks = await db('tasks').where({ status: 'pending' }).orderBy('id', 'desc').select('id', 'title', 'profile_id', 'created_at')
  const meds = (await db('profiles').whereNotNull('medical_valid_until').select('id', 'full_name', 'medical_valid_until'))
    .map(p => ({ id: p.id, name: p.full_name, days: daysTo(p.medical_valid_until) })).filter(m => m.days !== null && m.days <= 14).sort((a, b) => a.days - b.days)
  let stages = {}
  try {
    const r = await local('GET', '/automations/stages')
    if (r.ok) for (const p of (await r.json()).profiles || []) stages[p.stage] = (stages[p.stage] || 0) + 1
  } catch {}
  return {
    profiles: names.size,
    chosen: (await db('profiles').whereNotNull('chosen_at').count({ n: '*' }))[0].n,
    stages,
    runs: { running: by('running').length, pending: by('pending').length, paused: by('paused').length, failed7d: failed.length },
    waiting: by('paused').concat(by('pending')).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 40).map(run),
    failed: failed.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 25).map(run),
    tasks: { open: tasks.length, latest: tasks.slice(0, 15) },
    medicals: meds.slice(0, 25),
  }
}

// A change on this PC (anyone's: the PC, a phone, Admin): the answers it
// touches go online within a second, and the phones are told which ones
// changed (live link) — they keep their own copy of every answer.
const soonKeys = new Set()
let vaultSoon = false
const soonAt = new Map()   // key → when a change of it went online (the minute's copy must not undo it)
let soonTimer = null
export function pushSoon(db, apiPath) {
  const p = String(apiPath || '').replace(/^\/api/, '').split('?')[0]
  const id = p.match(/^\/profiles\/(\d+)/)?.[1] || p.match(/^\/cv\/profile-readiness\/(\d+)/)?.[1]
  const keys = id ? [...PER_PROFILE(id), '/profiles', '/dashboard', '/automations/active', '/automations/stages', '/tasks', '/notifications', '/checklists']
    : GLOBAL.filter(k => !['/setup/status', '/subscription/status', '/health', '/tutor/tour', '/cv/templates'].includes(k))
  if (/^\/automations/.test(p)) for (const r of ['/profiles', '/automations/active', '/automations/stages']) keys.push(r)
  const broker = p.match(/^\/brokers\/(\d+)/)?.[1]
  if (broker) keys.push(`/brokers/${broker}`)
  if (/accounts/.test(p)) { keys.push(...ACCOUNT_LISTS); vaultSoon = true }
  keys.forEach(k => soonKeys.add(k))
  clearTimeout(soonTimer)
  soonTimer = setTimeout(() => pushKeys(db).catch(e => console.warn('[cloud] soon:', e.message)), 600)
}
async function pushKeys(db) {
  if (!soonKeys.size || !(await cloudOn(db).catch(() => false))) return
  const keys = [...soonKeys]; soonKeys.clear()
  const agency = await cloudAgencyId(db)
  if (!agency) return
  const state = await stateOf(db)
  if (vaultSoon) { vaultSoon = false; await pushVault(db, agency, state).catch(() => {}) }
  const rows = [], hashes = []
  for (const key of keys) {
    let r
    try { r = await local('GET', key) } catch { continue }
    if (!r.ok) continue
    let data
    try { data = clean(key, await r.json()) } catch { continue }
    const hash = sha(JSON.stringify(data))
    if (state.get(key) === hash) continue
    rows.push({ agency_id: agency, key, data, updated_at: new Date().toISOString() }); hashes.push(hash)
  }
  if (!rows.length) return
  const now = Date.now()
  rows.forEach(r => soonAt.set(r.key, now))
  // Small answers first, and straight to the phones on the live link with
  // their data (no download for them); then saved online, small before big.
  const sized = rows.map((r, i) => ({ r, h: hashes[i], n: JSON.stringify(r.data).length })).sort((a, b) => a.n - b.n)
  const { broadcast } = await import('./liveChannel.js')
  const small = sized.filter(x => x.n < 60000)
  for (let i = 0, part = [], size = 0; i <= small.length; i++) {
    const x = small[i]
    if (!x || size + x.n > 150000) { if (part.length) broadcast({ t: 'changed', rows: part }); part = []; size = 0 }
    if (x) { part.push({ key: x.r.key, data: x.r.data, updated_at: x.r.updated_at }); size += x.n }
  }
  for (const group of [small, sized.filter(x => x.n >= 60000)]) {
    if (!group.length) continue
    await upsert(db, 'keep_meta', group.map(x => x.r), 'agency_id,key')
    for (const x of group) await setState(db, x.r.key, x.h)
    cloudStatus.pushed += group.length
    const big = group.filter(x => x.n >= 60000).map(x => x.r.key)
    if (big.length) broadcast({ t: 'changed', keys: big })
  }
}

async function pushAnswers(db, agency, state) {
  const ids = (await db('profiles').select('id')).map(r => r.id)
  const brokers = (await db('brokers').select('id').catch(() => [])).map(r => r.id)
  const keys = [...GLOBAL, ...ids.flatMap(PER_PROFILE), ...brokers.flatMap(PER_BROKER)]
  await pushVault(db, agency, state).catch(e => console.warn('[cloud] vault:', e.message))
  const wanted = new Set(keys)
  let batch = []
  const flush = async () => {
    batch = batch.filter(b => !(soonAt.get(b.row.key) > b.readAt))   // a newer change already went online
    if (!batch.length) return
    await upsert(db, 'keep_meta', batch.map(b => b.row), 'agency_id,key')
    for (const b of batch) await setState(db, b.row.key, b.hash)
    cloudStatus.pushed += batch.length
    const sent = batch.map(b => b.row.key)
    import('./liveChannel.js').then(L => L.broadcast({ t: 'changed', keys: sent })).catch(() => {})
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
    batch.push({ row: { agency_id: agency, key, data, updated_at: new Date().toISOString() }, hash, readAt: Date.now() })
    if (batch.length >= 20) await flush()
  }
  // The work summary (Adal Keep Admin).
  try {
    const data = await summary(db)
    const hash = sha(JSON.stringify(data))
    if (state.get('/_summary') !== hash) {
      await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_summary', data: { ...data, at: new Date().toISOString() }, updated_at: new Date().toISOString() }], 'agency_id,key')
      await setState(db, '/_summary', hash)
    }
  } catch (e) { console.warn('[cloud] summary:', e.message) }
  await flush()
  // Profiles that are gone: their answers go too.
  for (const key of state.keys()) {
    if (!key.startsWith('/') || wanted.has(key) || key === '/_summary' || key === '/vault') continue
    await cloudCall(db, 'DELETE', `/rest/v1/keep_meta?agency_id=eq.${agency}&key=eq.${encodeURIComponent(key)}`, undefined, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
    await db('cloud_sync').where({ key }).del()
  }
}

// ------------------------------------------------------------ secrets
/** The agency's file key, live channel name and storage bot (made once). */
let secretsCache = null
export async function agencySecrets(db, agency) {
  if (secretsCache?.agency_id === agency && secretsCache.bot === (process.env.TELEGRAM_BOT_TOKEN || null)) return secretsCache
  let [row] = await cloudCall(db, 'GET', `/rest/v1/keep_secrets?agency_id=eq.${agency}&select=agency_id,file_key,live,bot`)
  const bot = process.env.TELEGRAM_BOT_TOKEN || null
  if (!row) {
    row = { agency_id: agency, file_key: crypto.randomBytes(32).toString('base64'), live: crypto.randomBytes(18).toString('base64url'), bot }
    await cloudCall(db, 'POST', '/rest/v1/keep_secrets', row, { headers: { Prefer: 'return=minimal' } })
  } else if (row.bot !== bot) {
    await cloudCall(db, 'PATCH', `/rest/v1/keep_secrets?agency_id=eq.${agency}`, { bot }, { headers: { Prefer: 'return=minimal' } })
    row.bot = bot
  }
  secretsCache = row
  return row
}

// ------------------------------------------------------------ 3. documents
async function pushFiles(db, agency, state) {
  // Documents go to Telegram (encrypted) once it is set up; the copies in
  // Supabase storage are moved there and removed — Supabase keeps no files.
  const tg = tgReady()
  if (tg && state.get('storage') !== 'tg') {
    await db('cloud_sync').where('key', 'like', 'file:%').del()
    await setState(db, 'storage', 'tg')
    for (const k of [...state.keys()]) if (k.startsWith('file:')) state.delete(k)
    console.log('[cloud] documents now go to Telegram — moving them out of Supabase')
  }
  const secret = tg ? await agencySecrets(db, agency) : null
  const LIMIT = tg ? TG_MAX_DOWNLOAD : MAX_FILE
  const rows = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .select('files.id', 'files.original_name', 'files.mimetype', 'files.size', 'files.created_at', 'files.updated_at',
      'profile_fields.profile_id', 'profile_fields.name as field')
  const live = new Set(rows.map(f => `file:${f.id}`))
  const todo = rows.filter(f => state.get(`file:${f.id}`) !== `${f.size}|${f.updated_at}`)
  cloudStatus.filesLeft = todo.length
  for (const f of todo.slice(0, FILES_PER_ROUND)) {
    const sig = `${f.size}|${f.updated_at}`
    try {
      if (Number(f.size) > LIMIT) { await setState(db, `file:${f.id}`, sig); continue }
      const r = await local('GET', `/files/${f.id}/download`)
      if (!r.ok) { await setState(db, `file:${f.id}`, sig); continue }   // not on disk: nothing to copy
      const buf = Buffer.from(await r.arrayBuffer())
      const safe = String(f.original_name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80)
      const [old] = await cloudCall(db, 'GET', `/rest/v1/keep_files?agency_id=eq.${agency}&id=eq.${f.id}&select=object`).catch(() => []) || []
      let object
      if (tg) object = await tgPut(buf, `${f.id}-${safe}`, secret.file_key)
      else {
        object = `${agency}/${f.profile_id}/${f.id}-${safe}`
        await cloudCall(db, 'POST', `/storage/v1/object/keep/${object}`, buf,
          { headers: { 'Content-Type': f.mimetype || 'application/octet-stream', 'x-upsert': 'true' } })
      }
      // The older copy (Supabase storage, or an older Telegram post) goes.
      if (old?.object && old.object !== object) {
        if (old.object.startsWith('tg:')) await tgDelete(old.object)
        else await cloudCall(db, 'DELETE', `/storage/v1/object/keep/${old.object}`).catch(() => {})
      }
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
      if (row?.object?.startsWith('tg:')) await tgDelete(row.object)
      else if (row?.object) await cloudCall(db, 'DELETE', `/storage/v1/object/keep/${row.object}`).catch(() => {})
      await cloudCall(db, 'DELETE', `/rest/v1/keep_files?agency_id=eq.${agency}&id=eq.${id}`, undefined, { headers: { Prefer: 'return=minimal' } })
    } catch {}
    await db('cloud_sync').where({ key }).del()
  }
}

// ------------------------------------------------------------ the loop
let joined = false
async function syncOnce(db) {
  if (cloudStatus.running) return
  cloudStatus.running = true
  try {
    const agency = await cloudAgencyId(db)
    if (!agency) throw new Error('this PC has no online account yet')
    // Another online account than last time (the old one was deleted): the
    // online copy is empty — copy everything again.
    const was = await db('cloud_sync').where({ key: 'agency' }).first().catch(() => null)
    if (was?.hash !== agency) {
      if (was) console.log('[cloud] new online account — copying everything again')
      await db('cloud_sync').del()
      await setState(db, 'agency', agency)
    }
    // Listed as an agency (name + PC number) for Adal Keep Admin, chat or not.
    if (!joined) { await joinAgency(db).then(() => { joined = true }).catch(e => console.warn('[cloud] agency:', e.message)) }
    await publishPC(db).catch(e => console.warn('[cloud] PC number:', e.message))
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
  watchStorageChat()
  setTimeout(() => setInterval(() => watchJoins(db), 4000), 15000)
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
const RELAY_FAST_MS = 600, RELAY_SLOW_MS = 6000, RELAY_LATE_MS = 30000, MAX_BIN = 8 * 1024 * 1024
const working = new Set()
let relayTimer = null, lastBeat = 0, lastClean = 0, deviceNames = new Map(), namesAt = 0

async function answerCall(db, agency, c) {
  let patch = { status: 'done', answered_at: new Date().toISOString() }
  try {
    if (Date.now() - new Date(c.created_at).getTime() > RELAY_LATE_MS) { patch.status = 'late'; return }
    patch = { ...patch, ...(await runCall(db, agency, c)) }
  } finally {
    await cloudCall(db, 'PATCH', `/rest/v1/keep_calls?id=eq.${c.id}`, patch, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
    relayStatus.answered++
  }
}

/** One phone/Admin call on this PC's own API → { answer_code, answer_type, answer_head, answer | answer_bin }. */
// Adal's id (the "Adal Keep" chat identity). Phones can only send calls under
// their own id (keep_calls RLS), so a call carrying this id is Adal's.
let adalId = null
async function fromAdal(db, id) {
  if (!id) return false
  if (!adalId) {
    const { agencies } = await import('./chatCloud.js')
    adalId = ((await agencies(db).catch(() => [])) || []).find(a => a.is_admin)?.id || null
  }
  return !!adalId && id === adalId
}
// What Adal can do on an agency's PC, from Admin: back up now, restore the
// newest backup here (its own, or another agency PC's — a replaced PC).
export const adalJob = { kind: null, running: false, result: null, error: null, at: null }
async function adalCommand(db, method, p, body) {
  const B = await import('./telegramBackup.js')
  if (p === '/_adal/backup' && method === 'GET') return { ...B.getConfig(), progress: B.progress, job: adalJob }
  if (adalJob.running || B.progress.running) return { busy: true, job: adalJob, progress: B.progress }
  const go = (kind, fn) => {
    Object.assign(adalJob, { kind, running: true, result: null, error: null, at: new Date().toISOString() })
    fn().then(r => { adalJob.result = r }).catch(e => { adalJob.error = e.message }).finally(() => { adalJob.running = false })
    return { started: true }
  }
  if (p === '/_adal/backup/run' && method === 'POST') {
    B.ensureBackupKey()
    return go('backup', () => B.runBackup(db, { force: true }))
  }
  if (p === '/_adal/backup/restore' && method === 'POST') {
    return go('restore', async () => {
      const b = await B.newestBackup(db, { file_id: body.file_id, key: body.key })
      const r = await B.restoreFrom(b.index, { password: b.key })
      // Restored from another agency PC's backup: keep its key for later backups.
      if (body.key && r.ok) B.saveConfig({ password: body.key })
      if (r.database && process.platform === 'win32') setTimeout(() => process.exit(0), 2000)   // the launcher starts it again with the restored database
      return r
    })
  }
  throw Object.assign(new Error('Unknown command'), { code: 404 })
}

export async function runCall(db, agency, c) {
  const patch = {}
  try {
    const method = String(c.method || 'GET').toUpperCase()
    const p = String(c.path || '')
    if (!p.startsWith('/') || p.includes('..')) throw Object.assign(new Error('bad path'), { code: 400 })
    if (p.startsWith('/_adal/')) {
      // Adal support's own commands (Adal Keep Admin) — only from Adal's id.
      if (!(await fromAdal(db, c.device_id))) throw Object.assign(new Error('Only Adal can do this.'), { code: 403 })
      patch.answer = await adalCommand(db, method, p, c.body || {})
      patch.answer_code = 200
      patch.answer_type = 'application/json'
      return patch
    }
    if (method !== 'GET' && NOT_FROM_PHONES.test(p) && !/^\/chat\b/.test(p)) throw Object.assign(new Error('Not from a phone: do this on the main PC.'), { code: 403 })
    if (Date.now() - namesAt > 60000) {
      deviceNames = new Map(((await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&select=user_id,name`)) || []).map(d => [d.user_id, d.name]))
      namesAt = Date.now()
    }
    const who = { 'X-Adal-Who': encodeURIComponent(deviceNames.has(c.device_id) ? `${deviceNames.get(c.device_id)} (phone)` : 'Adal support') }
    // An upload from a phone while the PC is on: done now, with the PC's real answer.
    const up = method === 'POST' && c.body?.__upload
    const r = up
      ? await local('POST', p, { body: await formOf(db, c.body.__upload), headers: who })
      : await local(method, p, { body: method === 'GET' ? undefined : (c.body ?? undefined), headers: who })
    if (up && r.ok) for (const f of c.body.__upload.files || []) cloudCall(db, 'DELETE', `/storage/v1/object/keep/${f.object}`).catch(() => {})
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
  }
  return patch
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

// ------------------------------------------------------------ pairing
/** Phones pair from anywhere: this PC's number + the agency's phone password. */
export async function setPhonePassword(db, pc, password) {
  await cloudCall(db, 'POST', '/rest/v1/rpc/keep_set_phone_password', { p_pc: String(pc), p_password: String(password || '') })
}
export async function phonePasswordSet(db) {
  const agency = await cloudAgencyId(db)
  const rows = await cloudCall(db, 'GET', `/rest/v1/keep_pairing?agency_id=eq.${agency}&select=pc_number,updated_at,pass_hash`).catch(() => [])
  const r = rows?.[0]
  return r ? { pc_number: r.pc_number, updated_at: r.updated_at, pass_set: !!r.pass_hash } : null
}

// ------------------------------------------------------------ Telegram channel
/**
 * The bot is set (TELEGRAM_BOT_TOKEN) but not its channel yet: once someone
 * adds the bot to a private channel and writes in it, that channel is saved
 * in .env and documents start going there.
 */
function watchStorageChat() {
  if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_STORAGE_CHAT) return
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')
  const t = setInterval(async () => {
    try {
      const c = await findStorageChat()
      if (!c) return
      clearInterval(t)
      process.env.TELEGRAM_STORAGE_CHAT = c.id
      const lines = (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').split('\n').filter(l => !/^TELEGRAM_STORAGE_CHAT=/.test(l))
      fs.writeFileSync(envFile, [...lines.filter((l, i) => l.trim() || i < lines.length - 1), `TELEGRAM_STORAGE_CHAT=${c.id}`, ''].join('\n'))
      console.log(`[cloud] Telegram channel "${c.title}" saved — documents go there from now on`)
    } catch (e) { console.warn('[cloud] Telegram channel:', e.message) }
  }, 30000)
}

// ------------------------------------------------------------ joining
let published = null
async function publishPC(db) {
  const { pcNumber } = await import('./mainPC.js')
  if (published === pcNumber()) return
  await cloudCall(db, 'POST', '/rest/v1/rpc/keep_publish_pc', { p_pc: pcNumber(), p_open: false })
  published = pcNumber()
}

/**
 * Phones asking to join (they typed this PC's number): shown on the PC —
 * "Phone X wants to join — Yes, it's me / No" — and as a desktop notice.
 */
export const joinRequests = { list: [], error: null }
const announced = new Set()
async function watchJoins(db) {
  try {
    if (!(await cloudOn(db))) { joinRequests.list = []; return }
    const agency = await cloudAgencyId(db)
    await publishPC(db)
    const rows = await cloudCall(db, 'GET', `/rest/v1/keep_join_requests?agency_id=eq.${agency}&status=eq.pending&order=created_at.asc&select=id,name,created_at`)
    // Old requests (over 10 minutes) are not shown: the phone asks again.
    joinRequests.list = (rows || []).filter(r => Date.now() - new Date(r.created_at).getTime() < 10 * 60000)
    joinRequests.error = null
    for (const r of joinRequests.list) {
      if (announced.has(r.id)) continue
      announced.add(r.id)
      console.log(`[cloud] phone "${r.name}" asks to join`)
      try {
        const { showDesktopNotice } = await import('./worker.js')
        showDesktopNotice(`📱 ${r.name || 'A phone'} wants to join`, 'Open Adal Keep and press "Yes, it\'s me" — or No if you do not know this phone.')
      } catch {}
    }
  } catch (e) { joinRequests.error = e.message }
}
export async function answerJoin(db, id, ok) {
  await cloudCall(db, 'POST', '/rest/v1/rpc/keep_answer_join', { p_id: id, p_ok: !!ok })
  joinRequests.list = joinRequests.list.filter(r => r.id !== id)
}
