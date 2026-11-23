/**
 * One settings record per agency, kept in Supabase (agency_config, made by
 * adal-admin/supabase/agency-config.sql) and edited in Adal Keep Admin → Setup.
 * Every PC of the agency pulls it (every 10 minutes, and when Admin nudges),
 * keeps the last good copy in data/agency-config.json, and works from that
 * when offline. A feature is a switch in the record, not a release.
 *
 * The record holds: agency_email, lmis_sms_number, epro_signature (a file in
 * the private bucket agency-config), cv_templates (which ones are on),
 * staff_roles (name + toggles), features (switches) and a licence summary.
 * The summary is only shown: the signed licence (plans.js) alone decides what
 * is paid, trial or locked.
 *
 * Everything here is behind a flag: nothing is pulled or applied unless
 * ADAL_FLAG_AGENCY_CONFIG=1 (or data/flags.json has {"agency_config": true}).
 * Likewise the first-run sign-up (flag "agency_signup").
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(HERE, '..', '..', 'data')
const CACHE = () => process.env.ADAL_AGENCY_CONFIG_CACHE || path.join(DATA, 'agency-config.json')
const FLAGS_FILE = () => process.env.ADAL_FLAGS_FILE || path.join(DATA, 'flags.json')

/** Switches that live on this PC (they must work before there is any record). */
export function localFlag(name) {
  const env = process.env[`ADAL_FLAG_${String(name).toUpperCase()}`]
  if (env === '1' || env === 'true') return true
  if (env === '0' || env === 'false') return false
  try { return JSON.parse(fs.readFileSync(FLAGS_FILE(), 'utf8'))?.[name] === true } catch { return false }
}

/** The switches Adal can flip per agency. `on`: what an agency gets before Adal says anything. */
export const FEATURE_SWITCHES = [
  { key: 'agency_signup', title: 'First-run sign-up', on: false },
  { key: 'remote_setup', title: 'Remote setup from Admin', on: false },
  { key: 'new_dashboard', title: 'New dashboard (pitch preview)', on: false },
  // Every PC on its own full copy, working with the main PC off (docs/companion-full.md). Not yet run on Windows.
  { key: 'companion_full', title: 'Companions keep a full copy (work with Main off)', on: false },
]
const PERMS = ['delete_profiles', 'edit_templates', 'run_robots', 'change_settings', 'manage_staff', 'export_backup']
const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null)

/** A record from Supabase (or from Admin's form) → only the fields we know, each cleaned. */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const features = {}
  for (const f of FEATURE_SWITCHES) if (typeof c.features?.[f.key] === 'boolean') features[f.key] = c.features[f.key]
  const email = str(c.agency_email, 160)
  return {
    agency_email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    lmis_sms_number: str(String(c.lmis_sms_number ?? '').replace(/[^\d+]/g, ''), 20),
    epro_signature: c.epro_signature?.path ? { path: str(c.epro_signature.path, 300), name: str(c.epro_signature.name, 120) || 'signed-contract.pdf' } : null,
    cv_templates: (Array.isArray(c.cv_templates) ? c.cv_templates : []).slice(0, 50)
      .map(t => ({ key: str(t?.key, 60), name: str(t?.name, 80), enabled: t?.enabled !== false })).filter(t => t.key),
    staff_roles: (Array.isArray(c.staff_roles) ? c.staff_roles : []).slice(0, 20)
      .map(r => ({ name: str(r?.name, 60), perms: Object.fromEntries(PERMS.map(k => [k, r?.perms?.[k] === true])) })).filter(r => r.name),
    features,
    licence: c.licence && typeof c.licence === 'object' ? { plan: str(c.licence.plan, 20), paid_until: str(c.licence.paid_until, 40), trial_ends: str(c.licence.trial_ends, 40) } : null,
  }
}

let current = null          // { version, updated_at, config }
let pulledAt = 0
export const configNow = () => current

function readCache() {
  try { const j = JSON.parse(fs.readFileSync(CACHE(), 'utf8')); current = { version: j.version || 0, updated_at: j.updated_at || null, config: normalizeConfig(j.config) } } catch { current = current || null }
  return current
}
function writeCache(rec) {
  fs.mkdirSync(path.dirname(CACHE()), { recursive: true })
  fs.writeFileSync(CACHE(), JSON.stringify(rec))
}

/** Is a feature on for this agency? Adal's switch first, then the default. Nothing is on without the master flag. */
export function featureOn(key) {
  if (!localFlag('agency_config')) return false
  if (!current) readCache()
  const set = current?.config?.features?.[key]
  if (typeof set === 'boolean') return set
  return FEATURE_SWITCHES.find(f => f.key === key)?.on === true
}

async function setSetting(db, key, value) {
  const row = await db('settings').where({ key }).first()
  if (row) { if (row.value !== value) await db('settings').where({ key }).update({ value }) }
  else await db('settings').insert({ key, value })
}

