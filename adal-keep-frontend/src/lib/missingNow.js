// What her current and next step still lack, so the profile page can ask for it
// right at the top (the "Missing" card). Pure: the page (PC, Companion, phone)
// feeds it her profile, her documents and her step key (backend stepNow).
//
//   cv        Photo + Full Body Photo + living town (her place of birth when empty) + passport Date of Issue
//   musaned   Photo, marital status, religion, a mobile (9 + 8 digits)  — musanedPreflight.js
//   wafid     passport Date of Issue + Expiry, date of birth             — wafidWorkflow.js
//   lmis      passport Date of Issue, date of birth, passport number     — lmisWorkflow.js
import { hasFiles } from './photosFirst.js'

const TEXT = {
  living_town:         { label: 'Living town', type: 'text' },
  place_of_birth:      { label: 'Place of birth', type: 'text', hint: 'as printed on the passport' },
  passport_issue_date: { label: 'Passport Date of Issue', type: 'date' },
  passport_expiry_date: { label: 'Passport Date of Expiry', type: 'date' },
  date_of_birth:       { label: 'Date of birth', type: 'date' },
  passport_number:     { label: 'Passport number', type: 'text' },
  marital_status:      { label: 'Marital status', type: 'select', options: ['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED'] },
  religion:            { label: 'Religion', type: 'select', options: ['Muslim', 'Christian'] },
  phone_number:        { label: 'Mobile number', type: 'text', hint: '09… (9 followed by 8 digits)' },
}

const NEEDS = {
  cv:      { files: ['Photo', 'Full Body Photo'], texts: ['living_town', 'passport_issue_date'] },
  musaned: { files: ['Photo'], texts: ['marital_status', 'religion', 'phone_number'] },
  wafid:   { files: [], texts: ['passport_issue_date', 'passport_expiry_date', 'date_of_birth'] },
  lmis:    { files: [], texts: ['passport_number', 'passport_issue_date', 'date_of_birth'] },
}
// Her step, and the one after it.
const AHEAD = {
  cv: ['cv', 'musaned'],
  musaned: ['musaned'],
  waiting: ['musaned', 'wafid'],
  selected: ['wafid'],
  wafid: ['wafid', 'lmis'],
  lmis: ['lmis'],
  epro: [],
}

const blank = (v) => v == null || String(v).trim() === ''
const mobileOk = (v) => /^9\d{8}$/.test((() => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('251') && d.length > 9) d = d.slice(3); if (d.length === 10 && d.startsWith('0')) d = d.slice(1); return d })())
const isBad = (k, v, p = {}) => (k === 'phone_number' ? !mobileOk(v)
  : k === 'living_town' ? blank(v) && blank(p.place_of_birth)   // her place of birth stands in
  : blank(v))

// ------------------------------------------------------------------ cleared
// "Whenever I delete a field, make it appear at the top as a required field" (asked on
// 2026-11-24): a detail or a document of hers that had a value and now has none (cleared on
// the profile, in a pop-up, in the form, on another PC) is shown in the Missing list at once,
// until it is filled again. Kept per profile in this browser.
export const CLEARABLE = {
  full_name: 'Full name', phone_number: 'Mobile number', national_id: 'National ID', passport_number: 'Passport number',
  date_of_birth: 'Date of birth', passport_issue_date: 'Passport Date of Issue', passport_expiry_date: 'Passport Date of Expiry',
  place_of_birth: 'Place of birth', living_town: 'Living town', region: 'Region', zone_subcity: 'Zone / Sub-city',
  marital_status: 'Marital status', religion: 'Religion', gender: 'Gender', nationality: 'Nationality', children_count: 'Children',
  height: 'Height', weight: 'Weight', education_level: 'Education', cooking_skill: 'Cooking skill',
  speaks_arabic: 'Speaks Arabic', speaks_english: 'Speaks English', emergency_phone: 'Emergency phone',
  emergency_relationship: 'Emergency relationship', destination_country: 'Destination Country', personal_number: 'Personal number',
  labor_id: 'Labour ID',
}
const DATES = new Set(['date_of_birth', 'passport_issue_date', 'passport_expiry_date'])
const KEY = (id) => `adal-cleared:${id}`
const read = (id) => { try { const v = JSON.parse(localStorage.getItem(KEY(id)) || 'null'); return { texts: v?.texts || [], files: v?.files || [] } } catch { return { texts: [], files: [] } } }
const write = (id, v) => { try { (v.texts.length || v.files.length) ? localStorage.setItem(KEY(id), JSON.stringify(v)) : localStorage.removeItem(KEY(id)) } catch {} }
const fileCount = (fields, name) => ((fields || []).find(f => f.name === name)?.files || []).length

/** Her details or documents that went from a value to none between two looks: kept as "cleared". */
export function noteCleared(profileId, before, after) {
  if (!profileId || !before || !after) return
  const c = read(profileId)
  let changed = false
  if (before.profile && after.profile && String(before.profile.id) === String(after.profile.id)) {
    for (const k of Object.keys(CLEARABLE)) {
      if (!blank(before.profile[k]) && k in after.profile && blank(after.profile[k]) && !c.texts.includes(k)) { c.texts.push(k); changed = true }
    }
  }
  if (Array.isArray(before.fields) && Array.isArray(after.fields)) {
    for (const f of before.fields) {
      if (fileCount(before.fields, f.name) > 0 && after.fields.some(x => x.name === f.name) && fileCount(after.fields, f.name) === 0 && !c.files.includes(f.name)) { c.files.push(f.name); changed = true }
    }
  }
  if (changed) write(profileId, c)
}

/** The cleared ones still empty (the filled ones are forgotten). */
export function clearedOf(profileId, profile, fields) {
  if (!profileId) return { texts: [], files: [] }
  const c = read(profileId)
  const now = {
    texts: c.texts.filter(k => !profile || blank(profile[k])),
    files: c.files.filter(n => !fields || fields.some(f => f.name === n) && fileCount(fields, n) === 0),
  }
  if (now.texts.length !== c.texts.length || now.files.length !== c.files.length) write(profileId, now)
  return now
}

/**
 * { files: [field names with no file], texts: [{ key, label, type, options?, hint? }] } — both empty: nothing missing.
 * With `profileId`: also what was cleared on her and is still empty (above), first.
 */
export function missingNow(profile, fields = [], stepKey, profileId = null) {
  const steps = AHEAD[stepKey] || AHEAD.cv
  const files = [], texts = []
  for (const s of steps) {
    for (const n of NEEDS[s].files) {
      const f = (fields || []).find(x => x.name === n)
      if (f && !hasFiles(f) && !files.includes(n)) files.push(n)
    }
    for (const k of NEEDS[s].texts) {
      // No living town and no place of birth: the place is what is asked (the town follows it on save).
      const key = k === 'living_town' ? 'place_of_birth' : k
      if (profile && isBad(k, profile[k], profile) && !texts.some(t => t.key === key)) texts.push({ key, ...TEXT[key] })
    }
  }
  if (profileId) {
    const c = clearedOf(profileId, profile, fields)
    for (const n of [...c.files].reverse()) if (!files.includes(n)) files.unshift(n)
    for (const k of [...c.texts].reverse()) if (!texts.some(t => t.key === k)) texts.unshift({ key: k, ...(TEXT[k] || { label: CLEARABLE[k] || k, type: DATES.has(k) ? 'date' : 'text' }), cleared: true })
  }
  return { files, texts }
}
