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

/** { files: [field names with no file], texts: [{ key, label, type, options?, hint? }] } — both empty: nothing missing. */
export function missingNow(profile, fields = [], stepKey) {
  const steps = AHEAD[stepKey] || AHEAD.cv
  const files = [], texts = []
  for (const s of steps) {
    for (const n of NEEDS[s].files) {
      const f = (fields || []).find(x => x.name === n)
      if (f && !hasFiles(f) && !files.includes(n)) files.push(n)
    }
    for (const k of NEEDS[s].texts) {
      if (profile && isBad(k, profile[k], profile) && !texts.some(t => t.key === k)) texts.push({ key: k, ...TEXT[k] })
    }
  }
  return { files, texts }
}
