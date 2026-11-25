/**
 * Is her CV complete — every detail and document it needs there? Then the CV
 * step is done at once (no PDF, no download, no tick; the PDF is made when
 * somebody previews, saves, downloads or sends it) and Musaned, which needs
 * nothing more than the CV, checks nothing again.
 *
 * Only from her own rows (the same on every PC once copied), never from what
 * is on this PC's disk: so no two PCs say different things. The Musaned robot
 * still looks for its photo itself and never guesses a value.
 * Off: ADAL_CV_READY=0 (a CV is done when it was made, as before).
 */
import { mobileOk, isPassportCrop } from './musanedPreflight.js'

export const cvReadyOn = () => process.env.ADAL_CV_READY !== '0'

// What a CV shows of her (the CV page's list).
export const CV_DETAILS = ['full_name', 'first_name', 'last_name', 'passport_number', 'date_of_birth', 'place_of_birth', 'nationality', 'gender', 'children_count', 'weight', 'height']
// The columns the rule reads (the lists that look at every girl select just these).
export const CV_COLUMNS = [...CV_DETAILS, 'living_town', 'broker_id', 'religion', 'marital_status', 'phone_number']
/** Her Photo is only the face cut from her passport: a document name of its own here (docsFor). */
export const CROP_ONLY = 'Photo (passport crop)'

const blank = (v) => v == null || String(v).trim() === ''

/** What her CV (and Musaned after it) still lacks, as words the pop-ups know; [] = complete. docs: the names of her documents. */
export function cvLacks(p = {}, docs = new Set()) {
  const out = []
  if (!p.broker_id) out.push('Broker not assigned')
  if (!docs.has('Photo')) out.push(docs.has(CROP_ONLY) ? 'personal photo (only the face cut from the passport is on file — upload a real photo)' : 'Photo missing')
  if (!docs.has('Full Body Photo')) out.push('Full body photo missing')
  if (!docs.has('Passport')) out.push('Passport missing')
  if (blank(p.religion)) out.push('Religion missing')
  if (blank(p.marital_status)) out.push('Marital status missing')
  if (!mobileOk(p.phone_number)) out.push('mobile number (9 followed by 8 digits)')
  for (const k of CV_DETAILS) if (blank(p[k]) && !(k === 'place_of_birth' && !blank(p.living_town))) out.push(k)
  return out
}

/** Map(profile id → her documents' names); a Photo that is only the passport's face counts as CROP_ONLY. ids null: everybody. */
export async function docsFor(db, ids = null) {
  const rows = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .modify(q => { if (ids) q.whereIn('profile_fields.profile_id', ids) })
    .whereIn('profile_fields.name', ['Photo', 'Full Body Photo', 'Passport'])
    .select('profile_fields.profile_id as id', 'profile_fields.name', 'files.path', 'files.mimetype')
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r.id)) m.set(r.id, new Set())
    if (r.name === 'Photo' && r.mimetype && !/^image\//.test(r.mimetype)) continue
    m.get(r.id).add(r.name === 'Photo' && isPassportCrop(r.path) ? CROP_ONLY : r.name)
  }
  return m
}

/** One girl: what is lacking (null: the rule is off here). Never throws: an error is "not known", checked as before. */
export async function lacksOf(db, id, profile = null) {
  if (!cvReadyOn()) return null
  try {
    const p = profile || await db('profiles').where('id', Number(id)).first()
    return p ? cvLacks(p, (await docsFor(db, [p.id])).get(p.id)) : null
  } catch (e) { console.warn('[cv-complete]', e.message); return null }
}
export const isComplete = async (db, id, profile = null) => (await lacksOf(db, id, profile))?.length === 0

/** Everybody whose CV is complete: Set(id). Empty when off or on an error. */
export async function completeIds(db, profiles) {
  if (!cvReadyOn()) return new Set()
  try {
    const docs = await docsFor(db)
    return new Set(profiles.filter(p => !cvLacks(p, docs.get(p.id)).length).map(p => p.id))
  } catch (e) { console.warn('[cv-complete]', e.message); return new Set() }
}
