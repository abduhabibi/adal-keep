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
 * The PC reads it when it starts and every 30 minutes, checks the signature,
 * and keeps the last good one (data/license.json), so it works offline too.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { canonical, verifyManifest, BUCKET } from './updateChannel.js'

export const PLANS = [
  { key: 'basic', name: 'Basic', price: 29999, training_days: 7, rank: 1 },
  { key: 'standard', name: 'Standard', price: 39999, training_days: 7, rank: 2 },
  { key: 'premium', name: 'Premium', price: 49999, training_days: 14, rank: 3, extras: ['New features first', 'Support first', 'One more week of training'] },
]
const RANK = Object.fromEntries(PLANS.map(p => [p.key, p.rank]))

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
  { key: 'insurance', title: 'Insurance robot', plan: 'premium', about: 'One certificate for many, filled and added by itself', workflows: ['insurance_certificate'] },
  // Reading passports and CVs (AI) is in every plan: every profile is made from it.
  { key: 'cv_header', title: 'CV headers cut by themselves', plan: 'premium', about: 'The agency header cut out of CVs (moves, "Cut from CVs") for its CV templates', workflows: [] },
]
export const featureOf = (key) => FEATURES.find(f => f.key === key) || null
export const featureForWorkflow = (id) => FEATURES.find(f => f.workflows.includes(id)) || null

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAVED = path.join(HERE, '..', '..', 'data', 'license.json')
const DAY = 86400000

/** The licence's signed part (what Adal signs and the PC checks). */
export const signedPart = (l) => ({
  pc: String(l.pc || ''), plan: l.plan || 'premium',
  paid_until: l.paid_until || null, trial_until: l.trial_until || null,
  features: l.features || {}, offers: l.offers || [], note: l.note || '', at: l.at || null,
})
export function verifyLicense(file, pc) {
  if (!file?.license || !file?.signature) return null
  const l = signedPart(file.license)
  if (pc && l.pc !== String(pc)) return null
  return verifyManifest(l, file.signature) ? l : null
}

let current = null // the verified licence in use
let dbRef = null
function readSaved(pc) { try { return verifyLicense(JSON.parse(fs.readFileSync(SAVED, 'utf8')), pc) } catch { return null } }

/** The licence in use (null: none from Adal yet — the trial, or an old unlock code). */
export async function license() {
  if (current) return current
  const { pcNumber } = await import('./subscription.js')
  current = readSaved(pcNumber())
  return current
}
export const licenseNow = () => current

/** The plan: the licence's, else Premium (the trial lets an agency try everything). */
export function planOf(l = current) { return l?.plan && RANK[l.plan] ? l.plan : 'premium' }

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
  try {
    const c = await import('./chatCloud.js')
    if (!c.chatConfigured()) return license()
    const res = await c.cloudCall(dbRef, 'GET', `/storage/v1/object/authenticated/${BUCKET}/licenses/${pc}.json?t=${Date.now()}`, undefined, { raw: true, headers: { 'Cache-Control': 'no-cache' } })
    if (res.status === 404 || res.status === 400) return license()
    if (!res.ok) return license()
    const file = await res.json()
    const l = verifyLicense(file, pc)
    if (!l) { console.warn('[plans] the licence on the server is not signed by Adal — ignored'); return license() }
    const had = current
    current = l
    try { fs.mkdirSync(path.dirname(SAVED), { recursive: true }); fs.writeFileSync(SAVED, JSON.stringify(file, null, 1)) } catch {}
    if (!had || had.at !== l.at) console.log(`[plans] licence from Adal: ${planOf(l)}${l.paid_until ? `, paid until ${new Date(l.paid_until).toISOString().slice(0, 10)}` : ''}`)
    return l
  } catch (e) {
    console.warn('[plans] licence:', e.message)
    return license()
  }
}

export function startLicenseWatch(db) {
  if (db) dbRef = db
  license().catch(() => {})
  setTimeout(() => refreshLicense().catch(() => {}), 20000)
  setInterval(() => refreshLicense().catch(() => {}), 30 * 60000).unref?.()
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
  }
}

export { canonical, DAY }
