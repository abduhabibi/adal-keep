/**
 * Plans and features (asked for on 2026-11-09).
 *
 *   Basic     29,999 ETB / 6 months — the office work
 *   Standard  39,999 ETB / 6 months — + the Musaned and Wafid robots, WhatsApp, moves
 *   Premium   49,999 ETB / 6 months — + Enjaz visa, insurance, AI reading; new
 *             features first, support first, one more week of training
 *
 * Each agency's licence is a file Adal signs in the admin panel (adal-admin) —
 * adal-updates/licenses/<PC number>.json — with the same Ed25519 key as the
 * updates, so only Adal can make one: its plan, its paid / trial dates, and
 * features turned on or off for that agency alone, or offered to it (the
 * agency answers "I want it"; Adal turns it on when Adal wants).
 *
 * The PC reads it when it starts and every 45 seconds, checks the signature,
 * and keeps the last good one (data/license.json), so it works offline too.
 * Adal Keep Admin also nudges the PC the moment it saves a licence (a Realtime
 * message on the PC's live channel, and an Adal command in keep_calls that
 * waits online while the PC is off): the PC reads its licence again at once.
 * The nudge carries nothing: only the signed licence counts.
 *
 * Suspended (Admin → Suspend): the licence says `suspended`; Adal Keep on
 * that PC stops (the lock screen says "suspended") until Admin allows it
 * again. Nothing is deleted. A code from the Authenticator does not lift it.
 * Since 2026-11-25 this is the ONLY thing that locks an Adal Keep (owner:
 * "never lock a device until I clicked lock"), besides the main PC cutting a PC
 * off. The signed file is kept twice (data/ and outside the install folder) and
 * the newest signed one counts, so an older copy or an edited one opens nothing.
 * A Companion gets the main PC's signed file through the copying (roles.js) and
 * keeps it the same way: it stays locked with the main PC off.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { canonical, verifyManifest, BUCKET } from './updateChannel.js'

// One plan since 2026-11-23: Premium, everything in it (49,999 ETB / 6 months, 89,999 / 12; billing.js).
// Licences that say basic / standard are read as Premium.
export const PLANS = [
  { key: 'premium', name: 'Premium', price: 49999, training_days: 14, rank: 3, extras: ['Everything in Adal Keep', 'Support first', 'One more week of training'] },
]
const RANK = { basic: 1, standard: 2, premium: 3 }   // (features still name the smallest plan that had them; every agency is Premium now)

/**
 * What can be turned on or off. `plan`: the smallest plan that has it.
 * `workflows`: the robots it covers. Anything not listed here is in every plan.
 */
export const FEATURES = [
  { key: 'musaned_robots', title: 'Musaned robots', plan: 'standard', about: 'Add a candidate, import her CV, delete, contracts, the HR pool move', workflows: ['musaned_add_candidate', 'musaned_cv_import', 'musaned_delete', 'musaned_epro_approve'] },
  { key: 'wafid', title: 'Wafid medical robots', plan: 'standard', about: 'Book the medical, print the slip, check the result', workflows: ['wafid_book', 'wafid_slip', 'wafid_check'] },
  { key: 'whatsapp', title: 'WhatsApp', plan: 'standard', about: 'CVs to agents, a message to all the selected', workflows: [] },
  { key: 'moves', title: 'Moves from other systems', plan: 'standard', about: 'Copy everything from EasyEnjaz, EnjazPlus or Musaned', workflows: [] },
  { key: 'enjaz_visa', title: 'Enjaz visa robot', plan: 'premium', about: 'The visa application and its payment on Enjaz', workflows: ['mofa_visa', 'mofa_find_app', 'mofa_pay'] },
  { key: 'tasheer', title: 'Tasheer robot', plan: 'premium', about: 'Group appointments: the form, then the Excel uploaded by itself', workflows: ['tasheer_schedule'] },
  { key: 'insurance', title: 'Insurance robot', plan: 'premium', about: 'One certificate for many, filled and added by itself', workflows: ['insurance_certificate'] },
  // Reading passports and CVs (AI) is in every plan: every profile is made from it.
  { key: 'cv_header', title: 'CV headers cut by themselves', plan: 'premium', about: 'The agency header cut out of CVs (moves, "Cut from CVs") for its CV templates', workflows: [] },
]
export const featureOf = (key) => FEATURES.find(f => f.key === key) || null
export const featureForWorkflow = (id) => FEATURES.find(f => f.workflows.includes(id)) || null

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = process.env.ADAL_LICENSE_DIR || path.join(HERE, '..', '..', 'data')
// The second copy, outside the install folder (a test only writes where it says).
const SIDE = process.env.ADAL_LICENSE_SIDE || (process.env.NODE_TEST_CONTEXT ? null
  : process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'AdalKeep') : path.join(os.homedir(), '.config', 'adal-keep'))
