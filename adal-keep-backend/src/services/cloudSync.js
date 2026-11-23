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
import { plainReason } from './runOutcome.js'
import { runsWorking } from './busy.js'
import { me as joinAgency, chatConfigured, cloudCall, cloudAuth, cloudAgencyId, cloudConfig } from './chatCloud.js'
// ("isFollower" here: not the PC holding the main PC's role. Only that PC keeps the online copy.)
import { notMainPC as isFollower, pcNumber as myPcNumber } from './mainPC.js'
import { getLanAddresses } from './discovery.js'
// The heartbeat also carries this PC's number: Adal Admin keeps the number on
// the PC's current online account (an old account kept it before, so a phone or
// a Companion typing it found an empty copy).
// The PC's office addresses too: a Companion that joined with the PC number
// opens this PC directly from them (instant) instead of through the cloud.
// (getLanAddresses gives the addresses themselves: '.address' of each was undefined, so the
// heartbeat said lan: [null, null] and no Companion could find the main PC from it.)
export const lanNow = () => { try { return getLanAddresses().map(a => typeof a === 'string' ? a : a?.address).filter(Boolean).slice(0, 6) } catch { return [] } }
// The beat also says which licence this PC uses and whether it is suspended (Admin shows it).
let licBeat = null
import('./plans.js').then(P => { licBeat = () => { const l = P.licenseNow(); return l ? { lic_at: l.at || null, suspended: !!l.suspended } : {} } }).catch(() => {})
// acting: an Adal Companion standing in for the main PC (services/standby) — the Companions tell it from the real one.
let hwBeat = () => ({})
import('./hardware.js').then(H => { hwBeat = () => ({ hw: H.hardwareBeat() }) }).catch(() => {})
const beatData = () => ({ at: new Date().toISOString(), ...hwBeat(), ...(isFollower() ? {} : { pc: myPcNumber(), lan: lanNow(), port: Number(process.env.ADAL_ADVERTISE_PORT) || PORT(), ...(process.env.ADAL_ACTING_MAIN === '1' ? { acting: true } : {}), ...(licBeat?.() || {}) }) })
import { waitForQuiet } from './userUploads.js'
import { tgReady, tgPut, tgDelete, TG_MAX_DOWNLOAD, findStorageChat } from './tgStore.js'
import { viewCopy } from './viewCopy.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PORT = () => Number(process.env.PORT) || 4000
const EVERY_MS = 60 * 1000
// Documents: smallest first, for up to this long per round (then the next round at once).
const FILES_ROUND_MS = 50 * 1000
const FILES_AT_ONCE = 2
const MAX_FILE = 45 * 1024 * 1024

// The answers the pages read: once for the agency, and per profile.
// (What a Companion or phone opens with first comes first: the first copy of a
// big agency goes online in that order.)
const GLOBAL = ['/setup/status', '/subscription/status', '/settings', '/profiles', '/brokers', '/employees', '/tasks',
  '/automations/stages', '/automations/active', '/notifications', '/checklists', '/cv/templates', '/quick-links',
  '/dashboard', '/tasks/documents', '/wafid/settings', '/health', '/tutor/tour', '/trash', '/cv/generated',
  '/lmis/accounts', '/musaned/accounts', '/tasheer/accounts', '/insurance/accounts', '/visa/accounts',
  '/automations/ready-for-submit', '/tutor/adoption', '/main-pc', '/plan', '/whatsapp', '/whatsapp/agents',
  // The morning sign-in list (a Companion or phone sees it without waiting for the PC).
  '/sessions',
  // The dashboard's "Needs action today" (also with the PC off).
  '/needs-action',
  // What needs a person now: a phone with Adal Keep closed shows it (AdalNoticeJob).
  '/automations/attention',
  // The newest good backup and the licence's end: every screen warns (SafetyAlerts).
  '/safety',
  // The agency's order of the steps after the EPRO: the Profiles tabs count the same everywhere.
  '/settings/journey-order',
  // The staff roles (Employees → Roles): the same on every PC and phone.
  '/staff-roles']
const PER_PROFILE = (id) => [`/profiles/${id}`, `/profiles/${id}/fields`, `/profiles/${id}/automations`,
  `/profiles/${id}/journey`, `/profiles/${id}/fill-plan`, `/cv/profile-readiness/${id}`, `/cv/generated?profile_id=${id}`,
  `/profiles/${id}/whatsapp`, `/profiles/${id}/days`]
// A broker's page: the broker and the profiles it brought (text only).
const PER_BROKER = (id) => [`/brokers/${id}`, `/profiles?broker_id=${id}`]
// The portals' sign-ins (LMIS, Musaned …): the lists go online without their
// passwords; the passwords go in "/vault", locked with the agency's own key
// (keep_secrets.file_key) — the agency's phones open it to sign in themselves.
const ACCOUNT_LISTS = ['/lmis/accounts', '/musaned/accounts', '/tasheer/accounts', '/insurance/accounts', '/visa/accounts']
const SECRET = /pass|token|secret|otp|api[_-]?key|license|cookie/i