/** Puts a record's values where the app already reads them. Only fields Adal filled in. */
export async function applyConfig(db, config, { saveFile } = {}) {
  const done = []
  if (config.agency_email) { await setSetting(db, 'agency_email', config.agency_email); done.push('agency_email') }
  if (config.lmis_sms_number) { await setSetting(db, 'lmis_sms_number', config.lmis_sms_number); done.push('lmis_sms_number') }
  await setSetting(db, 'agency_features', JSON.stringify(config.features))
  if (config.staff_roles.length && await db.schema.hasTable('staff_roles').catch(() => false)) {
    for (const r of config.staff_roles) {
      const row = await db('staff_roles').where({ name: r.name }).first()
      if (row) await db('staff_roles').where({ id: row.id }).update({ perms: JSON.stringify(r.perms) })
      else await db('staff_roles').insert({ name: r.name, preset: null, perms: JSON.stringify(r.perms) })
    }
    done.push('staff_roles')
  }
  if (config.epro_signature && saveFile) { await saveFile(config.epro_signature); done.push('epro_signature') }
  return done
}

/**
 * Pulls the record. `ask(method, path, opts)` is the signed-in Supabase call (chatCloud.cloudCall with the db).
 * A newer version is applied and cached; the same version only refreshes the clock. Offline → the cache stays.
 */
export async function pullAgencyConfig(db, ask, agencyId, { force = false } = {}) {
  if (!force && !localFlag('agency_config')) return { skipped: 'flag off' }
  if (!current) readCache()
  try {
    const rows = await ask('GET', `/rest/v1/agency_config?agency_id=eq.${encodeURIComponent(agencyId)}&select=config,version,updated_at`)
    pulledAt = Date.now()
    const row = rows?.[0]
    if (!row) return { none: true }
    if (current && current.version === row.version && current.updated_at === row.updated_at) return { same: true, version: row.version }
    const config = normalizeConfig(row.config)
    const saveFile = async (f) => {
      const res = await ask('GET', `/storage/v1/object/agency-config/${f.path}`, { raw: true })
      if (!res.ok) throw new Error(`EPRO signature download: ${res.status}`)
      const { saveEproSignature } = await import('./eproSignature.js')
      saveEproSignature(Buffer.from(await res.arrayBuffer()), f.name)
    }
    const applied = await applyConfig(db, config, { saveFile: (f) => saveFile(f).catch(e => console.warn('[config]', e.message)) })
    current = { version: row.version, updated_at: row.updated_at, config }
    writeCache(current)
    return { version: row.version, applied }
  } catch (e) {
    return { error: e.message, offline: true, version: current?.version ?? null }
  }
}

export const configStatus = () => ({ flag: localFlag('agency_config'), signupFlag: localFlag('agency_signup'), version: current?.version ?? null, updated_at: current?.updated_at ?? null, pulledAt: pulledAt || null, config: current?.config ?? null })

// ------------------------------------------------------------------ sign-up --
const PHONE_RE = /^\+?[\d\s-]{7,20}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export function cleanSignup(b) {
  const name = String(b?.name ?? '').trim(), phone = String(b?.phone ?? '').trim(), email = String(b?.email ?? '').trim()
  if (!name) return { error: 'Agency name is needed' }
  if (!PHONE_RE.test(phone)) return { error: 'Phone number is not right' }
  if (!EMAIL_RE.test(email)) return { error: 'E-mail is not right' }
  return { name: name.slice(0, 120), phone: phone.slice(0, 30), email: email.slice(0, 160) }
}

/** Where this agency stands: nothing yet, new (waiting for setup), setup, or ready. Local note kept in settings. */
export async function signupState(db, ask, agencyId) {
  const local = await db('settings').where({ key: 'signup_sent' }).first().catch(() => null)
  if (!local) return { status: 'none' }
  try {
    const r = (await ask('GET', `/rest/v1/agency_signups?agency_id=eq.${encodeURIComponent(agencyId)}&select=name,status,ready_at,created_at`))?.[0]
    if (r) { await setSetting(db, 'signup_status', r.status); return { status: r.status, ready_at: r.ready_at, name: r.name } }
  } catch {}
  const s = await db('settings').where({ key: 'signup_status' }).first().catch(() => null)
  return { status: s?.value || 'new', offline: true }
}

export async function sendSignup(db, ask, input, pc) {
  const c = cleanSignup(input)
  if (c.error) return c
  await ask('POST', '/rest/v1/rpc/agency_sign_up', { p_name: c.name, p_phone: c.phone, p_email: c.email, p_pc: pc || null })
  await setSetting(db, 'signup_sent', new Date().toISOString())
  await setSetting(db, 'signup_status', 'new')
  if (!(await db('settings').where({ key: 'agency_email' }).first())) await setSetting(db, 'agency_email', c.email)
  return { ok: true, status: 'new' }
}

/** Every 10 minutes (and 30 s after start). */
export function startAgencyConfigWatch(db, ask, agencyIdOf) {
  const go = async () => { try { const id = await agencyIdOf(); if (id) await pullAgencyConfig(db, ask, id) } catch {} }
  setTimeout(go, 30000).unref?.()
  setInterval(go, 10 * 60000).unref?.()
}