const DAY = 86400000

/** The licence's signed part (what Adal signs and the PC checks). */
export const signedPart = (l) => ({
  pc: String(l.pc || ''), plan: l.plan || 'premium',
  paid_until: l.paid_until || null, trial_until: l.trial_until || null,
  features: l.features || {}, offers: l.offers || [], note: l.note || '', at: l.at || null,
  // Only when set: a licence that is not suspended is signed exactly as before
  // (PCs on an older version keep accepting it).
  ...(l.suspended ? { suspended: { at: l.suspended.at || null, note: String(l.suspended.note || '').slice(0, 300) } } : {}),
})
/** The licence says this PC is suspended by Adal. */
export const isSuspended = (l = current) => !!l?.suspended
export function verifyLicense(file, pc) {
  if (!file?.license || !file?.signature) return null
  const l = signedPart(file.license)
  if (pc && l.pc !== String(pc)) return null
  return verifyManifest(l, file.signature) ? l : null
}

let current = null // the verified licence in use
let dbRef = null
let currentFile = null   // … as Adal signed it ({license, signature}), for the other PCs of the agency
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const copies = (name) => [path.join(DIR, name), ...(SIDE ? [path.join(SIDE, name)] : [])]
const writeCopies = (name, o) => { for (const p of copies(name)) try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1)) } catch {} }
const when = (l) => Date.parse(l?.at || '') || 0
/** The newest licence Adal signed for this PC, of the copies kept here. */
function loadSaved(pc) {
  for (const p of copies('license.json')) {
    const file = readJSON(p), l = verifyLicense(file, pc)
    if (l && (!current || when(l) > when(current))) { current = l; currentFile = { license: file.license, signature: file.signature } }
  }
  // A copy that was deleted, edited or is older is put right.
  if (currentFile && copies('license.json').some(p => JSON.stringify(readJSON(p)) !== JSON.stringify(currentFile))) writeCopies('license.json', currentFile)
}

/** The licence in use (null: none from Adal yet — the trial, or an old unlock code). */
export async function license() {
  if (current) return current
  const { pcNumber } = await import('./subscription.js')
  loadSaved(pcNumber())
  return current
}
let loadedFor = null
/** The licence in use, at once; with the PC's number: read from this PC's copies the first time (a lock holds from the first moment). */
export function licenseNow(pc) {
  if (pc && loadedFor !== pc) { loadedFor = pc; if (!current) loadSaved(pc) }
  return current
}
export const licenseFile = () => currentFile
/** Tests only: the licence in use, without a signature. */
export function __setLicenseForTest(l) { if (process.env.NODE_TEST_CONTEXT) { current = l; currentFile = null; loadedFor = null } }

// ── The main PC's licence, kept on the agency's other PCs ───────────────────
// {main PC's number: its newest signed file}: only what Adal signed counts, an older one never replaces a newer.
let agencyFiles = null
function agencyKept() {
  if (agencyFiles) return agencyFiles
  agencyFiles = {}
  for (const p of copies('agency-license.json')) for (const f of Object.values(readJSON(p) || {})) keepNewer(f)
  if (Object.keys(agencyFiles).length && copies('agency-license.json').some(p => JSON.stringify(readJSON(p)) !== JSON.stringify(agencyFiles))) writeCopies('agency-license.json', agencyFiles)
  return agencyFiles
}
function keepNewer(file) {
  const l = verifyLicense(file)
  if (!l || !/^\d{6}$/.test(l.pc)) return false
  const had = agencyFiles[l.pc]
  if (had && when(had.license) >= when(l)) return false
  agencyFiles[l.pc] = { license: l, signature: file.signature }
  return true
}
let lastSeenSig = null
/** The main PC's signed licence, as it came through the copying (subscription.js followed()). */
export function keepAgencyLicense(file) {
  if (!file?.signature || file.signature === lastSeenSig) return
  lastSeenSig = file.signature
  agencyKept()
  if (keepNewer(file)) writeCopies('agency-license.json', agencyFiles)
}
/** Adal locked this agency (its main PC's signed licence): {at, note}, or null. */
export function agencyLock() {
  for (const f of Object.values(agencyKept())) if (f.license?.suspended) return f.license.suspended
  return null
}
export function __resetLicenseForTest() { if (process.env.NODE_TEST_CONTEXT) { current = currentFile = loadedFor = agencyFiles = lastSeenSig = null } }

/** The plan: the licence's, else Premium (the trial lets an agency try everything). */
export function planOf(l = current) { return 'premium' }