// Phone requests never replayed: they change the PC itself, not the agency's work.
// ("Back up now" is allowed: a phone or a Companion asks the main PC to back up.)
const NOT_FROM_PHONES = /^\/(system|backup(?!\/run(?:$|\?))|branch|main-pc|mobile|subscription|setup|settings\/wallpaper|trash\/empty|trash\/\d+\/purge|chat|pc-access)\b/
// An Adal Companion PC (its online account is "Companion · …") is the same
// Adal Keep as this PC (asked on 2026-11-19): through the online link it may
// do all a phone may not, except choosing the main PC and managing devices.
const NOT_FROM_COMPANIONS = /^\/(main-pc|pc-access)\b/
export const isCompanionName = (name) => /^Companion ·/.test(String(name || ''))
/** Whether a call from this online account may go to this path (method: a call's; changes count as writes). */
export function allowedFrom(name, method, p) {
  if (String(method || 'POST').toUpperCase() === 'GET' || /^\/chat\b/.test(p)) return true
  return !(isCompanionName(name) ? NOT_FROM_COMPANIONS : NOT_FROM_PHONES).test(p)
}
/** Who made the call, for the PC's own API (X-Adal-Who, and X-Adal-Companion for a Companion). */
function whoHeaders(names, id) {
  if (!names.has(id)) return { 'X-Adal-Who': encodeURIComponent('Adal support') }
  const n = names.get(id)
  return isCompanionName(n)
    ? { 'X-Adal-Who': encodeURIComponent(n), 'X-Adal-Companion': '1' }
    : { 'X-Adal-Who': encodeURIComponent(`${n} (phone)`) }
}

export const cloudStatus = { on: false, running: false, last: null, error: null, lastFail: null, lastFailAt: null, pushed: 0, files: 0, filesLeft: 0, applied: 0, textDone: null, bytesSaved: 0 }

// The first copy of the text (every page once) is done: documents wait for it.
// (The backup never waits for it: backups go at once, by their own route.)
const TEXT_DONE = 'sweep:full'
/** The online copy is still being filled (text or documents): heavy work waits. */
export const onlineCopyFilling = () => cloudStatus.on && (cloudStatus.textDone === false || cloudStatus.filesLeft > 0)

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex')
// (No body — undefined or null, e.g. a phone's DELETE — is sent as none: "null" is refused as JSON.)
const local = (method, p, { body, headers = {} } = {}) => fetch(`http://127.0.0.1:${PORT()}/api${p}`, {
  method,
  // A page of this PC that never answers (a stuck reading) gives up after 3 minutes.
  signal: AbortSignal.timeout(3 * 60_000),
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
  // The calls without their captcha pictures (a phone's notification needs only the words).
  if (key === '/automations/attention' && Array.isArray(data)) return data.map(({ image, ...c }) => ({ ...c, image: null }))
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
  // The Musaned authenticators: the phones show each account's code (locked like the rest).
  try {
    const ids = (await db('musaned_accounts').select('id').catch(() => [])).map(r => r.id)
    const { authenticatorKeys } = await import('./musanedTotp.js')
    const keys = authenticatorKeys(ids)
    if (Object.keys(keys).length) vault['/musaned-totp'] = keys
  } catch {}
  // The agency's chat account: its phones chat straight with the chat server
  // when this PC is off (frontend cloud/chatDirect.js). Locked like the rest.
  try {
    const chat = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', '.adal_chat.json'), 'utf8'))
    if (chat?.email && chat?.password) vault['/chat-account'] = { email: chat.email, password: chat.password, user_id: chat.user_id || null }
  } catch {}
  const hash = sha(JSON.stringify(vault))
  if (state.get('/vault') === hash) return
  const { encrypt } = await import('./tgStore.js')
  const { file_key } = await agencySecrets(db, agency)
  await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/vault', data: { v: encrypt(Buffer.from(JSON.stringify(vault)), file_key).toString('base64') }, updated_at: new Date().toISOString() }], 'agency_id,key')
  await setState(db, '/vault', hash)
}

/**
 * The key that opens the portal passwords in the database (data/account-vault.key)
 * online too, locked with the documents' key ("we shouldn't lose any data in
 * any way", 2026-11-20). It is also in every Telegram backup and on every
 * Companion; services/keySafe.js brings it back from here when a PC lost it.
 */
async function pushVaultKey(db, agency, state) {
  if (isFollower()) return
  const { vaultKey } = await import('./accountVault.js')
  const k = vaultKey()
  const hash = sha(`vk:${k}`)
  if (state.get('/_keys') === hash) return
  const { encrypt } = await import('./tgStore.js')
  const { file_key } = await agencySecrets(db, agency)
  await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_keys', data: { v: encrypt(Buffer.from(JSON.stringify({ vault_key: k, at: new Date().toISOString() })), file_key).toString('base64') }, updated_at: new Date().toISOString() }], 'agency_id,key')
  await setState(db, '/_keys', hash)
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

// A profile a phone made with the PC off has the phone's own number (below 0)
// until the PC makes it; then its real one (asked on 2026-11-15: profiles,
// their documents and CVs made on a phone with the PC off). Her documents the
// phone added name their field (field_name): the field's real number is hers.
export async function realPath(db, p) {
  let path_ = String(p.path || '')
  const ref = path_.match(/^\/profiles\/(-\d+)(\/|$)/)?.[1]
  if (ref) {
    const real = (await db('cloud_sync').where({ key: `ref:profile:${ref}` }).first('hash').catch(() => null))?.hash
    if (!real) throw new Error('that profile was not made')
    path_ = path_.replace(`/profiles/${ref}`, `/profiles/${real}`)
  }
  const field = path_.match(/^\/profiles\/(\d+)\/fields\/(-\d+)(\/|$)/)
  if (field) {
    const name = String(p.field_name || '')
    if (!name) throw new Error('which document field is not said')
    const find = () => db('profile_fields').where({ profile_id: Number(field[1]), name }).orderBy('id').first('id')
    let f = await find()
    if (!f) { await local('GET', `/profiles/${field[1]}/fields`).catch(() => {}); f = await find() }
    if (!f) throw new Error(`no "${name}" field`)
    path_ = path_.replace(`/fields/${field[2]}`, `/fields/${f.id}`)
  }
  // A CV asked for her (body.profile_id) while she had the phone's number.
  if (Number(p.body?.profile_id) < 0) {
    const real = (await db('cloud_sync').where({ key: `ref:profile:${Number(p.body.profile_id)}` }).first('hash').catch(() => null))?.hash
    if (!real) throw new Error('that profile was not made')
    p.body = { ...p.body, profile_id: Number(real) }
  }
  const list = path_.match(/^\/checklists\/(-\d+)(\/|$)/)?.[1]
  if (list) {
    const real = (await db('cloud_sync').where({ key: `ref:checklist:${list}` }).first('hash').catch(() => null))?.hash
    if (!real) throw new Error('that checklist was not made')
    path_ = path_.replace(list, real)
  }
  return path_
}
/** The profiles phones made: their own number → the real one, for the phones (keep_meta "/phone-refs"). */
async function pushRefs(db, agency) {
  const rows = await db('cloud_sync').where('key', 'like', 'ref:profile:%').select('key', 'hash').catch(() => [])
  const data = Object.fromEntries(rows.map(r => [r.key.slice('ref:profile:'.length), Number(r.hash)]))
  await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/phone-refs', data, updated_at: new Date().toISOString() }], 'agency_id,key')
}

let applying = null
const applyChanges = (db, agency) => (applying ||= applyChangesNow(db, agency).finally(() => { applying = null }))
async function applyChangesNow(db, agency) {
  const list = await cloudCall(db, 'GET', `/rest/v1/keep_changes?agency_id=eq.${agency}&applied_at=is.null&order=id.asc&limit=50`)
  let names = null
  for (const c of list || []) {
    let result = ''
    try {
      if (!names) {
        const rows = (await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&select=user_id,name,revoked`)) || []
        names = new Map(rows.map(d => [d.user_id, d.name]))
        names.off = new Set(rows.filter(d => d.revoked).map(d => d.user_id))
      }
      if (names.off.has(c.device_id)) throw new Error('this device was suspended by the main PC')
      const who = whoHeaders(names, c.device_id)
      const p = c.payload || {}
      // (Chat messages written while the PC was off are sent now.)
      if (!String(p.path || '').startsWith('/') || !allowedFrom(names.get(c.device_id), 'POST', String(p.path))) throw new Error('not allowed from a phone')
      let r
      const makesProfile = /^\/(profiles|new-profile\/with-passport)$/.test(String(p.path || ''))
      const phoneRef = makesProfile ? Number(p.body?.phone_ref ?? p.form?.phone_ref) || 0 : 0
      const made = async (res) => {
        if (!res.ok || phoneRef >= 0) return
        const m = await res.clone().json().catch(() => null)
        if (m?.id) { await setState(db, `ref:profile:${phoneRef}`, String(m.id)); await pushRefs(db, agency).catch(() => {}) }
      }
      // Made once only, even when the phone's request came twice.
      const already = phoneRef < 0 && (await db('cloud_sync').where({ key: `ref:profile:${phoneRef}` }).first('hash').catch(() => null))?.hash
      if (already) r = new Response(JSON.stringify({ id: Number(already) }), { status: 200 })
      else if (c.kind === 'upload') {
        r = await local('POST', await realPath(db, p), { body: await formOf(db, p), headers: who })
        await made(r)
        // Filed on this PC: the phone's upload leaves Supabase storage.
        if (r.ok) for (const f of p.files || []) await cloudCall(db, 'DELETE', `/storage/v1/object/keep/${f.object}`).catch(() => {})
      } else {
        // Something a phone made with the PC off (a checklist, a profile) has the
        // phone's own number (below 0) until here: the real one is put in its place.
        r = await local(String(p.method || 'POST').toUpperCase(), await realPath(db, p), { body: p.body, headers: who })
        await made(r)
        if (r.ok && p.path === '/checklists' && Number(p.body?.phone_ref) < 0) {
          const made = await r.clone().json().catch(() => null)
          if (made?.id) await setState(db, `ref:checklist:${Number(p.body.phone_ref)}`, String(made.id))
        }
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
  const { agentList, agentLimit } = await import('./whatsapp.js')
  const company = await db('companies').first('name', 'owner_name', 'phone1', 'phone2').catch(() => null)
  const reasons = {}
  for (const r of failed) { const why = plainReason(r.pause_reason); reasons[why] = (reasons[why] || 0) + 1 }
  return {
    ceo: { agency: company?.name || '', name: company?.owner_name || '', phone: company?.phone2 || company?.phone1 || '' },
    agents: await agentList(db),
    agent_limit: await agentLimit(db),
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, n]) => ({ why, n })),
    profiles: names.size,
    chosen: (await db('profiles').whereNotNull('chosen_at').count({ n: '*' }))[0].n,
    stages,
    runs: { running: by('running').length, pending: by('pending').length, paused: by('paused').length, failed7d: failed.length },
    waiting: by('paused').concat(by('pending')).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 40).map(run),
    failed: failed.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 25).map(run),
    tasks: { open: tasks.length, latest: tasks.slice(0, 15) },
    medicals: meds.slice(0, 25),
    has: {
      employees: Number((await db('users').count({ n: '*' }).catch(() => [{ n: 0 }]))[0].n) || 0,
      brokers: Number((await db('brokers').count({ n: '*' }).catch(() => [{ n: 0 }]))[0].n) || 0,
      cv_templates: (await db('cv_templates').select('name').catch(() => [])).map(t => t.name),
      checklists: Number((await db('checklists').count({ n: '*' }).catch(() => [{ n: 0 }]))[0].n) || 0,
    },
    version: await (async () => { try { return (await (await import('../routes/systemUpdate.js')).getInstalled()).short || null } catch { return null } })(),
    plan: await (async () => { try { return (await import('./plans.js')).planOf() } catch { return null } })(),
    // Admin warns too: no good backup for 48 h, the licence ending (7 d, 3 d, 1 d, 12 h).
    safety: await (async () => { try { return await (await import('../routes/replica.js')).safetyPayload() } catch { return null } })(),
  }
}

// A change on this PC (anyone's: the PC, a phone, Admin): the answers it
// touches go online within a second, and the phones are told which ones
// changed (live link) — they keep their own copy of every answer.
const soonKeys = new Set()
let vaultSoon = false
const soonAt = new Map()   // key → when a change of it went online (the minute's copy must not undo it)
let soonTimer = null
/** These answers only, online within a second (the "needs you" list as it changes). */
export function pushKeysSoon(db, keys) {
  keys.forEach(k => soonKeys.add(k))
  clearTimeout(soonTimer)
  soonTimer = setTimeout(() => pushKeys(db).catch(e => console.warn('[cloud] soon:', e.message)), 600)
}
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
    // A new "needs you" is online: Firebase wakes the phones at once (the
    // phones' own look every minute stays as the fallback).
    const calls = group.find(x => x.r.key === '/automations/attention')
    if (calls && !isFollower()) import('./fcmPush.js').then(f => f.attentionOnline(db, calls.r.data)).catch(e => console.warn('[push]', e.message))
  }
}

// Every answer of every profile is rebuilt only every FULL_MS (a safety net):
// each minute, the agency's pages and only the profiles that changed lately.
// (Changes made through the app go online at once anyway — pushSoon.) On a
// small office PC the full sweep was ~1,300 requests a minute.
// The full sweep only catches what a change somehow missed: every 6 hours,
// paced (an old PC stays free), and NOT again at each start — when it was
// done, and the last sweep, are kept (cloud_sync "sweep:full" / "sweep:at"),
// so a start only reads the profiles changed since. It was every 30 minutes
// and at every start: ~1,800 reads at once, a busy PC for a minute or two.
const FULL_MS = 6 * 3600 * 1000
const PACE_MS = 60
let lastFullAt = 0, lastSweepAt = 0, lastDiagAt = 0, lastUsageAt = 0

/** Profiles touched since `since` (runs, documents, CVs, tasks, the profile itself). */
async function changedProfiles(db, since) {
  // SQLite keeps both "2026-10-29 08:40:12" and ISO times: compare against the
  // older-sorting space form, so nothing is missed (a few extra at most).
  const at = since.toISOString().replace('T', ' ').slice(0, 19)
  const ids = new Set()
  const add = (rows) => rows.forEach(r => r.id != null && ids.add(Number(r.id)))
  const q = (fn) => fn().catch(() => [])
  add(await q(() => db('profiles').where('updated_at', '>=', at).select('id')))
  for (const t of ['automation_queue', 'profile_automations', 'profile_fields', 'tasks', 'generated_cvs', 'document_verifications']) {
    add(await q(() => db(t).where('updated_at', '>=', at).whereNotNull('profile_id').distinct('profile_id as id')))
  }
  add(await q(() => db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('files.created_at', '>=', at).distinct('profile_fields.profile_id as id')))
  return [...ids]
}

async function pushAnswers(db, agency, state, { light = false } = {}) {
  const started = Date.now()
  if (!lastFullAt) lastFullAt = Number(state.get(TEXT_DONE) || 0)
  if (!lastSweepAt) lastSweepAt = Number(state.get('sweep:at') || 0)
  const first = !lastFullAt        // nothing went online yet (a new PC or a new online account)
  cloudStatus.textDone = !first
  const full = (first || !light) && (!lastFullAt || started - lastFullAt >= FULL_MS)
  const ids = full
    ? (await db('profiles').select('id')).map(r => r.id)
    : await changedProfiles(db, new Date((lastSweepAt || started) - 3 * 60000))
  const brokers = (await db('brokers').select('id').catch(() => [])).map(r => r.id)
  // Each template, and its header and footer pictures (the phone draws CVs with the PC off).
  const templates = (await db('cv_templates').select('id').catch(() => [])).flatMap(r => [`/cv/templates/${r.id}`, `/cv/templates/${r.id}/banners`])
  // The first copy: the agency's lists, then every profile and its documents
  // list (enough to open her), then the rest — so a Companion can work after
  // minutes, not hours.
  const keys = first
    ? [...new Set([...GLOBAL, ...ids.flatMap(id => [`/profiles/${id}`, `/profiles/${id}/fields`]), ...brokers.flatMap(PER_BROKER), ...ids.flatMap(PER_PROFILE), ...templates])]
    : [...GLOBAL, ...ids.flatMap(PER_PROFILE), ...brokers.flatMap(PER_BROKER), ...templates]
  if (first) console.log(`[cloud] first copy of the text: ${keys.length} pages (${ids.length} profiles) before any document`)
  await pushVault(db, agency, state).catch(e => console.warn('[cloud] vault:', e.message))
  await pushVaultKey(db, agency, state).catch(e => console.warn('[cloud] vault key:', e.message))
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
  let done = 0
  for (const key of keys) {
    // (The first copy goes as fast as the PC answers; later sweeps leave the PC room.)
    if (full && !first) await new Promise(res => setTimeout(res, PACE_MS))
    if (first && ++done % 200 === 0) console.log(`[cloud] first copy: ${done} of ${keys.length} pages`)
    let r
    try { r = await local('GET', key) } catch { continue }
    if (!r.ok) continue
    const text = await r.text()
    let data
    try { data = clean(key, JSON.parse(text)) } catch { continue }
    const body = JSON.stringify(data)
    const hash = sha(body)
    // The full sweep sends the agency's own pages (the dashboard, the lists…)
    // even when this PC thinks they are online already: what it remembers and
    // what is online can part (the dashboard stayed a day behind its list).
    if (state.get(key) === hash && !(full && GLOBAL.includes(key))) continue
    batch.push({ row: { agency_id: agency, key, data, updated_at: new Date().toISOString() }, hash, readAt: Date.now() })
    // The list of profiles goes at once: a Companion opens with it.
    if (batch.length >= 20 || key === '/profiles') await flush()
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
  lastSweepAt = started
  await setState(db, 'sweep:at', String(started)).catch(() => {})
  if (!full) return
  lastFullAt = started
  await setState(db, TEXT_DONE, String(started)).catch(() => {})
  if (first) {
    cloudStatus.textDone = true
    console.log(`[cloud] first copy of the text done in ${Math.round((Date.now() - started) / 1000)} s — the documents go now, smallest first`)
  }
  // Profiles that are gone: their answers go too.
  for (const key of state.keys()) {
    if (!key.startsWith('/') || wanted.has(key) || key === '/_summary' || key === '/vault') continue
    await cloudCall(db, 'DELETE', `/rest/v1/keep_meta?agency_id=eq.${agency}&key=eq.${encodeURIComponent(key)}`, undefined, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
    await db('cloud_sync').where({ key }).del()
  }
}

/** The version this PC runs: the updater's mark (installed PCs) or git (a developer's copy). */
function installedVersion() {
  const back = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
  for (const root of [path.join(back, '..'), back]) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, '.adal-version.json'), 'utf8'))
      if (m.sha) return { sha: String(m.sha).slice(0, 7), source: m.source || 'github', at: m.savedAt || null, rolled_back_from: m.rolledBackFrom ? String(m.rolledBackFrom).slice(0, 7) : null }
    } catch {}
    try {
      let head = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8').trim()
      if (head.startsWith('ref: ')) head = fs.readFileSync(path.join(root, '.git', head.slice(5)), 'utf8').trim()
      if (/^[0-9a-f]{40}$/.test(head)) return { sha: head.slice(0, 7), source: 'git' }
    } catch {}
  }
  return null
}

// ------------------------------------------------------------ secrets
/** The agency's file key, live channel name and storage bot (made once). */
let secretsCache = null
export async function agencySecrets(db, agency) {
  if (secretsCache?.agency_id === agency && secretsCache.bot === (process.env.TELEGRAM_BOT_TOKEN || null)) return secretsCache
  let [row] = await cloudCall(db, 'GET', `/rest/v1/keep_secrets?agency_id=eq.${agency}&select=agency_id,file_key,live,bot`)
  const bot = process.env.TELEGRAM_BOT_TOKEN || null
  // The documents' key is kept on this PC too (locked, with the agency's other
  // secrets): so it is in every Telegram backup and on every Companion as well.
  // Never a new one while a kept one exists — every document online is locked with it.
  const { keptFileKey, keepFileKey } = await import('./keySafe.js')
  const kept = keptFileKey(agency)
  if (!row) {
    row = { agency_id: agency, file_key: kept || crypto.randomBytes(32).toString('base64'), live: crypto.randomBytes(18).toString('base64url'), bot }
    if (kept) console.log('[cloud] the documents key was missing online — put back from this PC\'s copy')
    await cloudCall(db, 'POST', '/rest/v1/keep_secrets', row, { headers: { Prefer: 'return=minimal' } })
  }
  if (row.file_key) keepFileKey(agency, row.file_key)
  if (row.bot !== bot) {
    await cloudCall(db, 'PATCH', `/rest/v1/keep_secrets?agency_id=eq.${agency}`, { bot }, { headers: { Prefer: 'return=minimal' } })
    row.bot = bot
  }
  secretsCache = row
  return row
}

// ------------------------------------------------------------ 3. documents
// One at a time (the round and a new upload must not send the same document twice).
let filesRun = null
let tgDownUntil = 0   // Telegram did not answer: tried again after this
let moreFilesSoon = false   // documents were left at the end of a round: the next one starts at once
function pushFiles(db, agency, state) {
  return (filesRun ||= pushFilesNow(db, agency, state).finally(() => { filesRun = null }))
}
/** Waits while the user uploads (services/userUploads.js); shown in the status meanwhile. */
async function waitForUploads() {
  await waitForQuiet({ onWait: () => { cloudStatus.waitingForUploads = true; console.log('[cloud] the user is uploading — the online copy waits') } })
  cloudStatus.waitingForUploads = false
}
async function pushFilesNow(db, agency, state) {
  // The text first: no document goes before every page went online once.
  if (!state.get(TEXT_DONE)) { cloudStatus.filesLeft = -1; return }
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
  // Smallest first: hundreds of light documents are online before one big scan.
  const todo = rows.filter(f => state.get(`file:${f.id}`) !== `${f.size}|${f.updated_at}`)
    .sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0) || a.id - b.id)
  cloudStatus.filesLeft = todo.length
  const until = Date.now() + FILES_ROUND_MS
  let stop = false
  const one = async (f) => {
    const sig = `${f.size}|${f.updated_at}`
    try {
      if (Number(f.size) > LIMIT) { await setState(db, `file:${f.id}`, sig); return }
      const r = await local('GET', `/files/${f.id}/download`)
      if (!r.ok) { await setState(db, `file:${f.id}`, sig); return }   // not on disk: nothing to copy
      // The light copy goes online; the original stays on this PC.
      const original = Buffer.from(await r.arrayBuffer())
      const light = await viewCopy(original, f.mimetype, f.original_name)
      const buf = light.buf
      if (light.small) cloudStatus.bytesSaved += original.length - buf.length
      let safe = String(f.original_name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80)
      if (light.small && light.mimetype === 'image/jpeg') safe = safe.replace(/\.(png|webp|heic|heif|tiff?|bmp|jpe?g)$/i, '') + '.jpg'
      const [old] = await cloudCall(db, 'GET', `/rest/v1/keep_files?agency_id=eq.${agency}&id=eq.${f.id}&select=object`).catch(() => []) || []
      let object = null, waiting = false
      // Telegram first; blocked or down (it happens on some lines), the
      // document is kept in the online storage meanwhile and moved to
      // Telegram once it answers — never only on this PC.
      if (tg && Date.now() > tgDownUntil) {
        try { object = await tgPut(buf, `${f.id}-${safe}`, secret.file_key) }
        catch (e) {
          if (!/fetch failed|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|aborted|timeout|socket/i.test(String(e?.message || e))) throw e
          tgDownUntil = Date.now() + 10 * 60000
          console.warn('[cloud] Telegram does not answer — documents go to the online storage until it does (again in 10 minutes)')
        }
      }
      if (!object) {
        if (tg && old?.object && !old.object.startsWith('tg:')) return   // already kept online, waiting for Telegram
        object = `${agency}/${f.profile_id}/${f.id}-${safe}`
        await cloudCall(db, 'POST', `/storage/v1/object/keep/${object}`, buf,
          { headers: { 'Content-Type': light.mimetype || 'application/octet-stream', 'x-upsert': 'true' } })
        waiting = !!tg
      }
      // The older copy (Supabase storage, or an older Telegram post) goes.
      if (old?.object && old.object !== object) {
        if (old.object.startsWith('tg:')) await tgDelete(old.object)
        else await cloudCall(db, 'DELETE', `/storage/v1/object/keep/${old.object}`).catch(() => {})
      }
      await upsert(db, 'keep_files', [{
        agency_id: agency, id: f.id, profile_id: f.profile_id, field: f.field, name: f.original_name,
        mimetype: light.mimetype, size: buf.length, object, created_at: f.created_at || null, updated_at: new Date().toISOString(), deleted: false,
      }], 'agency_id,id')
      // Kept online while Telegram is down: looked at again (moved to Telegram) once it answers.
      await setState(db, `file:${f.id}`, waiting ? `${sig}|waiting` : sig)
      cloudStatus.files++
      cloudStatus.filesLeft--
    } catch (e) {
      console.warn(`[cloud] file ${f.id} (${f.original_name}): ${e.message}`)
      if (/exceeded|quota|too large|payload/i.test(e.message)) stop = true
    }
  }
  // Two at a time (a slow line waits on each answer), for up to 50 s.
  let next = 0
  // (One at a time while a robot works: it needs the line for its own uploads.)
  await Promise.all(Array.from({ length: runsWorking() > 0 ? 1 : FILES_AT_ONCE }, async () => {
    while (!stop && next < todo.length && Date.now() < until) {
      await waitForUploads()   // the user's own upload first; this document goes right after
      if (next < todo.length) await one(todo[next++])
    }
  }))
  if (todo.length && next >= todo.length) console.log(`[cloud] every document is online (${Math.round(cloudStatus.bytesSaved / 1048576)} MB saved by light copies)`)
  else if (todo.length) moreFilesSoon = true
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
async function syncOnce(db, { light = false } = {}) {
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
      // (What this PC remembered of the old copy goes too: it used to send only
      // the changed profiles, so the new copy stayed nearly empty for hours.)
      lastFullAt = 0; lastSweepAt = 0
    }
    // Listed as an agency (name + PC number) for Adal Keep Admin, chat or not.
    if (!joined) { await joinAgency(db).then(() => { joined = true }).catch(e => console.warn('[cloud] agency:', e.message)) }
    await publishPC(db).catch(e => console.warn('[cloud] PC number:', e.message))
    const applied = await applyChanges(db, agency)
    const state = await stateOf(db)
    // Someone is uploading files into Adal Keep: the copy waits until about 30 s after the last one (nothing skipped).
    await waitForUploads()
    await pushAnswers(db, agency, state, { light })
    // Documents too, every round (also while a robot works): every one is kept
    // in Telegram as well as on this PC as soon as it can be.
    await pushFiles(db, agency, await stateOf(db))
    if (moreFilesSoon) { moreFilesSoon = false; filesSoon(db) }
    // This PC's health and last errors, for Adal (every 5 minutes).
    if (Date.now() - lastDiagAt >= 5 * 60000) {
      lastDiagAt = Date.now()
      try {
        const { healthReport } = await import('./diag.js')
        const data = await healthReport(db, installedVersion())
        await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_diag', data, updated_at: data.at }], 'agency_id,key')
      } catch (e) { console.warn('[cloud] health:', e.message) }
    }
    // How much each feature is used, for Adal Keep Admin → Usage (every 30 minutes; only counts).
    if (Date.now() - lastUsageAt >= 30 * 60000) {
      lastUsageAt = Date.now()
      try {
        const { usageReport } = await import('./featureUse.js')
        const data = await usageReport(db)
        await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_usage', data, updated_at: data.at }], 'agency_id,key')
      } catch (e) { console.warn('[cloud] usage:', e.message) }
    }
    cloudStatus.error = null
    cloudStatus.last = new Date().toISOString()
    if (applied) setTimeout(() => syncOnce(db).catch(() => {}), 3000)   // show the phone its own change soon
  } catch (e) {
    cloudStatus.error = /keep_(meta|changes|files|devices)|relation|schema cache|PGRST/i.test(e.message)
      ? 'The online tables are missing: run adal-admin/supabase/keep-sync.sql in Supabase (SQL Editor).'
      : e.message
    cloudStatus.lastFail = cloudStatus.error; cloudStatus.lastFailAt = new Date().toISOString()   // Settings → Health
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
// A document was added or changed (an upload on any PC or phone, a robot's
// PDF): it goes to Telegram within seconds — not at the next round.
let filesSoonTimer = null, filesBusy = null
function filesSoon(db) {
  clearTimeout(filesSoonTimer)
  filesSoonTimer = setTimeout(async () => {
    if (filesBusy) { filesSoon(db); return }
    filesBusy = (async () => {
      if (!(await cloudOn(db).catch(() => false))) return
      const agency = await cloudAgencyId(db)
      if (agency) await pushFiles(db, agency, await stateOf(db))
    })().then(() => { if (moreFilesSoon) { moreFilesSoon = false; filesSoon(db) } }).catch(e => console.warn('[cloud] documents:', e.message)).finally(() => { filesBusy = null })
  }, 3000)
}

export function startCloudSync(db) {
  if (timer) return
  import('./changes.js').then(c => c.onChanged(({ tables }) => {
    if (tables.includes('files')) filesSoon(db)
    // A run paused for a person (or went on): the "needs you" list online at once.
    if (tables.includes('automation_queue')) pushKeysSoon(db, ['/automations/attention'])
  })).catch(() => {})
  import('./attention.js').then(a => a.onAttentionChange(() => pushKeysSoon(db, ['/automations/attention']))).catch(() => {})
  const tick = async () => {
    cloudStatus.on = await cloudOn(db).catch(() => false)
    // A move from another system is working: the copy catches up when it is done.
    // A robot working: a light round (the changed profiles only) —
    // the phones must never fall hours behind because the robots work all day.
    const { transitionRunning } = await import('./transition.js')
    if (cloudStatus.on && !transitionRunning()) await syncOnce(db, { light: runsWorking() > 0 })
  }
  setTimeout(tick, 45000)
  timer = setInterval(tick, EVERY_MS)
  startRelay(db)
  watchStorageChat()
  // A phone asking to join is seen within 10 s (it was every 4 s: ~21,000 internet calls a day).
  setTimeout(() => setInterval(() => watchJoins(db), 10000), 15000)
  console.log('☁️  Online copy for phones: what changed every minute, everything every 30 minutes (when on)')
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
  namesAt = 0   // the relay reads who is suspended again at its next call
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
let relayTimer = null, lastBeat = 0, lastClean = 0, deviceNames = new Map(), suspendedDevices = new Set(), namesAt = 0

async function answerCall(db, agency, c) {
  let patch = { status: 'done', answered_at: new Date().toISOString() }
  try {
    // A phone's call is late after 30 s (it gave up waiting). Adal's commands
    // wait online until this PC is on (up to 30 days), then run.
    const age = Date.now() - new Date(c.created_at).getTime()
    if (age > RELAY_LATE_MS && !(age < 30 * 86400000 && await fromAdal(db, c.device_id))) { patch.status = 'late'; return }
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
  if (!adalId) {
    const { agencies } = await import('./chatCloud.js')
    adalId = ((await agencies(db).catch(() => [])) || []).find(a => a.is_admin)?.id || null
  }
  return !!id && !!adalId && id === adalId
}
// What Adal can do on an agency's PC, from Admin: back up now, restore the
// newest backup here (its own, or another agency PC's — a replaced PC).
export const adalJob = { kind: null, running: false, result: null, error: null, at: null }
async function adalCommand(db, method, p, body) {
  // Admin saved this PC's licence (paid days, allowed, suspended): read it now.
  // The command only says "look"; the licence counts only if Adal signed it.
  if (p === '/_adal/license') {
    const P = await import('./plans.js')
    await P.licenseNudge()
    const S = await import('./subscription.js')
    const st = S.statusPayload()
    return { mode: st.mode, suspended: st.suspended, paidUntil: st.paidUntil, at: P.licenseNow()?.at || null }
  }
  // Before the backup's "busy": neither of these waits for a backup.
  if (p === '/_adal/company') {
    await db('companies').update({ owner_name: String(body.name || '').trim() || null, phone2: String(body.phone || '').trim() || null })
    return { ok: true }
  }
  if (p.startsWith('/_adal/agents/')) {
    const W = await import('./whatsapp.js')
    if (p === '/_adal/agents/give') return { agents: await W.giveAgent(db, body), limit: await W.agentLimit(db) }
    if (p === '/_adal/agents/take') return { agents: await W.takeAgent(db, body.number), limit: await W.agentLimit(db) }
    if (p === '/_adal/agents/limit') return { agents: await W.agentList(db), limit: await W.setAgentLimit(db, body.limit) }
    if (p === '/_adal/agents/template') return { id: await W.giveTemplate(db, body.template) }
  }
  const B = await import('./telegramBackup.js')
  if (p === '/_adal/backup' && method === 'GET') return { ...B.getConfig(), progress: B.progress, job: adalJob }
  if (adalJob.running || B.progress.running) {
    if (p === '/_adal/backup/run') B.backupSoon()   // Admin never waits: it follows the one going, by itself
    return { busy: true, queued: p === '/_adal/backup/run', job: adalJob, progress: B.progress }
  }
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
    if (Date.now() - namesAt > 60000) {
      const rows = (await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&select=user_id,name,revoked`)) || []
      deviceNames = new Map(rows.map(d => [d.user_id, d.name]))
      suspendedDevices = new Set(rows.filter(d => d.revoked).map(d => d.user_id))
      namesAt = Date.now()
    }
    // Suspended on this PC (Settings → Connected devices): a call it sent before is not answered either.
    if (suspendedDevices.has(c.device_id)) throw Object.assign(new Error('This device was suspended by the main PC'), { code: 403 })
    if (!allowedFrom(deviceNames.get(c.device_id), method, p)) throw Object.assign(new Error('Not from a phone: do this on the main PC.'), { code: 403 })
    const who = whoHeaders(deviceNames, c.device_id)
    // An upload from a phone while the PC is on: done now, with the PC's real answer.
    const up = method === 'POST' && c.body?.__upload
    // A new profile carries the phone's own number for her: made once only, even
    // when the phone (on a slow line) also queued her for later.
    const phoneRef = method === 'POST' && /^\/(profiles|new-profile\/with-passport)$/.test(p.split('?')[0])
      ? Number(up ? c.body.__upload.form?.phone_ref : c.body?.phone_ref) || 0 : 0
    const already = phoneRef < 0 && (await db('cloud_sync').where({ key: `ref:profile:${phoneRef}` }).first('hash').catch(() => null))?.hash
    const r = already
      ? new Response(JSON.stringify({ id: Number(already), success: true }), { status: 200, headers: { 'content-type': 'application/json' } })
      : up
      ? await local('POST', p, { body: await formOf(db, c.body.__upload), headers: who })
      : await local(method, p, { body: method === 'GET' ? undefined : (c.body ?? undefined), headers: who })
    if (phoneRef < 0 && !already && r.ok) {
      const m = await r.clone().json().catch(() => null)
      const id = m?.id || m?.profile?.id
      if (id) { await setState(db, `ref:profile:${phoneRef}`, String(id)); await pushRefs(db, agency).catch(() => {}) }
    }
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
    await upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_pc', data: beatData(), updated_at: new Date().toISOString() }], 'agency_id,key')
    lastBeat = Date.now()
  }
  // A phone is busy: its uploads are filed at once too, not at the next minute.
  if (Date.now() - relayStatus.lastCall < 3 * 60000) await Promise.race([applyChanges(db, agency).catch(() => {}), new Promise(r => setTimeout(r, 30000))])
  const todo = (calls || []).filter(c => !working.has(c.id))
  if (todo.length) relayStatus.lastCall = Date.now()
  // One slow call (a passport being read, a big file) never holds the others:
  // the loop goes on after 20 s, and the slow one answers when it is done.
  const all = Promise.all(todo.map(async c => {
    working.add(c.id)
    try { await answerCall(db, agency, c) } catch {} finally { setTimeout(() => working.delete(c.id), 10000) }
  }))
  await Promise.race([all, new Promise(r => setTimeout(r, 20000))])
  if (Date.now() - lastClean > 5 * 60000) {
    lastClean = Date.now()
    const old = new Date(Date.now() - 10 * 60000).toISOString()
    // Not Adal's commands still waiting to run.
    await fromAdal(db, null).catch(() => {})
    const keepAdal = adalId ? `&or=(status.neq.new,device_id.neq.${adalId})` : ''
    await cloudCall(db, 'DELETE', `/rest/v1/keep_calls?agency_id=eq.${agency}&created_at=lt.${old}${keepAdal}`, undefined, { headers: { Prefer: 'return=minimal' } }).catch(() => {})
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
  // "The PC is on" on its own clock: every 15 s whatever the loop above is
  // waiting for (a slow call, phone changes on a slow line), so Adal Keep Admin
  // and the phones never see this PC as off while it works. Admin calls a PC off
  // after 60 s without this.
  let beating = false
  setInterval(async () => {
    if (beating || !relayStatus.on || Date.now() - lastBeat < 14000) return
    beating = true
    try {
      const agency = await cloudAgencyId(db)
      if (agency) {
        await Promise.race([
          upsert(db, 'keep_meta', [{ agency_id: agency, key: '/_pc', data: beatData(), updated_at: new Date().toISOString() }], 'agency_id,key'),
          new Promise((_, no) => setTimeout(() => no(new Error('slow')), 12000)),
        ])
        lastBeat = Date.now()
      }
    } catch {} finally { beating = false }
  }, 5000).unref?.()
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
// Someone is using Adal Keep on this PC now: its open page asks for the join
// requests every few seconds (routes/mobile.js marks it; a hidden or locked page does not ask).
export const joinPresence = { at: 0, who: '' }
const someoneHere = () => Date.now() - joinPresence.at < 20000
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
      // Nobody at this PC to say Yes: it lets its own phone or Companion in by
      // itself (asked on 2026-11-18). Someone here: they get the question.
      if (!someoneHere()) {
        try {
          await answerJoin(db, r.id, true)
          console.log(`[cloud] "${r.name}" typed this PC's number, nobody at the PC: let in`)
          continue
        } catch (e) { console.warn(`[cloud] "${r.name}" could not be let in: ${e.message}`) }
      }
      if (announced.has(r.id)) continue
      announced.add(r.id)
      console.log(`[cloud] phone "${r.name}" asks to join${joinPresence.who ? ` — ${joinPresence.who} is at the PC` : ''}`)
      try {
        ;(await import('./worker.js')).beep()
      } catch {}
    }
  } catch (e) { joinRequests.error = e.message }
}
export async function answerJoin(db, id, ok) {
  await cloudCall(db, 'POST', '/rest/v1/rpc/keep_answer_join', { p_id: id, p_ok: !!ok })
  joinRequests.list = joinRequests.list.filter(r => r.id !== id)
}