/** on · off · offered — for one feature, for this agency. */
export function featureState(key, l = current) {
  const f = featureOf(key)
  if (!f) return 'on'
  const own = l?.features?.[key]
  if (own === 'on' || own === 'off') return own
  if (RANK[planOf(l)] >= RANK[f.plan]) return 'on'
  return (l?.offers || []).some(o => o.feature === key) ? 'offered' : 'off'
}
export const hasFeature = (key) => featureState(key) === 'on'

export class PlanError extends Error {
  constructor(f) {
    const p = PLANS.find(x => x.key === f.plan)
    super(`${f.title} is in the ${p?.name || f.plan} plan. Ask Adal Keep to turn it on (Chat → Adal Keep).`)
    this.status = 402; this.feature = f.key; this.plan = f.plan
  }
}
/** Throws when this agency's plan does not have the feature. */
export function needFeature(key) {
  const f = featureOf(key)
  if (f && featureState(key) !== 'on') throw new PlanError(f)
}
/** Express middleware: 402 with a plain sentence when the feature is not on. */
export const requireFeature = (key) => (req, res, next) => {
  try { needFeature(key); next() } catch (e) { res.status(e.status || 402).json({ error: e.message, feature: e.feature, plan: e.plan }) }
}

/** Reads this PC's licence from Adal (signed), keeps it; null when there is none. */
export async function refreshLicense() {
  const { pcNumber } = await import('./subscription.js')
  const pc = pcNumber()
  await license()   // (what is kept here first: an older file from the server never replaces it)
  try {
    const c = await import('./chatCloud.js')
    if (!c.chatConfigured()) return license()
    // Locked with its agency earlier and holding the main role now: that licence is read too (an Unlock opens it).
    for (const other of Object.keys(agencyKept()).filter(n => n !== pc && agencyFiles[n].license?.suspended)) {
      const r = await c.cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/licenses/${other}.json?t=${Date.now()}`, undefined, { raw: true, headers: { 'Cache-Control': 'no-cache' } }).catch(() => null)
      if (r?.ok) { keepAgencyLicense(await r.json().catch(() => null)); (await import('./subscription.js')).licenseChanged() }
    }
    const res = await c.cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/licenses/${pc}.json?t=${Date.now()}`, undefined, { raw: true, headers: { 'Cache-Control': 'no-cache' } })
    if (res.status === 404 || res.status === 400) return license()
    if (!res.ok) return license()
    const file = await res.json()
    const l = verifyLicense(file, pc)
    if (!l) { console.warn('[plans] the licence on the server is not signed by Adal — ignored'); return license() }
    const had = current
    // Never an older licence than the one in use (a copy put back to undo a suspension).
    if (had?.at && l.at && Date.parse(l.at) < Date.parse(had.at)) return had
    current = l; currentFile = { license: file.license, signature: file.signature }
    if (!had || had.at !== l.at) { try { (await import('./subscription.js')).licenseChanged() } catch {} }
    writeCopies('license.json', file)
    if (!had || had.at !== l.at) console.log(`[plans] licence from Adal: ${planOf(l)}${l.paid_until ? `, paid until ${new Date(l.paid_until).toISOString().slice(0, 10)}` : ''}${l.suspended ? ' — SUSPENDED' : ''}`)
    return l
  } catch (e) {
    console.warn('[plans] licence:', e.message)
    return license()
  }
}

/**
 * Adal Keep Admin saved this PC's licence (a nudge from Realtime or keep_calls):
 * read it again now. A nudge during a read gets one more read after it.
 */
let again = false, running = null
export function licenseNudge() {
  again = true
  if (!running) running = (async () => {
    try { while (again) { again = false; await refreshLicense().catch(() => {}) } } finally { running = null }
  })()
  return running
}

export function startLicenseWatch(db) {
  if (db) dbRef = db
  license().catch(() => {})
  setTimeout(() => refreshLicense().catch(() => {}), 20000)
  // The fallback when no nudge arrives (Realtime down): a lock or an unlock reaches a PC that is online within a minute.
  setInterval(() => refreshLicense().catch(() => {}), 45000).unref?.()
}

/** What the pages need: the plan, each feature's state, what is offered. */
export function planPayload(l = current) {
  const plan = planOf(l)
  return {
    plan, plans: PLANS,
    features: FEATURES.map(f => ({ key: f.key, title: f.title, about: f.about, plan: f.plan, workflows: f.workflows, state: featureState(f.key, l) })),
    offers: (l?.offers || []).map(o => ({ ...o, feature_title: featureOf(o.feature)?.title || o.title || o.feature })),
    from_adal: !!l, note: l?.note || '',
    paid_until: l?.paid_until || null, trial_until: l?.trial_until || null,
    suspended: !!l?.suspended,
  }
}

export { canonical, DAY }
